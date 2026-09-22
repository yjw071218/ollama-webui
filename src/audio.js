/**
 * A recording, turned into something that can be read.
 *
 * Speech recognition has been here for a while and it is wired to exactly one
 * thing: the microphone. Which means the app can hear you *now* and can do
 * nothing at all with the hour of audio already on the disk — the lecture, the
 * meeting, the interview, the voice message somebody sent instead of typing.
 * Those are the recordings anybody actually wants summarised, and they were
 * the one kind that had to go somewhere else first.
 *
 * Everything needed was already installed. `src/stt.js` posts a clip to a
 * local Whisper and gets text back; the composer indexes a long document and
 * retrieves from it. This is the piece between them.
 *
 * ## Why the file is not just posted as it is
 *
 * A transcription server takes a clip. Hand it a ninety-minute meeting and one
 * of three things happens: the upload is refused for size, the request times
 * out, or it works and returns nothing for forty minutes while the browser
 * shows a spinner that cannot be distinguished from a crash. None of those is
 * a thing to build on.
 *
 * So the audio is decoded, downmixed to mono at 16 kHz — which is what Whisper
 * resamples to anyway, so nothing is lost and the data shrinks by a factor of
 * ten or more — and cut into pieces of a few minutes. Each piece is sent on
 * its own, which gives a progress count that moves, a stop button that works,
 * and a failure that costs one piece rather than the recording.
 *
 * ## The cut goes where nobody is speaking
 *
 * Cutting at exactly five minutes lands in the middle of a word about as often
 * as not, and a word cut in half is transcribed as two wrong words — one at
 * the end of a piece and one at the start of the next, with no clue in the
 * text that either is an artefact.
 *
 * So the cut is allowed to move: within a window around the nominal boundary,
 * it goes to the quietest point. In speech that is a pause between words, and
 * usually a pause between sentences. It costs one pass over the samples of the
 * window and removes the entire class of problem.
 *
 * Overlapping the pieces would be the other answer, and it is worse: the
 * overlap is transcribed twice and has to be de-duplicated afterwards, against
 * text that is not identical because the two passes heard different context.
 * Duplicated sentences in a transcript are a worse failure than a rare
 * mis-split, because they look like something that was actually said.
 */

/* What Whisper works at internally. Decoding to it here rather than sending
   48 kHz stereo and letting the server resample is a tenth of the bytes for
   exactly the same result. */
export const TARGET_RATE = 16000;

/* How long a piece may be. Whisper's own window is 30 seconds and it stitches
   internally, so this is not about accuracy -- it is about the request: five
   minutes of 16 kHz mono is about 9.6 MB as WAV, which uploads and transcribes
   in a time somebody will wait for while watching a counter move. */
export const CHUNK_SECONDS = 300;

/* How far the cut may move to find a quiet point. Half a second either way is
   enough to clear a word -- the gap between words in ordinary speech is tens
   of milliseconds and between sentences a few hundred -- and small enough that
   the pieces stay even. */
export const CUT_WINDOW_SECONDS = 0.5;

/* Audio a browser will decode. Checked by extension *and* by type, because a
   file dragged from a phone arrives with a type and no useful extension, and
   one restored from a backup arrives with an extension and no type. */
const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|webm|wma|amr|aiff?|mp4|mov|mkv|3gp)$/i;

export const isAudioFile = (file) => {
  if (!file) return false;
  const type = String(file.type || '').toLowerCase();
  if (type.startsWith('audio/')) return true;
  /* Video counts. A screen recording of a meeting is the commonest way a
     meeting arrives, and the soundtrack is the whole of what is wanted from
     it. The browser decodes the audio track and ignores the pictures. */
  if (type.startsWith('video/')) return true;
  return AUDIO_EXTENSIONS.test(String(file.name || ''));
};

/**
 * Where to cut, given how many samples there are.
 *
 * `quietest` is passed in rather than computed here so that this stays a pure
 * function of lengths: the caller supplies the samples, and a test can supply
 * a stub that proves the boundary search is being asked about the right
 * window. Without it, every piece ends exactly on the nominal boundary.
 */
