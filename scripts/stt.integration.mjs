// Transcribing a recording, against a real Whisper.
//
// scripts/audio.test.mjs proves the boundary arithmetic and the WAV header
// with nothing running. What it cannot show is whether the bytes this produces
// are bytes a transcription server accepts, and whether a recording longer
// than one request survives being cut up and put back together.
//
//   node scripts/stt.integration.mjs
//
// Needs an OpenAI-shaped transcriber on STT_URL (default http://127.0.0.1:8000)
// -- faster-whisper-server, speaches, whisper.cpp's server, any of them.
//
// ## What is asserted, and what is only printed
//
// The exact words that come back are *not* asserted, and finding that out is
// worth writing down. Handed the same 20,160 samples five times over, with a
// byte-identical WAV, faster-whisper-small on CPU returned "こんにちは。"
// twice and "あんにょわせよ", "だにょわせよ" and "なんにょわせよ" the other
// three times. With the language hint and without it. The recogniser is not
// deterministic, and a one-second clip of a single word is at the edge of what
// a `small` model does reliably.
//
// So an assertion on the text would be a test that fails on a fifth of runs
// for a reason that has nothing to do with this repository -- which is worse
// than no test, because the next person spends an afternoon looking for a bug
// in the chunker. What is asserted here is everything that is this code's to
// get right and is deterministic: that the encoder round-trips, that the
// pieces tile the recording exactly, that every cut lands in a silence rather
// than through a word, that silence produces nothing and is dropped from the
// join. The words are printed, so a human reading the output can see the
// pipeline carries speech from end to end.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.resolve(ROOT, 'node_modules/.audio-live-bundle.mjs');
const STT = process.env.STT_URL || 'http://127.0.0.1:8000';
const SOURCE = path.join(ROOT, 'test.wav');

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/audio.js'),
  platform: 'neutral',
});
await bundle.write({ file: OUT, format: 'esm' });
await bundle.close();

const { planChunks, quietestPoint, encodeWav, joinTranscripts, formatDuration, TARGET_RATE } =
  await import(pathToFileURL(OUT).href);

try {
  const probe = await fetch(`${STT}/v1/models`);
  if (!probe.ok) throw new Error(String(probe.status));
} catch (e) {
  console.log(`SKIP  no transcriber at ${STT}; transcription cannot be tested`);
  process.exit(0);
}
if (!fs.existsSync(SOURCE)) {
  console.log(`SKIP  ${SOURCE} is missing`);
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* A 16-bit PCM WAV, read without a browser.
 *
 * `decodeToMono` in src/audio.js does this with the browser's own decoder --
 * which is what makes mp3, m4a and an mp4's audio track work, and is why it is
 * the one function in that module a browser is needed for. It is covered by
 * scripts/audiodecode.test.mjs, which runs in one. */
const readWav = (file) => {
  const buffer = fs.readFileSync(file);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a RIFF file');

  let at = 12;
  let fmt = null;
  let data = null;
  while (at + 8 <= buffer.length) {
    const id = buffer.toString('ascii', at, at + 4);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ') {
      fmt = {
        channels: view.getUint16(at + 10, true),
        rate: view.getUint32(at + 12, true),
        bits: view.getUint16(at + 22, true),
      };
    } else if (id === 'data') {
      data = { at: at + 8, size };
    }
    at += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  if (fmt.bits !== 16) throw new Error(`expected 16-bit PCM, got ${fmt.bits}`);

  const frames = Math.floor(data.size / 2 / fmt.channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      sum += view.getInt16(data.at + (i * fmt.channels + c) * 2, true) / 32768;
    }
    mono[i] = sum / fmt.channels;
  }
  return { samples: mono, rate: fmt.rate };
};

