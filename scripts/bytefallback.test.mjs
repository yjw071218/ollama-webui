// Byte-fallback tokens are what gemma4:31b emits for Korean syllables outside
// its merged vocabulary. These cover the reassembly, and — just as important —
// that text which is not a byte-fallback run survives untouched.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundle = await rolldown({
  input: path.resolve(HERE, '../src/byteFallback.js'),
  platform: 'neutral',
});
const file = path.resolve(HERE, '../node_modules/.bytefallback-test-bundle.mjs');
await bundle.write({ file, format: 'esm' });
await bundle.close();
const { decodeByteFallback, hasByteFallback } = await import(pathToFileURL(file).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// --- the reported case ---
eq('rebuilds 핥', decodeByteFallback('<0xED><0x95><0xA5>'), '핥');
eq('rebuilds it in context',
  decodeByteFallback('**<0xED><0x95><0xA5>다**: 강아지가'), '**핥다**: 강아지가');
eq('rebuilds several in one string',
  decodeByteFallback('<0xED><0x95><0xA5>고 <0xEB><0x9A><0xAB>다'), '핥고 뚫다');

// --- other scripts and lengths ---
eq('two-byte sequence', decodeByteFallback('<0xC3><0xA9>'), 'é');
eq('three-byte CJK', decodeByteFallback('<0xE6><0xBC><0xA2>'), '漢');
eq('four-byte emoji', decodeByteFallback('<0xF0><0x9F><0x94><0xA5>'), '🔥');
eq('ascii byte', decodeByteFallback('<0x41>'), 'A');
eq('lowercase hex', decodeByteFallback('<0xed><0x95><0xa5>'), '핥');

// --- streaming: a run that has not finished arriving must be left alone ---
eq('holds back a one-byte prefix', decodeByteFallback('<0xED>'), '<0xED>');
eq('holds back a two-byte prefix', decodeByteFallback('<0xED><0x95>'), '<0xED><0x95>');
eq('decodes once the last byte lands', decodeByteFallback('<0xED><0x95><0xA5>'), '핥');
eq('decodes complete runs and holds the tail',
  decodeByteFallback('<0xED><0x95><0xA5><0xEB>'), '핥<0xEB>');
check('is idempotent', decodeByteFallback(decodeByteFallback('<0xED><0x95><0xA5>')) === '핥');

// Frame by frame, exactly as the stream delivers it.
const frames = ['<0xED>', '<0x95>', '<0xA5>', '다'];
let acc = '';
const seen = frames.map(f => { acc += f; return decodeByteFallback(acc); });
eq('frame 1 shows no garbage', seen[0], '<0xED>');
eq('frame 3 completes the syllable', seen[2], '핥');
eq('frame 4 continues normally', seen[3], '핥다');

// --- text that is not a byte-fallback run must not be touched ---
eq('plain text is returned as-is', decodeByteFallback('hello 안녕'), 'hello 안녕');
eq('an empty string', decodeByteFallback(''), '');
eq('prose mentioning the notation', decodeByteFallback('the byte 0xED is a lead'), 'the byte 0xED is a lead');
eq('a lone continuation byte stays literal', decodeByteFallback('<0x95>'), '<0x95>');
eq('an invalid lead stays literal', decodeByteFallback('<0xFF>'), '<0xFF>');
eq('an overlong lead stays literal', decodeByteFallback('<0xC0><0x80>'), '<0xC0><0x80>');
eq('a bad continuation stays literal', decodeByteFallback('<0xED><0x41><0xA5>'), '<0xED><0x41><0xA5>');
eq('a stray byte does not eat the next run',
  decodeByteFallback('<0x95><0xED><0x95><0xA5>'), '<0x95>핥');
eq('malformed markup is ignored', decodeByteFallback('<0xE>'), '<0xE>');
eq('a three-hex token is ignored', decodeByteFallback('<0xEDD>'), '<0xEDD>');
eq('code fences survive', decodeByteFallback('```js\nlet x = 1;\n```'), '```js\nlet x = 1;\n```');

// --- non-strings ---
check('null passes through', decodeByteFallback(null) === null);
check('undefined passes through', decodeByteFallback(undefined) === undefined);
check('a number passes through', decodeByteFallback(7) === 7);

// --- detector ---
check('detects a run', hasByteFallback('a<0xED>b'));
check('does not fire on prose', !hasByteFallback('0xED'));
check('does not fire on a non-string', !hasByteFallback(null));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
