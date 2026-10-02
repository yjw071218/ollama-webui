/* Hearing when someone starts and stops talking.
 *
 * Hands-free used to be the browser's SpeechRecognition and nothing else. On
 * Chrome that uploads every word to Google, it cannot be interrupted, and it
 * decides for itself when a sentence ended. With a local Whisper there was no
 * hands-free at all: the local path only recorded between two taps.
 *
 * This is the missing piece: a voice activity detector over the raw
 * microphone signal. It does three jobs with one pipeline:
 *
 *   * End of turn. Speech, then `endSilenceMs` of quiet, is an utterance; it
 *     is handed over as a 16 kHz WAV for the local transcriber. Nobody taps.
 *   * Pre-roll. The frames from just before speech was detected are kept, so
 *     the first syllable -- which is what triggered detection, and so always
 *     arrives before it -- is in the clip rather than cut off.
 *   * Barge-in. While the answer is being read out, the same detector with a
 *     stricter threshold listens for the person talking over it. The capture
 *     that noticed carries on as the next question.
 *
 * Energy-based, with a noise floor that adapts while nobody is talking: a fan,
 * a room, or the residue of our own voice after echo cancellation all become
 * "quiet". Crude next to a neural VAD, but it needs no model download, runs on
 * any phone, and is fully testable -- `vadStep` below is a pure function. */

export const VAD_DEFAULTS = Object.freeze({
  // How far above the noise floor counts as speech.
  ratio: 3,
  // And never below this, so a silent room's tiny floor does not make every
  // breath a sentence. RMS of a float signal in [-1, 1].
  minRms: 0.012,
  // Speech must last this long to count: a cough or a door is shorter.
  startMs: 160,
  // Quiet for this long after speech ends the utterance.
  endSilenceMs: 850,
  // Audio kept from before detection.
  preRollMs: 450,
  // A monologue is cut off here and sent anyway.
  maxUtteranceMs: 30_000,
  // Give up listening if nobody speaks for this long. 0 = never.
  noSpeechMs: 0,
  // How fast the noise floor follows a quiet signal (per second).
  floorAdapt: 0.6,
});

/** Stricter settings for noticing a person talking over the speaker. */
export const BARGE_IN = Object.freeze({ ratio: 5, minRms: 0.03, startMs: 280 });

/** Sensitivity 0..1 from the settings screen, mapped onto the thresholds. */
export const withSensitivity = (opts, sensitivity = 0.5) => {
  const s = Math.min(1, Math.max(0, Number(sensitivity)));
  // 0.5 is the defaults; 1 halves the thresholds, 0 doubles them.
  const scale = 2 ** (1 - 2 * s);
  return { ...opts, ratio: 1 + (opts.ratio - 1) * scale, minRms: opts.minRms * scale };
};

export const createVadState = () => ({
  floor: null, speaking: false, voicedMs: 0, quietMs: 0, utteranceMs: 0, idleMs: 0,
});

/** Root mean square of one frame. */
export const rms = (samples) => {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
};

/**
 * One frame through the detector. Pure: returns the next state and at most one
 * event -- 'start', 'end', 'max' (cut off at maxUtteranceMs) or 'idle' (nobody
 * spoke within noSpeechMs).
 */
export const vadStep = (state, level, dtMs, options = VAD_DEFAULTS) => {
  const o = { ...VAD_DEFAULTS, ...options };
  const s = { ...state };
  if (s.floor === null) s.floor = level;
  const threshold = Math.max(o.minRms, s.floor * o.ratio);
  const loud = level > threshold;
  let event = null;

  if (!s.speaking) {
    // The floor follows the room only while nobody is talking; otherwise a
    // long sentence would raise it until the sentence itself was "quiet".
    if (!loud) {
      const k = Math.min(1, o.floorAdapt * dtMs / 1000);
      // Falls fast, rises slowly: a quiet moment is trusted more than a noise.
      s.floor = level < s.floor ? s.floor + (level - s.floor) * Math.min(1, k * 4) : s.floor + (level - s.floor) * k;
    }
    s.voicedMs = loud ? s.voicedMs + dtMs : Math.max(0, s.voicedMs - dtMs * 2);
    s.idleMs += dtMs;
    if (s.voicedMs >= o.startMs) {
      s.speaking = true;
      s.quietMs = 0;
      s.utteranceMs = s.voicedMs;
      event = 'start';
    } else if (o.noSpeechMs > 0 && s.idleMs >= o.noSpeechMs) {
      event = 'idle';
    }
  } else {
    s.utteranceMs += dtMs;
    s.quietMs = loud ? 0 : s.quietMs + dtMs;
    if (s.quietMs >= o.endSilenceMs) event = 'end';
    else if (s.utteranceMs >= o.maxUtteranceMs) event = 'max';
    if (event) {
      s.speaking = false;
      s.voicedMs = 0;
      s.idleMs = 0;
    }
  }
  return { state: s, event };
};

