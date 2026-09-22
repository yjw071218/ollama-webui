// `decodeToMono`, in a browser, because there is nowhere else it can run.
//
// It is the one function in src/audio.js that Node cannot execute: it hands
// the file to the browser's own decoder, which is the whole reason mp3, m4a,
// FLAC and the audio track of an mp4 all work without any of those formats
// appearing in the bundle. Everything downstream of it -- the chunk
// boundaries, the WAV encoder, the join -- is covered by scripts/audio.test.mjs
// and scripts/stt.integration.mjs.
//
// What it has to get right is small and easy to get wrong:
//
//   * the output is at 16 kHz, whatever the input was;
//   * it is one channel, whatever the input was;
//   * its length matches the source's duration, because every chunk boundary
//     downstream is computed from that length;
//   * the audio is still the audio, not silence and not noise.
//
// The last is checked by feeding it a tone and reading the tone back out.
// A resampler that is subtly wrong produces a file that is the right length
// and the wrong sound, and a transcript nobody can explain.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HTTP_PORT = 8254;      // not 8253: that is the smoke test's
const CDP_PORT = 9489;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const done = (code) => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(code ?? (fail === 0 ? 0 : 1));
};

const BROWSERS = [
  process.env.SMOKE_BROWSER,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browser = BROWSERS.find(p => p && fs.existsSync(p));
if (!browser) {
  console.log('SKIP  no Chrome or Edge found; the decoder was not exercised');
  done(0);
}

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/audio.js'),
  platform: 'browser',
});
const built = await bundle.generate({ format: 'esm' });
await bundle.close();
const moduleSource = built.output[0].code;

/* A WAV built here rather than read from disk, so the test can say what is in
   it. A 440 Hz tone, stereo, at 48 kHz -- three things the decoder has to
   change at once: the rate down to 16k, two channels to one, and the samples
   through a resampler that must not destroy the tone. */
const TONE_HZ = 440;
const SOURCE_RATE = 48000;
const SECONDS = 2;
const makeWav = () => {
  const frames = SOURCE_RATE * SECONDS;
  const buffer = Buffer.alloc(44 + frames * 2 * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + frames * 4, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);                     // PCM
  buffer.writeUInt16LE(2, 22);                     // two channels
  buffer.writeUInt32LE(SOURCE_RATE, 24);
  buffer.writeUInt32LE(SOURCE_RATE * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * TONE_HZ * i) / SOURCE_RATE) * 0.5 * 32767);
    buffer.writeInt16LE(v, 44 + i * 4);            // left
    buffer.writeInt16LE(v, 44 + i * 4 + 2);        // right, identical
  }
  return buffer;
};
const wav = makeWav();

const PAGE = `<!doctype html><meta charset="utf-8"><title>decode</title>
<script type="module">
  import { decodeToMono, TARGET_RATE } from '/audio.mjs';
  window.__decode = async () => {
    const bytes = await (await fetch('/tone.wav')).arrayBuffer();
    const { samples, sampleRate, duration } = await decodeToMono(bytes);
    // Peak and zero crossings, which together say the tone is still a tone.
    let peak = 0, crossings = 0;
    for (let i = 0; i < samples.length; i++) {
      peak = Math.max(peak, Math.abs(samples[i]));
      if (i > 0 && ((samples[i - 1] < 0) !== (samples[i] < 0))) crossings++;
    }
    return { length: samples.length, sampleRate, duration, peak, crossings, target: TARGET_RATE };
  };
  window.__ready = true;
</script>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/audio.mjs')) {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    return res.end(moduleSource);
  }
  if (req.url.startsWith('/tone.wav')) {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    return res.end(wav);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise(r => server.listen(HTTP_PORT, '127.0.0.1', r));

const { launchChrome } = await import('./chromeProfile.mjs');
const chrome = launchChrome(browser, 'webui-chrome-audio-', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  // Without this the decoder exists but produces silence in headless Chrome.
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${CDP_PORT}`,
]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cleanup = () => {
  try { server.close(); } catch (e) { /* closed */ }
  chrome.close();
};

let ws;
try {
  const wsUrl = await (async () => {
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        const target = list.find(t => t.type === 'page');
        if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
      } catch (e) { /* not up yet */ }
      await sleep(250);
    }
    throw new Error('the browser never opened a debugging port');
  })();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
} catch (err) {
  check('the browser starts', false, err.message);
  cleanup();
  done();
}

let nextId = 1;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const { result } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result?.exceptionDetails) {
    return { error: result.exceptionDetails.exception?.description || result.exceptionDetails.text };
  }
  return result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/` });

let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  await sleep(250);
  ready = await evaluate('window.__ready === true');
}
check('the module loads in a browser', ready === true);

const out = ready ? await evaluate('window.__decode()') : { error: 'module never loaded' };
cleanup();

if (!out || out.error) {
  check('decodeToMono runs', false, String(out?.error || 'no result'));
  done();
}

console.log(`\n  ${SECONDS}s of ${TONE_HZ} Hz, stereo, ${SOURCE_RATE} Hz`);
console.log(`  -> ${out.length} samples at ${out.sampleRate} Hz `
  + `(${out.duration.toFixed(3)}s), peak ${out.peak.toFixed(3)}, ${out.crossings} crossings\n`);

check('the output is at the rate Whisper works in', out.sampleRate === out.target,
  `${out.sampleRate} against ${out.target}`);
check('the duration is the source duration', Math.abs(out.duration - SECONDS) < 0.02,
  String(out.duration));

/* Every chunk boundary downstream is computed from this length. A decoder that
   returns the right rate and the wrong number of samples truncates a recording
   silently. */
check('the length matches the duration at that rate',
  Math.abs(out.length - SECONDS * out.target) <= out.target * 0.02,
  `${out.length} against ${SECONDS * out.target}`);

check('a stereo source came out as one channel', out.length < SECONDS * SOURCE_RATE);

/* The audio is still the audio. A tone that came through at full amplitude and
   the right frequency is a resampler that did its job; silence would mean a
   decoder that ran and produced nothing, which is a real headless failure
   mode. */
check('the sound survived the decode, rather than becoming silence',
  out.peak > 0.3, `peak ${out.peak}`);
check('and it is still the same tone',
  Math.abs(out.crossings / 2 / SECONDS - TONE_HZ) < TONE_HZ * 0.05,
  `${(out.crossings / 2 / SECONDS).toFixed(1)} Hz against ${TONE_HZ} Hz`);

done();
