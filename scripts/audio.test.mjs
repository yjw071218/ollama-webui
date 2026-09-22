// Chunk boundaries, the WAV header and the join. Decoding needs a browser and
// is deliberately the only thing in src/audio.js that does -- everything a
// boundary calculation can get wrong is here, where it can be asserted.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../node_modules/.audio-test-bundle.mjs');

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/audio.js'),
  platform: 'neutral',
});
await bundle.write({ file: OUT, format: 'esm' });
await bundle.close();

const {
  isAudioFile, planChunks, quietestPoint, encodeWav, joinTranscripts,
  formatDuration, TARGET_RATE, CHUNK_SECONDS,
} = await import(pathToFileURL(OUT).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

// ----------------------------------------------------------- recognising one
check('an audio type is audio', isAudioFile({ name: 'x', type: 'audio/mpeg' }));
// A screen recording of a meeting is the commonest way a meeting arrives.
check('a video type is audio, because of its soundtrack',
  isAudioFile({ name: 'meeting.mp4', type: 'video/mp4' }));
// A file dragged from a phone has a type and no useful name; one restored from
// a backup has a name and no type.
check('an extension with no type still counts', isAudioFile({ name: 'voice.m4a', type: '' }));
check('a type with no extension still counts', isAudioFile({ name: 'recording', type: 'audio/ogg' }));
check('a PDF is not audio', !isAudioFile({ name: 'report.pdf', type: 'application/pdf' }));
check('a text file is not audio', !isAudioFile({ name: 'notes.txt', type: 'text/plain' }));
check('nothing is not audio', !isAudioFile(null));

// ------------------------------------------------------------------- chunking
const RATE = TARGET_RATE;
const seconds = (n) => n * RATE;

check('an empty recording is no chunks', planChunks(0).length === 0);
check('a short recording is one chunk',
  planChunks(seconds(30)).length === 1, String(planChunks(seconds(30)).length));
check('and that chunk is the whole of it',
  planChunks(seconds(30))[0].end === seconds(30));

const hour = planChunks(seconds(3600));
check('an hour is cut into pieces', hour.length === Math.ceil(3600 / CHUNK_SECONDS), String(hour.length));
// The properties a boundary calculation has to have, stated as tests, because
// getting one wrong means a silently truncated recording.
check('the pieces start at the beginning', hour[0].start === 0);
check('and reach the end', hour[hour.length - 1].end === seconds(3600));
check('and leave no gap', hour.every((c, i) => i === 0 || c.start === hour[i - 1].end));
check('and none is empty', hour.every(c => c.end > c.start));

// The cut is allowed to move to a quiet point, because a word cut in half is
// transcribed as two wrong words with nothing in the text to say so.
const moved = planChunks(seconds(700), { quietest: (from) => from + 10 });
check('a quiet point moves the cut', moved[0].end !== seconds(CHUNK_SECONDS),
  String(moved[0].end));
check('and the pieces still meet exactly',
  moved.every((c, i) => i === 0 || c.start === moved[i - 1].end));
check('and still reach the end', moved[moved.length - 1].end === seconds(700));

// A search answering outside its window is a bug in the search; trusting it
// here would be a truncated recording.
const wild = planChunks(seconds(700), { quietest: () => 5 });
check('a nonsensical answer is ignored', wild[0].end === seconds(CHUNK_SECONDS), String(wild[0].end));
const nan = planChunks(seconds(700), { quietest: () => NaN });
check('so is one that is not a number', nan[0].end === seconds(CHUNK_SECONDS));
const late = planChunks(seconds(700), { quietest: () => seconds(9999) });
check('so is one past the end of the window', late[0].end === seconds(CHUNK_SECONDS));

check('a custom chunk length is respected',
  planChunks(seconds(100), { chunkSeconds: 10 }).length === 10);

// ---------------------------------------------------------------- quiet point
// RMS over windows, not the smallest sample: a waveform crosses zero hundreds
// of times a second inside a shouted word, so the smallest sample says nothing
// about whether anybody is speaking.
const loud = new Float32Array(16000);
for (let i = 0; i < loud.length; i++) loud[i] = Math.sin(i / 3);    // crosses zero constantly
for (let i = 8000; i < 8400; i++) loud[i] = 0;                       // one real pause
const quiet = quietestPoint(loud, 0, loud.length);
check('the pause is found, not a zero crossing', quiet >= 8000 && quiet <= 8400, String(quiet));

check('an empty range answers its own start', quietestPoint(new Float32Array(10), 5, 5) === 5);
check('a range past the end is clamped',
  quietestPoint(new Float32Array(10), 0, 999) < 10);

// --------------------------------------------------------------------- WAV
const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 16000);
const view = new DataView(wav);
const ascii = (at, n) => String.fromCharCode(...new Uint8Array(wav, at, n));

check('it is a RIFF file', ascii(0, 4) === 'RIFF');
check('of type WAVE', ascii(8, 4) === 'WAVE');
check('with a fmt chunk', ascii(12, 4) === 'fmt ');
check('and a data chunk', ascii(36, 4) === 'data');
check('PCM', view.getUint16(20, true) === 1);
check('one channel', view.getUint16(22, true) === 1);
check('at the rate it was given', view.getUint32(24, true) === 16000);
check('16 bits per sample', view.getUint16(34, true) === 16);
check('the byte rate agrees', view.getUint32(28, true) === 16000 * 2);
check('the header length is right', wav.byteLength === 44 + 5 * 2);
check('the data length is declared', view.getUint32(40, true) === 5 * 2);
check('the RIFF length is declared', view.getUint32(4, true) === 36 + 5 * 2);

check('silence is zero', view.getInt16(44, true) === 0);
check('full scale positive does not wrap', view.getInt16(44 + 6, true) === 32767);
check('full scale negative does not wrap', view.getInt16(44 + 8, true) === -32768);

// Resampling and downmixing both produce samples outside [-1, 1], and an
// unclamped write turns a loud passage into white noise.
const hot = new DataView(encodeWav(new Float32Array([4, -4]), 16000));
check('a sample past full scale is clamped, not wrapped',
  hot.getInt16(44, true) === 32767 && hot.getInt16(46, true) === -32768,
  `${hot.getInt16(44, true)}, ${hot.getInt16(46, true)}`);

check('an empty recording still produces a valid header', encodeWav(new Float32Array(0)).byteLength === 44);

// -------------------------------------------------------------------- joining
check('pieces are separated by a blank line',
  joinTranscripts(['one', 'two']) === 'one\n\ntwo');
// An empty piece leaving a gap would read as a sentence ending.
check('an empty piece is dropped', joinTranscripts(['one', '', '  ', 'two']) === 'one\n\ntwo');
check('nothing joins to nothing', joinTranscripts([]) === '' && joinTranscripts(null) === '');
check('each piece is trimmed', joinTranscripts(['  one  ']) === 'one');

// -------------------------------------------------------------------- labels
check('under an hour has no hours', formatDuration(75) === '1:15');
check('over an hour does', formatDuration(3849) === '1:04:09', formatDuration(3849));
check('zero is zero', formatDuration(0) === '0:00');
check('nonsense is zero', formatDuration(null) === '0:00');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