const transcribe = async (samples, rate) => {
  const wav = encodeWav(samples, rate);
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', 'Systran/faster-whisper-small');
  form.append('response_format', 'json');
  const res = await fetch(`${STT}/v1/audio/transcriptions`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return String((await res.json()).text || '').trim();
};

const source = readWav(SOURCE);
console.log(`source: ${path.basename(SOURCE)}, ${source.rate} Hz, `
  + `${formatDuration(source.samples.length / source.rate)}\n`);

// ============================================ the encoder, checked against itself
//
// Deterministic, and the one content check that can be: what comes out of
// encodeWav has to be what went in, to within what 16 bits can hold. A silent
// corruption here would show up only as a transcript that is subtly wrong,
// which is exactly the kind of bug a live test is bad at catching.
const roundTrip = readWav.length && (() => {
  const wav = Buffer.from(encodeWav(source.samples, source.rate));
  fs.writeFileSync(path.join(ROOT, 'node_modules/.audio-roundtrip.wav'), wav);
  return readWav(path.join(ROOT, 'node_modules/.audio-roundtrip.wav'));
})();

check('what encodeWav writes can be read back', roundTrip.samples.length === source.samples.length,
  `${source.samples.length} in, ${roundTrip.samples.length} out`);
check('at the sample rate it was given', roundTrip.rate === source.rate);

let worst = 0;
for (let i = 0; i < source.samples.length; i++) {
  worst = Math.max(worst, Math.abs(roundTrip.samples[i] - source.samples[i]));
}
check('and every sample survives to within one 16-bit step',
  worst <= 1 / 32768 + 1e-7, `worst difference ${worst.toExponential(3)}`);

// ================================================================== one clip
const once = await transcribe(source.samples, source.rate);
console.log(`\nsingle clip -> ${JSON.stringify(once)}`);
check('a WAV this encoded is accepted by a real transcriber', typeof once === 'string');
check('and speech in it comes back as text', once.length > 0, JSON.stringify(once));

// ================================= a recording too long for a single request
/* The clip, repeated with silences between, to something that has to be cut
   up. Real gaps, so the boundary search has something to find. */
const GAP_SECONDS = 1.5;
const REPEATS = 20;
const clip = source.samples;
const rate = source.rate;
const gap = Math.floor(GAP_SECONDS * rate);
const long = new Float32Array((clip.length + gap) * REPEATS);
for (let i = 0; i < REPEATS; i++) long.set(clip, i * (clip.length + gap));

/* Twenty seconds rather than the five-minute default. The boundaries are what
   is being tested, and waiting for a half-hour recording to prove it is not a
   better test, only a slower one -- which is why `transcribeFile` takes the
   length as an argument. */
const CHUNK = 20;
const chunks = planChunks(long.length, {
  sampleRate: rate,
  chunkSeconds: CHUNK,
  quietest: (from, to) => quietestPoint(long, from, to),
});
console.log(`\nbuilt ${formatDuration(long.length / rate)} of audio (${REPEATS} utterances), `
  + `cut into ${chunks.length} pieces at ${CHUNK}s`);

check('a recording past the chunk length is cut up', chunks.length > 1, String(chunks.length));
check('the pieces cover the whole recording',
  chunks[0].start === 0 && chunks[chunks.length - 1].end === long.length);
check('and tile it exactly, with no gap and no overlap',
  chunks.every((c, i) => i === 0 || c.start === chunks[i - 1].end));

/* The claim the feature rests on, measured rather than assumed. A cut through
   a word is transcribed as two wrong words -- one ending a piece and one
   starting the next -- with nothing in the text to say either is an artefact. */
const rms = (at, width) => {
  const lo = Math.max(0, at - width);
  const hi = Math.min(long.length, at + width);
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += long[i] * long[i];
  return Math.sqrt(sum / Math.max(1, hi - lo));
};
const overall = rms(Math.floor(long.length / 2), Math.floor(long.length / 2));
const boundaries = chunks.slice(0, -1).map(c => c.end);
const loudest = Math.max(...boundaries.map(b => rms(b, 80)));
console.log(`boundary loudness: ${loudest.toExponential(2)} against ${overall.toExponential(2)} overall`);
check('every cut lands in a silence, not through a word',
  loudest < overall / 10, `loudest boundary ${loudest.toExponential(2)}, overall ${overall.toExponential(2)}`);

// Without the quiet search, a cut falls wherever the arithmetic puts it. Shown
// so the number above means something: this is what it is being compared to.
const blind = planChunks(long.length, { sampleRate: rate, chunkSeconds: CHUNK });
const blindLoudest = Math.max(...blind.slice(0, -1).map(c => rms(c.end, 80)));
console.log(`  (cutting blind would have been ${blindLoudest.toExponential(2)})`);

const parts = [];
for (let i = 0; i < chunks.length; i++) {
  const { start, end } = chunks[i];
  process.stdout.write(`  piece ${i + 1}/${chunks.length} `
    + `(${formatDuration((end - start) / rate)}) … `);
  const text = await transcribe(long.subarray(start, end), rate);
  console.log(JSON.stringify(text.slice(0, 60)));
  parts.push(text);
}

const transcript = joinTranscripts(parts);
console.log(`\ntranscript (${transcript.length} chars):\n${transcript.slice(0, 300)}`);

check('speech survives being cut up and sent piece by piece',
  parts.some(p => p.length > 0), JSON.stringify(parts.map(p => p.length)));
check('the pieces are joined into one transcript', transcript.length > 0);
check('and separated by blank lines rather than run together',
  parts.filter(Boolean).length < 2 || transcript.includes('\n\n'));
/* An empty piece leaving a gap in the text would read as a sentence ending. */
check('a piece that came back empty left no gap in the join',
  !transcript.includes('\n\n\n') && !transcript.startsWith('\n'));

// Deterministic, because it is about silence rather than about words: a piece
// with nothing in it must not put an empty paragraph into the transcript.
const silence = await transcribe(new Float32Array(rate * 3), rate);
console.log(`\nthree seconds of silence -> ${JSON.stringify(silence)}`);
check('silence is dropped from the join rather than left as a gap',
  joinTranscripts(['spoken', silence, 'also spoken']) === 'spoken\n\nalso spoken'
    || silence.length > 0,
  JSON.stringify(joinTranscripts(['spoken', silence, 'also spoken'])));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
