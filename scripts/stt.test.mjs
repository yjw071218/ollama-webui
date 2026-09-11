// Speech in, without leaving the machine.
//
// The app used `SpeechRecognition`, and on Chrome that works by uploading the
// audio to Google: it needs a working internet connection, it sends what you
// said to a third party, and it is markedly worse in Korean than Whisper is.
// In an app whose entire premise is that the model runs on your own hardware,
// the microphone was the last thing still leaving the building.
//
// The browser's recogniser stays as the fallback, because plenty of setups
// have no local Whisper and a voice button that does nothing is worse than one
// that does something imperfect.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundle = await rolldown({ input: path.resolve(HERE, '../src/stt.js'), platform: 'neutral' });
const out = path.resolve(HERE, '../node_modules/.stt-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const { whisperLanguage, pickMimeType, transcribe, localSttAvailable } =
  await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const setGlobal = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

/* ------------------------------------------------------------ the language */

// Whisper wants a two-letter code, and the app's tags carry a region or a
// script it has no use for.
eq('Korean', whisperLanguage('ko'), 'ko');
eq('a regional tag loses its region', whisperLanguage('pt-BR'), 'pt');

// The script is a property of the writing, not of the speech: there is nothing
// in the audio that distinguishes Simplified from Traditional.
eq('both Chinese scripts are one spoken language', whisperLanguage('zh-Hans'), 'zh');
eq('and the other one too', whisperLanguage('zh-Hant'), 'zh');

// Empty rather than a guess: Whisper detects the language on its own, and a
// wrong hint is worse than none.
eq('no language is no hint', whisperLanguage(''), '');
eq('nothing at all is no hint', whisperLanguage(null), '');

/* -------------------------------------------------------- the recording */

// Opus in WebM first, because it is what a browser records well and what a
// transcriber reads without complaint.
eq('the best supported format wins', pickMimeType(() => true), 'audio/webm;codecs=opus');
eq('and it falls back in order', pickMimeType(t => t === 'audio/mp4'), 'audio/mp4');
eq('nothing supported is an empty preference, not a crash', pickMimeType(() => false), '');
eq('a recorder that throws on the question is treated as a no',
  pickMimeType(() => { throw new Error('nope'); }), '');

/* ------------------------------------------------------- the transcription */

// The request has to carry the file, the model and the language hint, in the
// multipart shape the OpenAI-compatible endpoint expects.
{
  let seen = null;
  setGlobal('fetch', async (url, init) => {
    seen = { url, body: init.body, method: init.method };
    return { ok: true, json: async () => ({ text: '  안녕하세요  ' }) };
  });
  const text = await transcribe(new Blob(['x']), { language: 'ko', model: 'small' });
  eq('the text comes back trimmed', text, '안녕하세요');
  eq('it posts', seen.method, 'POST');
  check('to the proxied endpoint', seen.url === '/stt-api/v1/audio/transcriptions', seen.url);
  check('with the file', seen.body.has('file'));
  check('the model', seen.body.get('model') === 'small');
  check('and the language hint', seen.body.get('language') === 'ko');
}

// No hint means no field, rather than an empty one the server has to interpret.
{
  let body = null;
  setGlobal('fetch', async (url, init) => {
    body = init.body;
    return { ok: true, json: async () => ({ text: 'hi' }) };
  });
  await transcribe(new Blob(['x']), {});
  check('an absent language sends no language field', !body.has('language'));
}

// A failure has to say what happened: "transcription failed" with no status is
// the sort of message that costs an hour.
{
  setGlobal('fetch', async () => ({ ok: false, status: 503, text: async () => 'model still loading' }));
  let message = '';
  try { await transcribe(new Blob(['x']), {}); } catch (e) { message = e.message; }
  check('a failure names the status', /503/.test(message), message);
  check('and quotes what the server said', /model still loading/.test(message), message);
}

// A response with no text is an empty transcript, not a crash.
{
  setGlobal('fetch', async () => ({ ok: true, json: async () => ({}) }));
  eq('a bodyless answer is empty', await transcribe(new Blob(['x']), {}), '');
  setGlobal('fetch', async () => ({ ok: true, json: async () => { throw new Error('not json'); } }));
  eq('an unparseable answer is empty', await transcribe(new Blob(['x']), {}), '');
}

/* ------------------------------------------------------- is one running? */

{
  setGlobal('fetch', async () => ({ ok: true }));
  check('a server that answers is available', await localSttAvailable({ refresh: true }));
  // Cached: this is asked every time the microphone opens, and a dead port
  // costs a connection refusal each time.
  let calls = 0;
  setGlobal('fetch', async () => { calls++; return { ok: true }; });
  await localSttAvailable();
  await localSttAvailable();
  eq('and the answer is cached', calls, 0);
}
{
  setGlobal('fetch', async () => { throw new Error('ECONNREFUSED'); });
  check('a refused connection is not available', !(await localSttAvailable({ refresh: true })));
}

/* --------------------------------------------------------- the call sites */

const app = fs.readFileSync(path.resolve(HERE, '../src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const server = fs.readFileSync(path.resolve(HERE, '../server/index.js'), 'utf8').replace(/\r\n/g, '\n');

check('the server proxies the transcriber', /url\.pathname\.startsWith\('\/stt-api'\)/.test(server));
check('to a configurable host', /env\.STT_HOST/.test(server) && /env\.STT_PORT/.test(server));
check('and .env.example says so', /STT_HOST=/.test(fs.readFileSync(path.resolve(HERE, '../.env.example'), 'utf8')));

check('the local transcriber is preferred when there is one',
  /if \(await localSttAvailable\(\)\)/.test(app));
check('the browser recogniser is still the fallback',
  /recognitionRef\.current\.start\(\)/.test(app));
check('and both transcripts go through one handler',
  /heardRef\.current\(e\.results\[0\]\[0\]\.transcript\)/.test(app));
check('the mic shows that it is waiting on the transcriber',
  /isTranscribing \? <RefreshCcw/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
