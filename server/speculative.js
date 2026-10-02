// Speculative decoding for llama.cpp, set up from the app.
//
// A small model of the same family guesses the next few tokens and the big
// model checks them all in one pass. When the guesses are right -- and for a
// 0.6B drafting for a 32B of the same family they are right most of the time
// -- several tokens come out for the price of one. On a card where the big
// model is memory-bound, that is typically 1.5-2.5x the speed.
//
// llama-server in router mode loads each model with the arguments in its
// preset file (`--models-preset`), so a draft is a per-model line there:
//
//     [Qwen3-32B-Q4_K_M]
//     model-draft = D:\models\Qwen3-0.6B-Q8_0.gguf
//     spec-draft-n-max = 16
//
// This module reads and edits that file without disturbing anything else in
// it, suggests drafts from the models on disk, and says what each loaded model
// is actually running with (from `status.args`, the argv llama-server reports).
//
// "ngram" is the other option worth offering: no second model at all, it
// drafts by looking the recent tokens up in what has already been said. Free,
// and good at exactly the answers that repeat -- code edits, summaries that
// quote -- and useless elsewhere.

import fs from 'node:fs';
import path from 'node:path';

/** The keys this module owns in a model's section. Everything else is kept. */
export const SPEC_KEYS = ['model-draft', 'spec-type', 'spec-draft-n-max', 'spec-draft-ngl'];

// ---------------------------------------------------------------- the file

