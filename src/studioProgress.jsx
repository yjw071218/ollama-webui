/**
 * Watching a generation happen.
 *
 * ## Why this exists at all
 *
 * A picture here is ninety seconds of work and a video is several minutes, and
 * for all of it the only thing on screen was a spinner. A spinner is the same
 * shape whether the sampler is on step 3 of 40, whether ComfyUI is loading a
 * twenty-gigabyte checkpoint, or whether the GPU fell over eighty seconds ago —
 * which makes "is this working?" a question the interface cannot answer, and
 * the honest response to it was to reload the page and lose the job.
 *
 * ComfyUI knows all of it and says so on a websocket. `server/comfyEvents.js`
 * listens and re-broadcasts; this is the browser half.
 *
 * ## Additive, on purpose
 *
 * The stream carries progress and nothing else. Whether a job *finished*, and
 * what it produced, still comes from `/studio/job` polling exactly as before —
 * so a browser that cannot open an EventSource, a ComfyUI too old to broadcast,
 * or a proxy that eats server-sent events all degrade to what the app did
 * yesterday rather than to a job that never completes. Nothing here is on the
 * path between asking for a picture and getting one.
 *
 * ## One stream, not one per job
 *
 * HTTP/1.1 allows six connections per origin and this app already spends one
 * on live sync. ComfyUI runs one prompt at a time regardless of how many are
 * queued, so the panel opens a stream for the *oldest* pending job — the one
 * actually being worked on — and the rest report their queue position through
 * the polling that was already happening.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Download, Wand2, Sparkles, Aperture, Maximize2, ScanFace, Film, Save, Loader2,
  Eye, Image as ImageIcon, SlidersHorizontal,
} from 'lucide-react';
/* The arithmetic lives next door, in a file with no React in it -- see
   `jobProgress.js`. Re-exported so callers have one import for the feature. */
import {
  previewUrl, formatDuration, remainingMs, phaseLabel, isClip, frameRatio, promptExcerpt,
} from './jobProgress.js';

export { previewUrl, formatDuration, remainingMs, phaseLabel, isClip, frameRatio, promptExcerpt };

/**
 * Subscribe to one job's progress.
 *
 * Returns the latest snapshot, or null while there is nothing to say. The
 * stream is closed the moment the job ends, because an EventSource left open
 * reconnects for ever against a route that will never speak again.
 */
export const useJobStream = (id) => {
  const [snapshot, setSnapshot] = useState(null);
  const startedAt = useRef(0);

  useEffect(() => {
    setSnapshot(null);
    if (!id || typeof EventSource === 'undefined') return undefined;

    startedAt.current = Date.now();
    let source;
    try { source = new EventSource(`/studio/events?id=${encodeURIComponent(id)}`); } catch (e) { return undefined; }

    const onMessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch (e) { return; }
      if (data?.id !== id) return;
      setSnapshot(data);
      if (data.state === 'done' || data.state === 'failed') source.close();
    };
    source.addEventListener('message', onMessage);
    // Errors are not reported: EventSource retries on its own, and a stream
    // that never opens is a progress bar that does not appear, which is the
    // intended degradation rather than something to tell anybody about.
    return () => { source.removeEventListener('message', onMessage); source.close(); };
  }, [id]);

  return snapshot;
};

/* What each stage looks like.
 *
 * A stage told only in words is a stage you have to read. These are the eight
 * the server can report, and they are distinct enough at 13px to be told apart
 * without reading — which is the entire job of an icon on a card somebody is
 * glancing at while waiting. */
const PHASE_ICONS = {
  loading: Download,
  prompt: Wand2,
  sampling: Sparkles,
  decoding: Aperture,
  detailing: ScanFace,
  upscaling: Maximize2,
  video: Film,
  saving: Save,
};

const PhaseIcon = ({ phase, size = 13 }) => {
  const Icon = PHASE_ICONS[phase] || Loader2;
  return <Icon size={size} className={PHASE_ICONS[phase] ? '' : 'spin'} />;
};

/**
 * The whole pipeline, and where in it this job is.
 *
 * A percentage cannot say what is left to *happen*, and in these workflows that
 * is most of what a reader wants: 89% with an upscaler still ahead is a minute
 * away, and 89% with only the file left to write is seconds. The stages come
 * from the server, read off this particular graph — see `phasesOf` — so a
 * workflow with no face detailer never shows one greyed out for ever.
 */