/** Linear-interpolated resample of mono float samples. */
export const resample = (input, fromRate, toRate) => {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const a = Math.floor(x);
    const b = Math.min(a + 1, input.length - 1);
    out[i] = input[a] + (input[b] - input[a]) * (x - a);
  }
  return out;
};

/** 16-bit PCM mono WAV bytes. What every Whisper server accepts. */
export const encodeWav = (samples, sampleRate) => {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(buffer);
};

const concat = (chunks) => {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};

/**
 * Open the microphone and listen for one utterance.
 *
 * Callbacks:
 *   onSpeechStart()      speech detected (barge-in fires here)
 *   onUtterance(blob)    a WAV of the whole utterance, pre-roll included
 *   onIdle()             nobody spoke within noSpeechMs
 *   onLevel(level, threshold)  per frame, for a meter
 *
 * Returns `{ stop }`. The microphone is released after one utterance, on idle,
 * or on stop -- whichever comes first.
 */
export const listenForUtterance = async ({
  options = VAD_DEFAULTS,
  // Thresholds for *noticing* speech, when they differ from those for its
  // end. Barge-in needs a strict start (our own voice is still playing) and
  // an ordinary end (it stops the moment the person is heard).
  startOptions = null,
  onSpeechStart, onUtterance, onIdle, onLevel,
  mediaDevices = globalThis.navigator?.mediaDevices,
  AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext,
} = {}) => {
  const during = { ...VAD_DEFAULTS, ...options };
  const before = { ...during, ...(startOptions || {}) };
  let o = before;
  // Echo cancellation is what makes barge-in possible on speakers at all: the
  // browser subtracts what the page itself is playing from the microphone.
  const stream = await mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const ctx = new AudioContextImpl();
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated, and still the one capture node every
  // browser this app runs in has without shipping a worklet file.
  const node = ctx.createScriptProcessor(2048, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);

  const rate = ctx.sampleRate;
  const preRollFrames = [];
  let preRollSamples = 0;
  const utterance = [];
  let state = createVadState();
  let done = false;

  const stop = () => {
    if (done) return;
    done = true;
    node.onaudioprocess = null;
    try { source.disconnect(); node.disconnect(); mute.disconnect(); } catch (e) { /* already */ }
    stream.getTracks().forEach(track => track.stop());
    ctx.close?.().catch?.(() => {});
  };

  node.onaudioprocess = (e) => {
    if (done) return;
    const frame = new Float32Array(e.inputBuffer.getChannelData(0));
    const level = rms(frame);
    const dt = (frame.length / rate) * 1000;
    const step = vadStep(state, level, dt, o);
    state = step.state;
    onLevel?.(level, Math.max(o.minRms, (state.floor ?? 0) * o.ratio));

    if (state.speaking || step.event === 'end' || step.event === 'max') utterance.push(frame);
    else {
      preRollFrames.push(frame);
      preRollSamples += frame.length;
      while (preRollFrames.length && preRollSamples - preRollFrames[0].length >= (o.preRollMs / 1000) * rate) {
        preRollSamples -= preRollFrames.shift().length;
      }
    }

    if (step.event === 'start') {
      // Pre-roll first, then the frames that follow.
      utterance.unshift(...preRollFrames.splice(0));
      preRollSamples = 0;
      o = during;
      onSpeechStart?.();
    } else if (step.event === 'end' || step.event === 'max') {
      stop();
      const pcm = resample(concat(utterance), rate, 16000);
      onUtterance?.(new Blob([encodeWav(pcm, 16000)], { type: 'audio/wav' }));
    } else if (step.event === 'idle') {
      stop();
      onIdle?.();
    }
  };

  return { stop };
};
