// Every model call sends the same context size.
//
// This is the whole test, and it exists because of a measured 2x regression.
//
// Ollama keeps one loaded instance per context size. A side call — an
// auto-title, a summary, a compaction — that omits `num_ctx` does not get "a
// small default": it gets the *model's* default, which on a modern model is
// enormous. Measured here with gemma4:31b on a 16GB card, where the default is
// 262,144 and its KV cache alone is 16GB:
//
//     chat turn, num_ctx 8192     68% on GPU   7.9 tok/s
//     one call with NO num_ctx    34% on GPU   4.6 tok/s   (17.7s reload)
//     the next chat turn          68% on GPU   9.8 tok/s   (15.4s reload)
//
// So one forgetful call costs two full model reloads and leaves the model
// half off the card in between. Setting a *smaller* num_ctx is just as bad:
// any different value is a different instance. Same number, everywhere, or
// the model thrashes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

/**
 * Every `fetch('/api/chat')` in the app, with the body that follows it.
 *
 * Crude on purpose: a brace-matcher would be a parser, and what this needs to
 * catch is a call site somebody adds without thinking about context size —
 * which is visible in the next thirty lines of any of them.
 */
const callSites = (file) => {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    if (!/fetch\('\/api\/(chat|generate)'/.test(line)) return;
    out.push({
      file,
      line: i + 1,
      body: lines.slice(i, i + 30).join('\n'),
    });
  });
  return out;
};

const FILES = ['src/App.jsx', 'src/memory.js', 'src/ModelCompare.jsx'];
const sites = FILES.flatMap(callSites);

check('there are model calls to check', sites.length >= 8, `${sites.length} found`);

for (const site of sites) {
  const named = `${site.file}:${site.line}`;

  /* An unload is not a generation: `keep_alive: 0` with no messages tells
     Ollama to evict the model, and there is no context to size. */
  if (/keep_alive: 0/.test(site.body) && !/messages/.test(site.body)) {
    check(`${named} is an unload, and needs no context size`, true);
    continue;
  }

  /* The legitimate shapes. Either the conversation's own options, the helper
     that carries num_ctx for every side call, an explicit num_ctx, or an
     options object handed down from a caller that already built one. */
  const viaBuild = /options: buildOptions\(\)/.test(site.body);
  const viaHelper = /options: helperOptions\(/.test(site.body);
  const explicit = /num_ctx/.test(site.body);
  const handedDown = /\.\.\.\(options \|\| \{\}\)/.test(site.body)
    || /\.\.\.options/.test(site.body)
    || /messages, options \}/.test(site.body);
  // A body with no `options` key at all is a call that takes every default,
  // which is the failure this whole file is about.
  const hasOptions = /options/.test(site.body);

  check(`${named} pins the context size`,
    viaBuild || viaHelper || explicit || handedDown,
    hasOptions ? site.body.split('\n').find(l => /options/.test(l))?.trim() : 'no options at all');
}

/* --------------------------------------------------- the helper itself */

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');

check('there is one helper for side calls', /const helperOptions = /.test(app));
check('and it carries num_ctx', /const helperOptions = \([^)]*\) => \(\{\s*\.\.\.\(numCtx/.test(app));
// The comment is the only place the measurement lives, and the measurement is
// the reason anybody would keep the rule.
check('with the measurement that explains why', /68% on GPU/.test(app));

// Both the conversation and the side calls have to agree, so they read the
// same variable rather than each having their own idea of a sensible size.
check('the conversation and the side calls use the same number',
  /num_ctx: numCtx,/.test(app) && /\.\.\.\(numCtx \? \{ num_ctx: numCtx \} : \{\}\)/.test(app));

/* ------------------------------------------- and the embedder, which is one */

// An embedding model is a second model: loading one takes VRAM the chat model
// was using, and on a card that was already full that is layers moving to the
// CPU. Not a num_ctx problem, but the same family of problem, and the reason
// the memory feature has to survive there being no embedder at all.
const convmem = fs.readFileSync(path.join(ROOT, 'src/convMemory.js'), 'utf8');
check('recall works without an embedding model at all', /keywordRank/.test(convmem));
check('and says which path it took', /'keyword'/.test(convmem) && /'embedding'/.test(convmem));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