export const PhaseTrack = ({ phases, phase, state, t }) => {
  if (!phases?.length) return null;
  const here = phases.indexOf(phase);
  const finished = state === 'done';

  return (
    <ol className="studio-phases" aria-label={t('studio.phase.working')}>
      {phases.map((name, i) => {
        // Anything before the current stage has happened. Compared by position
        // rather than by remembering what has been seen, because ComfyUI runs
        // loaders lazily and interleaves them with the work that needs them.
        const done = finished || (here >= 0 && i < here);
        const now = !finished && i === here;
        return (
          /* Icons only. The name of the current stage is on the line directly
             below this one, and having it in both places made the card repeat
             itself in the two lines a reader looks at first. Each icon carries
             its name as a tooltip, which is where a name belongs when the
             thing it names is a 12px glyph. */
          <li
            key={name}
            className={`studio-phase ${done ? 'is-done' : ''} ${now ? 'is-now' : ''}`}
            title={phaseLabel(name, t)}
          >
            <PhaseIcon phase={name} size={12} />
          </li>
        );
      })}
    </ol>
  );
};

/**
 * A clock that runs on its own.
 *
 * Elapsed time cannot come from the stream. A job sitting in ComfyUI's queue
 * behind another one produces no messages at all, so anything derived from the
 * last message freezes -- which is how a perfectly healthy queued job came to
 * read "0:00" for fourteen minutes, the single most alarming thing a progress
 * card can do. And it cannot come from the server's clock either: that is a
 * different machine's idea of now, and a phone an hour out would be told the
 * job started in the future.
 *
 * So it is measured here, from when this card first appeared, and it ticks.
 */
const useElapsed = (active) => {
  const [, tick] = useState(0);
  const since = useRef(Date.now());

  useEffect(() => {
    if (!active) return undefined;
    const beat = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(beat);
  }, [active]);

  /* Read at render rather than captured in the timer, so the timer is only one
     of the things that can move it. A browser throttles intervals in a page it
     is not painting -- to once a minute in a background tab -- and a clock that
     froze whenever the tab did would be wrong exactly when a progress message
     had just arrived to prove it was not. This way any re-render is also a
     tick, and the interval only covers the gaps between them. */
  return active ? Date.now() - since.current : 0;
};

/**
 * The frame as it develops, one layer over the last.
 *
 * Each new frame is laid over the one on screen and faded in once it has
 * actually loaded, and only then is the old one taken away. Swapping the `src`
 * on a single element blanks it for as long as the next frame takes to arrive
 * -- a flicker several times a second for a picture, and for a clip a black
 * card at every step while the new MP4 loads.
 *
 * Clips share one clock. Each step's clip is the same few seconds of video,
 * denoised a little further, and starting every one from frame zero makes the
 * motion jump back to the beginning every few seconds. So a new clip is sought
 * to where the clock says playback has got to, and shown only once that frame
 * is decoded -- the way KJNodes' own widget does it.
 */
const PreviewLayers = ({ src, clip, alt, onMeasure }) => {
  const [layers, setLayers] = useState([]);
  const timers = useRef(new Set());
  const clock = useRef(0);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  useEffect(() => {
    if (!src) return;
    setLayers(prev => (prev.some(layer => layer.src === src)
      ? prev
      /* The frame on screen stays under the new one; a frame still loading
         when a newer one arrives is abandoned, so a slow connection shows
         fewer steps rather than falling further and further behind. */
      : [...prev.filter(layer => layer.ready).slice(-1), { src, clip, ready: false }]));
  }, [src, clip]);

  const later = (fn, ms) => {
    const timer = setTimeout(() => { timers.current.delete(timer); fn(); }, ms);
    timers.current.add(timer);
  };

  const promote = (layer, element) => {
    const width = element.naturalWidth || element.videoWidth;
    const height = element.naturalHeight || element.videoHeight;
    if (width && height) onMeasure?.(width / height);
    setLayers(prev => prev.map(l => (l.src === layer.src ? { ...l, ready: true } : l)));
    // The one underneath goes once this one has finished fading in over it.
    later(() => setLayers(prev => {
      const at = prev.findIndex(l => l.src === layer.src);
      return at > 0 ? prev.slice(at) : prev;
    }), 480);
  };

  const loadedClip = (layer, element) => {
    if (!clock.current) clock.current = performance.now();
    let done = false;
    const show = () => { if (!done) { done = true; promote(layer, element); } };
    const length = element.duration;
    try {
      if (Number.isFinite(length) && length > 0) {
        element.addEventListener('seeked', show, { once: true });
        element.currentTime = ((performance.now() - clock.current) / 1000) % length;
        // A seek that never reports back must not leave the old clip up for ever.
        later(show, 600);
      } else show();
    } catch (e) { show(); }
    element.play?.()?.catch?.(() => { /* autoplay refused; the frame still shows */ });
  };

  // A frame that fails to load is dropped, and the one before it stays.
  const drop = (layer) => setLayers(prev => prev.filter(l => l.src !== layer.src));

  return layers.map(layer => (layer.clip ? (
    <video
      key={layer.src}
      /* Set on the element as well as in JSX: React does not reflect `muted`
         to the attribute, and a browser autoplays only a muted video. */
      ref={(node) => { if (node) node.muted = true; }}
      className={`studio-progress-layer ${layer.ready ? 'is-ready' : ''}`}
      src={layer.src}
      muted
      loop
      autoPlay
      playsInline
      disablePictureInPicture
      preload="auto"
      aria-label={alt}
      onLoadedData={(e) => loadedClip(layer, e.currentTarget)}
      onError={() => drop(layer)}
    />
  ) : (
    <img
      key={layer.src}
      className={`studio-progress-layer ${layer.ready ? 'is-ready' : ''}`}
      src={layer.src}
      alt={alt}
      onLoad={(e) => promote(layer, e.currentTarget)}
      onError={() => drop(layer)}
    />
  )));
};

