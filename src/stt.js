/**
 * Turning speech into text on this machine.
 *
 * The browser has `SpeechRecognition` and the app has always used it. On
 * Chrome it works by uploading the audio to Google: it needs a working
 * internet connection, it sends what you said to somebody else, and it is
 * markedly worse in Korean than Whisper is. In an app whose whole premise is
 * that the model runs on your own hardware, the microphone was the last thing
 * still leaving the building.
 *
 * So: record with `MediaRecorder`, post the clip to a local Whisper, use the
 * text. The server is reached at `/stt-api`, proxied by server/index.js to
 * whatever `STT_HOST`/`STT_PORT` name — anything speaking the OpenAI
 * `/v1/audio/transcriptions` shape will do, which is faster-whisper-server,
 * whisper.cpp's server and speaches among others.
 *
 * Nothing here is required. Where there is no such server the caller keeps the
 * browser's recogniser, which is what it used before and still works.
 */

/** Where the proxy puts it. */
const ENDPOINT = '/stt-api/v1/audio/transcriptions';
const MODELS = '/stt-api/v1/models';

/**
 * Is a local transcriber actually there?
 *
 * Asked once and cached, because it is asked every time the microphone opens
 * and a dead port costs a connection refusal each time. Cached as a promise so
 * that two callers at once make one request.
 */
let probe = null;
export const localSttAvailable = ({ refresh = false, timeoutMs = 1500 } = {}) => {
  if (refresh) probe = null;
  if (probe) return probe;
  probe = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(MODELS, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch (e) {
      return false;
    }
  })();
  return probe;
};

/** The recording formats worth asking for, best first. */
const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

export const pickMimeType = (isSupported) => {
  const supported = isSupported
    || (typeof MediaRecorder !== 'undefined'
      ? (t) => MediaRecorder.isTypeSupported(t)
      : () => false);
  return PREFERRED_TYPES.find(t => { try { return supported(t); } catch (e) { return false; } }) || '';
};

/**
 * Send one clip and get its text back.
 *
 * `language` is a hint, not a constraint. Whisper detects the language on its
 * own and detects it well, but telling it saves a second of guessing and stops
 * a short Korean clip being read as Japanese — which is the specific mistake
 * it makes when it has three words to go on.
 */
export const transcribe = async (blob, { language = '', model = 'Systran/faster-whisper-small', signal } = {}) => {
  const form = new FormData();
  // The extension matters to some servers, and Opus in a WebM container is
  // what a browser records.
  form.append('file', blob, 'speech.webm');
  form.append('model', model);
  form.append('response_format', 'json');
  if (language) form.append('language', language);

  const res = await fetch(ENDPOINT, { method: 'POST', body: form, signal });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`transcriber returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
  }
  const data = await res.json().catch(() => ({}));
  return String(data.text ?? '').trim();
};

/**
 * The BCP-47 tag the UI uses, as the two-letter code Whisper wants.
 *
 * `zh-Hans` and `zh-Hant` are both `zh` to it: the script is a property of the
 * writing rather than of the speech, and there is nothing to distinguish in
 * the audio.
 */
export const whisperLanguage = (uiLanguage) => {
  const tag = String(uiLanguage || '').toLowerCase();
  if (!tag) return '';
  return tag.split('-')[0];
};

/**
 * Record until told to stop, then transcribe.
 *
 * Returns `{ stop, cancel }`. `stop` ends the recording and resolves with the
 * text; `cancel` throws the clip away. The microphone track is released either
 * way — a page that keeps the recording light on after it has stopped
 * listening is one people stop trusting.
 */
export const recordAndTranscribe = async ({ language = '', model, onError } = {}) => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.addEventListener('dataavailable', (e) => { if (e.data?.size) chunks.push(e.data); });

  const ended = new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }));
  recorder.start();

  const release = () => stream.getTracks().forEach(track => track.stop());

  return {
    stop: async () => {
      if (recorder.state !== 'inactive') recorder.stop();
      await ended;
      release();
      const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
      // A clip this short is a tap on the button, not speech; sending it wastes
      // a round trip to be told the same thing.
      if (blob.size < 1200) return '';
      try {
        return await transcribe(blob, { language, model });
      } catch (e) {
        onError?.(e);
        throw e;
      }
    },
    cancel: () => {
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    },
  };
};
