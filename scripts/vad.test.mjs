// The voice activity detector behind hands-free (src/vad.js), fed synthetic
// signal levels: a room, speech, a cough, a long pause, a speaker playing.
import {
  vadStep, createVadState, VAD_DEFAULTS, BARGE_IN, withSensitivity,
  rms, resample, encodeWav, listenForUtterance,
} from '../src/vad.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const FRAME = 40;
/** Run levels through the detector; return the events with their times. */
const run = (levels, opts = VAD_DEFAULTS) => {
  let s = createVadState();
  const events = [];
  levels.forEach((level, i) => {
    const r = vadStep(s, level, FRAME, opts);
    s = r.state;
    if (r.event) events.push([r.event, i * FRAME]);
  });
  return events;
};
const hold = (level, ms) => Array(Math.round(ms / FRAME)).fill(level);

const room = 0.004;
const voice = 0.08;

let ev = run([...hold(room, 1000), ...hold(voice, 1200), ...hold(room, 1500)]);
check('speech after quiet starts and then ends an utterance',
  ev.length === 2 && ev[0][0] === 'start' && ev[1][0] === 'end', JSON.stringify(ev));
check('the start is noticed within startMs of speech', ev[0][1] - 1000 <= VAD_DEFAULTS.startMs + FRAME);
check('the end comes endSilenceMs after the speech stops',
  Math.abs(ev[1][1] - (2200 + VAD_DEFAULTS.endSilenceMs)) <= FRAME * 2, String(ev[1][1]));

ev = run([...hold(room, 1000), ...hold(voice, 80), ...hold(room, 2000)]);
check('a cough is not a sentence', ev.length === 0, JSON.stringify(ev));

ev = run([...hold(room, 800), ...hold(voice, 600), ...hold(room, 400), ...hold(voice, 600), ...hold(room, 1500)]);
check('a short pause mid-sentence does not end it',
  ev.filter(e => e[0] === 'end').length === 1, JSON.stringify(ev));

// A noisy room: the floor adapts, so steady noise is not speech.
const fan = 0.03;
ev = run([...hold(fan, 3000), ...hold(fan * 1.1, 2000)]);
check('steady background noise is learned, not heard as speech', ev.length === 0, JSON.stringify(ev));
ev = run([...hold(fan, 3000), ...hold(0.25, 800), ...hold(fan, 1500)]);
check('speech over that noise is still heard', ev[0]?.[0] === 'start' && ev[1]?.[0] === 'end');

// Barge-in: the residue of our own voice through echo cancellation is loud
// enough for the ordinary threshold, but not the barge-in one.
const echo = 0.025;
const barge = { ...VAD_DEFAULTS, ...BARGE_IN };
ev = run([...hold(room, 300), ...hold(echo, 3000)], barge);
check('our own voice leaking back does not interrupt', ev.length === 0, JSON.stringify(ev));
ev = run([...hold(room, 300), ...hold(echo, 1500), ...hold(0.2, 600)], barge);
check('a person talking over it does', ev[0]?.[0] === 'start', JSON.stringify(ev));

ev = run([...hold(room, 500), ...hold(voice, 2000)], { ...VAD_DEFAULTS, maxUtteranceMs: 1000 });
check('a monologue is cut off at maxUtteranceMs', ev.some(e => e[0] === 'max'));
ev = run(hold(room, 3000), { ...VAD_DEFAULTS, noSpeechMs: 2000 });
check('silence gives up at noSpeechMs when asked to', ev[0]?.[0] === 'idle');

const hi = withSensitivity(VAD_DEFAULTS, 1);
const lo = withSensitivity(VAD_DEFAULTS, 0);
check('sensitivity lowers and raises the thresholds',
  hi.minRms < VAD_DEFAULTS.minRms && lo.minRms > VAD_DEFAULTS.minRms && hi.ratio < lo.ratio);
check('sensitivity 0.5 is the defaults', withSensitivity(VAD_DEFAULTS, 0.5).minRms === VAD_DEFAULTS.minRms);

check('rms of a full-scale square wave is 1', Math.abs(rms(new Float32Array([1, -1, 1, -1])) - 1) < 1e-9);
const r = resample(new Float32Array(48000).fill(0.5), 48000, 16000);
check('resampling 48k to 16k keeps duration and level', r.length === 16000 && Math.abs(r[100] - 0.5) < 1e-6);
const wav = encodeWav(new Float32Array([0, 1, -1]), 16000);
const dv = new DataView(wav.buffer);
check('the WAV header is well-formed',
  String.fromCharCode(...wav.slice(0, 4)) === 'RIFF' && String.fromCharCode(...wav.slice(8, 12)) === 'WAVE'
  && dv.getUint32(24, true) === 16000 && dv.getUint32(40, true) === 6);
check('samples are 16-bit and clamp', dv.getInt16(46, true) === 32767 && dv.getInt16(48, true) === -32768);

// The whole capture path with a fake microphone: pre-roll is kept, the
// microphone is released afterwards.
{
  let stopped = 0;
  let processor = null;
  const fakeNode = () => ({ connect() {}, disconnect() {} });
  class FakeCtx {
    constructor() { this.sampleRate = 16000; this.destination = {}; }
    createMediaStreamSource() { return fakeNode(); }
    createScriptProcessor() { processor = fakeNode(); return processor; }
    createGain() { return { ...fakeNode(), gain: { value: 1 } }; }
    close() { return Promise.resolve(); }
  }
  const mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }) };
  let blob = null;
  let started = 0;
  await listenForUtterance({
    mediaDevices, AudioContextImpl: FakeCtx,
    onSpeechStart: () => started++,
    onUtterance: (b) => { blob = b; },
  });
  const feed = (level, ms) => {
    for (let t = 0; t < ms; t += 128) {
      const data = new Float32Array(2048).fill(level);
      processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => data } });
    }
  };
  feed(0.003, 2000);
  feed(0.1, 1000);
  feed(0.003, 2000);
  check('the capture reports the start of speech', started === 1);
  check('the capture hands over one WAV and releases the microphone', blob && stopped === 1);
  // ~1s of speech plus ~0.45s pre-roll plus ~0.85s trailing quiet, at 16 kHz.
  const seconds = blob ? (blob.size - 44) / 2 / 16000 : 0;
  check('the clip includes the pre-roll before detection', seconds > 1.9 && seconds < 3.0, seconds.toFixed(2));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