/* What kind of job a card is about. Said at the top of the card in a
   conversation, where it is one of several things an answer can be doing. */
const KINDS = {
  image: { Icon: ImageIcon, key: 'studio.kind.image' },
  video: { Icon: Film, key: 'studio.kind.video' },
  edit: { Icon: SlidersHorizontal, key: 'studio.kind.edit' },
};

/**
 * The picture as it is being drawn, and everything known about how it is going.
 *
 * `compact` is the version that goes in a conversation, where the generation is
 * one part of an answer rather than the subject of the screen. It says what is
 * being made and from what prompt, keeps a frame the shape of the result from
 * the first second, and puts the numbers under the picture rather than over it.
 *
 * The rest are for that version: `kind` (image, video or edit), `prompt`,
 * `aspect` (width over height, as asked for -- the first frame corrects it),
 * `source` (the picture being worked from, shown until there is a frame), and
 * `batch` (`{ n, of, made }` when several pictures were asked for at once).
 */
export const JobProgress = ({
  snapshot, jobId, t, onCancel, compact = false, queuedAhead = 0, veil = false,
  kind = 'image', prompt = '', aspect = null, source = null, batch = null,
}) => {
  /* `veil`: the prompt asked for something the safeguard hides, so the frames
     are frosted until someone chooses to watch. Per card, and not remembered. */
  const [peek, setPeek] = useState(false);
  const [measured, setMeasured] = useState(null);
  const veiled = veil && !peek;
  const state = snapshot?.state;
  const fraction = typeof snapshot?.fraction === 'number' ? snapshot.fraction : null;
  const preview = previewUrl(jobId, snapshot?.previewSeq);
  const elapsedMs = useElapsed(state !== 'done' && state !== 'failed');
  const left = remainingMs(fraction, elapsedMs);

  /* The last frame is kept across a phase that produces none. Sampling emits
     previews and upscaling does not, so without this the picture appears, then
     vanishes for the minute that follows — which reads as something going
     wrong at exactly the point where nothing is. */
  const held = useRef(null);
  if (preview) held.current = { src: preview, clip: isClip(snapshot?.previewMime) };
  const shown = held.current;

  const heading = state === 'failed'
    ? (snapshot?.error || t('studio.failed'))
    : (!state || state === 'queued')
      ? (queuedAhead > 0 ? t('studio.queuedBehind', { count: queuedAhead }) : t('studio.state.queued'))
      : phaseLabel(snapshot.phase, t);

  const Kind = KINDS[kind] || KINDS.image;
  const excerpt = compact ? promptExcerpt(prompt) : '';
  const ratio = frameRatio(measured, aspect, kind === 'video');
  const steps = snapshot?.steps > 0 ? `${snapshot.step}/${snapshot.steps}` : '';

  const frame = (shown || compact) && (
    <div className={`studio-progress-frame ${veiled ? 'is-veiled' : ''} ${shown ? '' : 'is-empty'}`}>
      {shown ? (
        <PreviewLayers src={shown.src} clip={shown.clip} alt={t('studio.previewAlt')} onMeasure={setMeasured} />
      ) : (
        /* Before the first frame. The space keeps the shape of what is
           coming, so the conversation does not jump when it lands -- and
           when there is a picture being worked from, it is that picture,
           because "loading the model" over an empty box for a minute reads
           as a card that failed to load. */
        <>
          {source && <img className="studio-progress-source" src={source} alt="" />}
          <div className="studio-progress-waiting">
            <PhaseIcon phase={snapshot?.phase} size={compact ? 22 : 20} />
          </div>
        </>
      )}
      {/* Named, because a half-finished picture that is not labelled as one
          is a finished picture that came out badly. */}
      {shown && (
        <span className="studio-progress-tag">
          <span className="studio-progress-dot" />
          {t('studio.preview')}
          {compact && steps && <span className="studio-progress-tag-steps">{steps}</span>}
        </span>
      )}
      {veiled && (shown || source) && (
        <button type="button" className="safe-veil-show is-floating" onClick={() => setPeek(true)}>
          <Eye size={13} /> {t('safe.show')}
        </button>
      )}
    </div>
  );

  const body = (
    <div className="studio-progress-body">
      <PhaseTrack phases={snapshot?.phases} phase={snapshot?.phase} state={state} t={t} />

      <div className="studio-progress-head">
        <span className="studio-progress-phase">
          {state !== 'failed' && <PhaseIcon phase={snapshot?.phase} />}
          {heading}
        </span>
        {steps && (
          <span className="studio-progress-steps">
            {snapshot.step}<span className="studio-progress-of">/</span>{snapshot.steps}
          </span>
        )}
      </div>

      <div
        className={`studio-progress-bar ${fraction === null ? 'is-unknown' : ''}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(fraction === null ? {} : { 'aria-valuenow': Math.round(fraction * 100) })}
        aria-label={heading}
      >
        <span style={fraction === null ? undefined : { width: `${Math.max(2, fraction * 100)}%` }} />
      </div>

      {/* Three figures, and they are the three that change: how far, how
          long so far, how long left. The node count used to be here too and
          was the first thing to be squeezed off the line -- it is the least
          useful of the four to somebody watching a picture appear, so it
          moved into the title where it costs no width. */}
      <div
        className="studio-progress-meta"
        title={snapshot?.nodesTotal > 0
          ? `${t('studio.stepsOf', { done: snapshot.nodesDone, total: snapshot.nodesTotal })}`
            + `${snapshot.nodeClass ? ` · ${snapshot.nodeClass}` : ''}`
          : undefined}
      >
        {fraction !== null && <b className="studio-progress-pct">{Math.round(fraction * 100)}%</b>}
        {elapsedMs > 0 && <span>{formatDuration(elapsedMs)}</span>}
        {left !== null && <span className="studio-progress-left">{t('studio.remaining', { time: formatDuration(left) })}</span>}
      </div>
    </div>
  );

  if (compact) {
    const made = (batch?.made || []).filter(Boolean);
    return (
      <div
        className={`studio-progress is-compact is-${state || 'queued'} is-kind-${kind}`}
        style={{ '--ar': ratio }}
      >
        <div className="studio-progress-top">
          <span className="studio-progress-kind">
            <Kind.Icon size={14} />
            {t(Kind.key)}
            {batch?.of > 1 && <span className="studio-progress-count">{batch.n}/{batch.of}</span>}
          </span>
          {excerpt && <span className="studio-progress-prompt" title={prompt}>{excerpt}</span>}
        </div>
        {frame}
        {body}
        {/* The pictures of this batch already made, so the wait for the
            third is not a wait with nothing to show for the first two. */}
        {made.length > 0 && (
          <div className={`studio-progress-made ${veiled ? 'is-veiled' : ''}`}>
            {made.map((url, n) => <img key={n} src={url} alt="" />)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`studio-progress is-${state || 'queued'}`}>
      {frame || (
        <div className="studio-progress-waiting">
          <PhaseIcon phase={snapshot?.phase} size={20} />
        </div>
      )}

      {onCancel && (
        <button
          type="button"
          className="studio-progress-stop"
          onClick={onCancel}
          title={t('studio.stop')}
          aria-label={t('studio.stop')}
        >
          <span aria-hidden="true">×</span>
        </button>
      )}

      {body}
    </div>
  );
};