export const planChunks = (totalSamples, {
  sampleRate = TARGET_RATE,
  chunkSeconds = CHUNK_SECONDS,
  windowSeconds = CUT_WINDOW_SECONDS,
  quietest = null,
} = {}) => {
  const total = Math.max(0, Math.floor(totalSamples));
  if (total === 0) return [];

  const size = Math.max(1, Math.floor(chunkSeconds * sampleRate));
  if (total <= size) return [{ start: 0, end: total }];

  const window = Math.max(0, Math.floor(windowSeconds * sampleRate));
  const chunks = [];
  let start = 0;

  while (start < total) {
    let end = start + size;
    if (end >= total) { chunks.push({ start, end: total }); break; }

    if (quietest && window > 0) {
      const from = Math.max(start + 1, end - window);
      const to = Math.min(total - 1, end + window);
      const moved = quietest(from, to);
      /* A search that answers outside the window it was given, or with
         something that would make an empty or backwards piece, is ignored
         rather than trusted. This is a boundary calculation and an off-by-one
         here is a silently truncated recording. */
      if (Number.isFinite(moved) && moved > start && moved >= from && moved <= to) end = Math.floor(moved);
    }

    chunks.push({ start, end });
    start = end;
  }

  return chunks;
};

/**
 * The quietest point in a range, by short-window energy.
 *
 * Root-mean-square over small windows rather than the single smallest sample:
 * a waveform crosses zero hundreds of times a second in the middle of a
 * shouted word, so the smallest *sample* carries no information about whether
 * anybody is speaking. The smallest window does.
 */
export const quietestPoint = (samples, from, to, windowSize = 160) => {
  const lo = Math.max(0, Math.floor(from));
  const hi = Math.min(samples.length, Math.floor(to));
  if (hi <= lo) return lo;

  let bestAt = lo;
  let best = Infinity;

  for (let at = lo; at < hi; at += windowSize) {
    const stop = Math.min(hi, at + windowSize);
    let sum = 0;
    for (let i = at; i < stop; i++) sum += samples[i] * samples[i];
    const energy = sum / (stop - at);
    if (energy < best) { best = energy; bestAt = at + Math.floor((stop - at) / 2); }
  }

  return bestAt;
};

/**
 * Mono 16-bit PCM in a WAV container.
 *
 * WAV because every transcription server accepts it and producing it needs no
 * encoder — the header is 44 bytes of arithmetic. Encoding to Opus in the
 * browser would be a third of the size and needs either a WASM encoder in the
 * bundle or `MediaRecorder` driven from an audio graph in real time, which for
 * a ninety-minute file means ninety minutes.
 */
export const encodeWav = (samples, sampleRate = TARGET_RATE) => {
  const count = samples.length;
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);

  const ascii = (at, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + count * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM header length
  view.setUint16(20, 1, true);           // PCM, uncompressed
  view.setUint16(22, 1, true);           // one channel
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);  // bytes per second
  view.setUint16(32, 2, true);           // bytes per frame
  view.setUint16(34, 16, true);          // bits per sample
  ascii(36, 'data');
  view.setUint32(40, count * 2, true);

  for (let i = 0; i < count; i++) {
    /* Clamped before scaling. A float sample outside [-1, 1] -- which
       resampling and downmixing both produce -- wraps around when written as
       a 16-bit integer, turning a loud passage into white noise. */
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }

  return buffer;
};

/**
 * The pieces' texts, as one transcript.
 *
 * Joined with a blank line rather than a space: a piece boundary is a pause in
 * the recording, so it is a paragraph break in the text more often than not,
 * and a transcript that is one unbroken block is unreadable and unquotable.
 * Empty pieces — silence, a failed request — are dropped rather than leaving a
 * gap that reads as a sentence ending.
 */
export const joinTranscripts = (parts) => (parts || [])
  .map(part => String(part ?? '').trim())
  .filter(Boolean)
  .join('\n\n');

/** `1:04:09`, for a label. Hours only when there are any. */
export const formatDuration = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

/**
 * Decode a file to mono samples at 16 kHz.
 *
 * `OfflineAudioContext` does the resampling and the downmix in one pass, using
 * the browser's own decoder — which is the only reason this works for mp3,
 * m4a, FLAC and the audio track of an mp4 without any of those formats
 * appearing in the bundle.
 *
 * Browser-only, and separated from everything above so that everything above
 * can be tested without one.
 */
export const decodeToMono = async (arrayBuffer, { sampleRate = TARGET_RATE } = {}) => {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Ctx || !OfflineCtx) throw new Error('This browser cannot decode audio');

  /* Decoded at its own rate first. `decodeAudioData` on an OfflineAudioContext
     resamples to that context's rate on some browsers and not others, so the
     length would be right on one and wrong on the next -- and the length is
     what every chunk boundary is computed from. */
  const scratch = new Ctx();
  let decoded;
  try {
    decoded = await scratch.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    scratch.close?.();
  }

  const frames = Math.max(1, Math.ceil(decoded.duration * sampleRate));
  const offline = new OfflineCtx(1, frames, sampleRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();

  return {
    samples: rendered.getChannelData(0),
    sampleRate,
    duration: decoded.duration,
  };
};