const SECTION = /^\s*\[([^\]]+)\]\s*$/;
const ENTRY = /^\s*([^=;#\s][^=]*?)\s*=\s*(.*?)\s*$/;

/** `{ [section]: { key: value } }`, with `''` for lines before any section. */
export const parseIni = (text = '') => {
  const out = { '': {} };
  let current = '';
  for (const line of String(text).split(/\r?\n/)) {
    const s = SECTION.exec(line);
    if (s) { current = s[1].trim(); out[current] = out[current] || {}; continue; }
    const e = ENTRY.exec(line);
    if (e && !/^\s*[;#]/.test(line)) out[current][e[1]] = e[2];
  }
  return out;
};

/**
 * Set (or with `undefined`, remove) keys in one section, editing lines in
 * place so comments, order and every other section survive untouched. A
 * section that does not exist is appended.
 */
export const setSectionKeys = (text = '', section, values) => {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text ? String(text).split(/\r?\n/) : [];
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const s = SECTION.exec(lines[i]);
    if (!s) continue;
    if (start >= 0) { end = i; break; }
    if (s[1].trim() === section) start = i;
  }

  const empty = (v) => v === undefined || v === null || v === '';
  const pending = new Map(Object.entries(values));
  const written = new Set();
  if (start >= 0) {
    // From the bottom: llama.cpp takes the last of a repeated key, so that is
    // the line edited, and any earlier copy of it is removed.
    for (let i = end - 1; i > start; i--) {
      const e = ENTRY.exec(lines[i]);
      if (!e || /^\s*[;#]/.test(lines[i]) || !pending.has(e[1])) continue;
      const v = pending.get(e[1]);
      if (empty(v) || written.has(e[1])) { lines.splice(i, 1); end--; continue; }
      lines[i] = `${e[1]} = ${v}`;
      written.add(e[1]);
    }
    const add = [...pending].filter(([k, v]) => !empty(v) && !written.has(k))
      .map(([k, v]) => `${k} = ${v}`);
    // After the section's last non-blank line.
    let at = end;
    while (at - 1 > start && lines[at - 1].trim() === '') at--;
    lines.splice(at, 0, ...add);
  } else {
    const add = [...pending].filter(([, v]) => !empty(v)).map(([k, v]) => `${k} = ${v}`);
    if (!add.length) return text;
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    if (!lines.length) lines.push('version = 1', '');
    lines.push(`[${section}]`, ...add, '');
  }
  return lines.join(eol);
};

/** What a section says about speculation, in the app's words. */
export const specOf = (entries = {}) => {
  const type = entries['spec-type'] || '';
  const draft = entries['model-draft'] || '';
  const mode = draft ? 'draft' : /ngram/.test(type) ? 'ngram' : 'off';
  return {
    mode,
    draft,
    nMax: Number(entries['spec-draft-n-max']) || null,
    ngl: entries['spec-draft-ngl'] || null,
  };
};

/** The keys to write for a choice made in the app. */
export const keysFor = ({ mode = 'off', draft = '', nMax = null, ngl = null } = {}) => {
  if (mode === 'draft' && draft) {
    return {
      'model-draft': draft,
      'spec-type': undefined,
      'spec-draft-n-max': nMax ? String(Math.max(1, Math.min(64, Math.round(nMax)))) : undefined,
      // All of the draft on the GPU unless told otherwise: a draft on the CPU
      // is slower than no draft.
      'spec-draft-ngl': ngl || 'all',
    };
  }
  if (mode === 'ngram') {
    return { 'model-draft': undefined, 'spec-type': 'ngram-simple', 'spec-draft-n-max': undefined, 'spec-draft-ngl': undefined };
  }
  return Object.fromEntries(SPEC_KEYS.map(k => [k, undefined]));
};

// ------------------------------------------------------------ the models

/** Parameter count in billions, read from a model's name. */
export const paramsOf = (name = '') => {
  const m = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*([bm])(?![a-z])/i.exec(String(name));
  if (!m) return null;
  return m[2].toLowerCase() === 'm' ? Number(m[1]) / 1000 : Number(m[1]);
};

/**
 * The family a model belongs to, for "which drafts share its vocabulary".
 * `Qwen3-32B-Q4_K_M` and `qwen3-0.6b-q8_0` are both `qwen3`; `Qwen2.5-Coder-7B`
 * is `qwen2.5-coder`. A draft from another family is not slower but useless:
 * the two models do not share a tokenizer, and llama.cpp refuses it.
 */
export const familyOf = (name = '') => {
  const base = String(name).split(/[\\/]/).pop().replace(/\.gguf$/i, '').toLowerCase();
  const cut = base.search(/[-_ .]?\d+(?:\.\d+)?[bm](?![a-z])/i);
  const head = cut > 0 ? base.slice(0, cut) : base;
  return head.replace(/[-_ .]+(instruct|chat|it|base)$/i, '').replace(/[-_ ]+$/, '');
};

/** For a target model, smaller models of the same family, smallest first. */
export const suggestDrafts = (target, models = []) => {
  const family = familyOf(target);
  const size = paramsOf(target);
  if (!family || !size) return [];
  return models
    .filter(m => m !== target && familyOf(m) === family)
    .map(m => ({ name: m, params: paramsOf(m) }))
    .filter(m => m.params && m.params <= size / 4)
    .sort((a, b) => a.params - b.params)
    .map(m => m.name);
};

/** A value from an argv list: the one after any of `flags`. */
const argAfter = (args = [], flags) => {
  for (let i = 0; i < args.length - 1; i++) if (flags.includes(String(args[i]))) return String(args[i + 1]);
  return null;
};

/** Where the model file is, from what llama-server reports about it. */
export const modelPathOf = (entry, modelsDir = '') =>
  argAfter(entry?.status?.args, ['-m', '--model'])
  || entry?.path
  || (modelsDir ? path.join(modelsDir, `${entry?.id}.gguf`) : null);

/** What a loaded (or configured) model is actually running with. */
export const activeSpecOf = (entry) => {
  const args = entry?.status?.args || [];
  const draft = argAfter(args, ['-md', '--model-draft', '--spec-draft-model']);
  const type = argAfter(args, ['--spec-type']);
  return { draft: draft || null, type: type || null };
};

// ------------------------------------------------------------- the routes

/**
 * GET  /api/llamacpp/speculative   the preset's spec settings, the models, and
 *                                   suggested drafts
 * POST /api/llamacpp/speculative   { model, mode, draft, nMax } -> write it
 *
 * Writing needs LLAMACPP_PRESET (the file llama-server was started with) and
 * the local-files permission, because it is a write to this machine's disk.
 * Without them the screen still works: it shows the lines to paste.
 */
export const createSpeculativeRoutes = ({ env = {}, listModels, allowLocalFs = false, guard = null }) => {
  const presetPath = env.LLAMACPP_PRESET ? path.resolve(env.LLAMACPP_PRESET) : null;
  const modelsDir = env.LLAMACPP_MODELS_DIR || '';

  const readPreset = () => {
    if (!presetPath) return '';
    try { return fs.readFileSync(presetPath, 'utf8'); } catch (e) { return ''; }
  };

  const state = async () => {
    let list = [];
    try { list = await listModels(); } catch (e) { /* llama-server down: still show the file */ }
    const ids = list.map(m => m.id);
    const ini = parseIni(readPreset());
    return {
      preset: presetPath,
      writable: !!presetPath && allowLocalFs,
      models: list.map(entry => ({
        id: entry.id,
        path: modelPathOf(entry, modelsDir),
        params: paramsOf(entry.id),
        loaded: entry?.status?.value === 'loaded',
        active: activeSpecOf(entry),
        configured: specOf(ini[entry.id]),
        suggestions: suggestDrafts(entry.id, ids),
      })),
    };
  };

  return [{
    path: '/api/llamacpp/speculative',
    handler: async (req, res) => {
      const send = (body, status = 200) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(body));
      };
      try {
        if (guard && !(await guard(req, res))) return;
        if (req.method === 'GET') return send({ success: true, ...(await state()) });
        if (req.method !== 'POST') return send({ success: false, error: 'GET or POST.' }, 405);

        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 64 * 1024) throw new Error('Too large.'); }
        const body = JSON.parse(raw || '{}');
        if (!body.model || typeof body.model !== 'string' || /[\]\r\n]/.test(body.model)) {
          return send({ success: false, error: 'Which model?' }, 400);
        }

        // A draft chosen by name is written as its file path: that is what
        // llama-server needs, and a name means nothing to it in a preset.
        let draft = String(body.draft || '');
        if (body.mode === 'draft' && draft && !/[\\/]/.test(draft)) {
          const list = await listModels().catch(() => []);
          const entry = list.find(m => m.id === draft);
          draft = (entry && modelPathOf(entry, modelsDir)) || draft;
        }
        if (/[\r\n]/.test(draft)) return send({ success: false, error: 'Bad path.' }, 400);

        const keys = keysFor({ ...body, draft });
        const text = setSectionKeys(readPreset(), body.model, keys);
        if (!presetPath || !allowLocalFs) {
          return send({ success: true, written: false, section: body.model, keys, ini: text });
        }
        fs.mkdirSync(path.dirname(presetPath), { recursive: true });
        const tmp = `${presetPath}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, presetPath);
        send({ success: true, written: true, ini: text, ...(await state()) });
      } catch (e) {
        send({ success: false, error: e.message }, 400);
      }
    },
  }];
};
