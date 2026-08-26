// Checks the detector that decides whether a question needs a live search
// before the model answers from a stale training snapshot.
import { rolldown } from 'rolldown';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// needsCurrentInfo lives in App.jsx next to the chat UI; pull just that export
// into a tiny module so the test does not drag React in.
const app = fs.readFileSync(path.resolve(HERE, '../src/App.jsx'), 'utf8');
const start = app.indexOf('const RECENCY_CUES = [');
const end = app.indexOf('const escapeRegExp =');
if (start < 0 || end < 0) { console.error('could not locate the detector'); process.exit(1); }

const shim = path.resolve(HERE, '../node_modules/.grounding-src.mjs');
fs.writeFileSync(shim, app.slice(start, end));

const bundle = await rolldown({ input: shim, platform: 'neutral' });
const out = path.resolve(HERE, '../node_modules/.grounding-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();

const { needsCurrentInfo } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const year = new Date().getFullYear();

const SHOULD_SEARCH = [
  'ai 업계 근황 알려줘',
  '최신 AI 동향이 어떻게 돼?',
  '요즘 유행하는 프레임워크는?',
  'What is the latest version of Ollama?',
  'Any recent news about GPUs?',
  'what happened today in tech',
  `what changed in ${year}`,
  `${year + 1}년 전망`,
  'current price of an RTX 5090',
  '最新のAIニュース',
  '现在最流行的模型是什么',
  'state of the art image models',
];

const SHOULD_NOT = [
  'explain how a hash map works',
  '재귀 함수가 뭐야?',
  'write a python function that reverses a string',
  'what is 17 * 23',
  'translate this sentence into Japanese',
  'why does my for loop skip the last element',
  '2019 was a long time ago',        // an old year is not a recency cue
  '',
];

for (const q of SHOULD_SEARCH) check(`searches: ${JSON.stringify(q)}`, needsCurrentInfo(q) === true);
for (const q of SHOULD_NOT) check(`skips:    ${JSON.stringify(q)}`, needsCurrentInfo(q) === false);

check('handles null', needsCurrentInfo(null) === false);
check('handles undefined', needsCurrentInfo(undefined) === false);
check('handles whitespace', needsCurrentInfo('   ') === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
