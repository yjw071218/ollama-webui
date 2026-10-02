import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  parseIni, setSectionKeys, specOf, keysFor, paramsOf, familyOf, suggestDrafts,
  modelPathOf, activeSpecOf, createSpeculativeRoutes,
} from '../server/speculative.js';
import { toDoneFrame } from '../server/llamacpp.js';
import { turnMetrics } from '../src/turnMetrics.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const preset = `version = 1

; shared
[*]
c = 8192
flash-attn = on

[Qwen3-32B-Q4_K_M]
; my notes
c = 16384
spec-draft-n-max = 4
spec-draft-n-max = 8

[gemma-3-27b-it-Q4_K_M]
n-gpu-layers = 99
`;

const ini = parseIni(preset);
check('sections and keys are read', ini['*'].c === '8192' && ini['Qwen3-32B-Q4_K_M'].c === '16384');
check('the last of a repeated key wins', ini['Qwen3-32B-Q4_K_M']['spec-draft-n-max'] === '8');
check('comments are not keys', !Object.keys(ini['Qwen3-32B-Q4_K_M']).some(k => k.startsWith(';')));

let next = setSectionKeys(preset, 'Qwen3-32B-Q4_K_M',
  keysFor({ mode: 'draft', draft: 'D:\\models\\Qwen3-0.6B-Q8_0.gguf', nMax: 16 }));
let p = parseIni(next);
check('a draft is written into the model section',
  p['Qwen3-32B-Q4_K_M']['model-draft'] === 'D:\\models\\Qwen3-0.6B-Q8_0.gguf'
  && p['Qwen3-32B-Q4_K_M']['spec-draft-n-max'] === '16' && p['Qwen3-32B-Q4_K_M']['spec-draft-ngl'] === 'all');
check('the duplicate key is collapsed to one', (next.match(/spec-draft-n-max/g) || []).length === 1);
check('comments and other sections survive',
  next.includes('; my notes') && next.includes('; shared') && p['gemma-3-27b-it-Q4_K_M']['n-gpu-layers'] === '99'
  && p['*']['flash-attn'] === 'on' && p['Qwen3-32B-Q4_K_M'].c === '16384');
check('the new keys land inside their own section, before the next one',
  next.indexOf('model-draft') < next.indexOf('[gemma-3-27b-it-Q4_K_M]'));
check('specOf reads it back', specOf(p['Qwen3-32B-Q4_K_M']).mode === 'draft');

next = setSectionKeys(next, 'Qwen3-32B-Q4_K_M', keysFor({ mode: 'ngram' }));
p = parseIni(next);
check('switching to n-gram removes the draft', !p['Qwen3-32B-Q4_K_M']['model-draft']
  && p['Qwen3-32B-Q4_K_M']['spec-type'] === 'ngram-simple' && specOf(p['Qwen3-32B-Q4_K_M']).mode === 'ngram');

next = setSectionKeys(next, 'Qwen3-32B-Q4_K_M', keysFor({ mode: 'off' }));
p = parseIni(next);
check('off removes every speculation key and nothing else',
  specOf(p['Qwen3-32B-Q4_K_M']).mode === 'off' && p['Qwen3-32B-Q4_K_M'].c === '16384');

next = setSectionKeys(preset, 'new-model', keysFor({ mode: 'ngram' }));
check('a model without a section gets one appended', parseIni(next)['new-model']['spec-type'] === 'ngram-simple');
check('an empty file gets a version line', setSectionKeys('', 'm', keysFor({ mode: 'ngram' })).startsWith('version = 1'));
check('CRLF files stay CRLF', setSectionKeys(preset.replace(/\n/g, '\r\n'), 'x', { a: '1' }).includes('\r\n[x]\r\n'));

check('parameter counts are read from names',
  paramsOf('Qwen3-32B-Q4_K_M') === 32 && paramsOf('qwen3-0.6b-q8_0') === 0.6
  && paramsOf('SmolLM2-360M-Instruct') === 0.36 && paramsOf('gemma-3-27b-it') === 27);
check('families match across case and quant',
  familyOf('Qwen3-32B-Q4_K_M') === familyOf('qwen3-0.6b-q8_0')
  && familyOf('Qwen2.5-Coder-7B-Instruct') === 'qwen2.5-coder'
  && familyOf('Qwen3-32B') !== familyOf('Qwen2.5-0.5B'));
const models = ['Qwen3-32B-Q4_K_M', 'Qwen3-0.6B-Q8_0', 'Qwen3-1.7B-Q8_0', 'Qwen3-14B-Q4_K_M', 'gemma-3-27b-it-Q4_K_M', 'gemma-3-1b-it-Q8_0', 'Qwen2.5-0.5B-Q8_0'];
const s = suggestDrafts('Qwen3-32B-Q4_K_M', models);
check('drafts are same-family, much smaller, smallest first',
  JSON.stringify(s) === JSON.stringify(['Qwen3-0.6B-Q8_0', 'Qwen3-1.7B-Q8_0']), JSON.stringify(s));
check('gemma gets its own family', JSON.stringify(suggestDrafts('gemma-3-27b-it-Q4_K_M', models)) === '["gemma-3-1b-it-Q8_0"]');

const entry = { id: 'Qwen3-32B', status: { value: 'loaded', args: ['llama-server', '-m', 'D:\\m\\q.gguf', '--model-draft', 'D:\\m\\d.gguf', '-c', '8192'] } };
check('the model path comes from its argv', modelPathOf(entry) === 'D:\\m\\q.gguf');
check('the active draft comes from its argv', activeSpecOf(entry).draft === 'D:\\m\\d.gguf');

// Draft statistics reach the footer.
const frame = toDoneFrame('m', { timings: { predicted_n: 100, predicted_ms: 1000, prompt_n: 5, prompt_ms: 10, draft_n: 80, draft_n_accepted: 60 } });
check('the done frame carries draft counts', frame.draft_n === 80 && frame.draft_n_accepted === 60);
check('and does not invent them', toDoneFrame('m', { timings: { predicted_n: 1 } }).draft_n === undefined);
const turn = turnMetrics([
  { metrics: { totalTime: '1', tokensPerSec: '10', evalCount: 10, draftN: 20, draftAccepted: 10 } },
  { metrics: { totalTime: '1', tokensPerSec: '10', evalCount: 10, draftN: 20, draftAccepted: 15 } },
]);
check('a turn adds up its legs\' drafts', turn.draftN === 40 && turn.draftAccepted === 25);

// The route: reads, then writes only when allowed.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-'));
const file = path.join(dir, 'presets.ini');
fs.writeFileSync(file, preset);
const list = async () => models.map(id => ({ id, status: { args: ['-m', `D:\\models\\${id}.gguf`] } }));
const call = async (routes, method, body) => {
  const req = Readable.from(body ? [JSON.stringify(body)] : []);
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  let out = '';
  const res = { statusCode: 200, setHeader() {}, end(s) { out = s; } };
  await routes[0].handler(req, res);
  return { status: res.statusCode, body: JSON.parse(out) };
};
try {
  const ro = createSpeculativeRoutes({ env: { LLAMACPP_PRESET: file }, listModels: list, allowLocalFs: false });
  const got = await call(ro, 'GET');
  const q = got.body.models.find(m => m.id === 'Qwen3-32B-Q4_K_M');
  check('GET lists models with suggestions and what the preset says',
    got.body.success && q.suggestions[0] === 'Qwen3-0.6B-Q8_0' && q.configured.nMax === 8);
  const dry = await call(ro, 'POST', { model: 'Qwen3-32B-Q4_K_M', mode: 'draft', draft: 'Qwen3-0.6B-Q8_0' });
  check('without local-file access it returns the file instead of writing it',
    dry.body.written === false && dry.body.ini.includes('model-draft = D:\\models\\Qwen3-0.6B-Q8_0.gguf')
    && fs.readFileSync(file, 'utf8') === preset);
  const rw = createSpeculativeRoutes({ env: { LLAMACPP_PRESET: file }, listModels: list, allowLocalFs: true });
  const wrote = await call(rw, 'POST', { model: 'Qwen3-32B-Q4_K_M', mode: 'draft', draft: 'Qwen3-0.6B-Q8_0', nMax: 12 });
  check('with it, the preset file is rewritten',
    wrote.body.written && parseIni(fs.readFileSync(file, 'utf8'))['Qwen3-32B-Q4_K_M']['model-draft'] === 'D:\\models\\Qwen3-0.6B-Q8_0.gguf');
  const bad = await call(rw, 'POST', { model: 'x]\n[evil', mode: 'ngram' });
  check('a section name that could break the file is refused', bad.status === 400);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
