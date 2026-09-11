import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image as ImageIcon, Film, Sparkles, RefreshCcw, Download, Dices,
  TriangleAlert, Copy, Check, Trash2, Upload, X, Plus, ChevronDown,
  Star, Search, ShieldCheck, ImagePlus, FileImage, Undo2, Square,
} from 'lucide-react';
import './studio.css';
import { copyText } from './clipboard.js';
import { StudioLightbox } from './StudioLightbox.jsx';
import { useI18n } from './i18n.jsx';
import {
  readAll, writeSettings, restoreForm, droppedFrom,
  searchNames, loraLabel, loraFolder,
  readChatPictureModel, writeChatPictureModel, CHAT_PICTURE_MODELS,
} from './studioSettings.js';
import { stampSetting } from './settingsStore.js';
import { JobProgress, useJobStream, previewUrl } from './studioProgress.jsx';
import { TagPrompt } from './TagPrompt.jsx';
import { joinPrompt, hasPrompt, onWeightKey } from './promptTags.js';
import { useSafeguardLevel, useVerdict, Veil } from './SafeImage.jsx';
import { LEVELS, setSafeguardLevel, promptSignal, shouldVeil, strongest } from './safeguard.js';
import { readGenerationInfo } from './pngInfo.js';

/**
 * Making a picture, or a film, on purpose.
 *
 * ## The form is the workflow's own shape
 *
 * Nothing here is hardcoded per model. The server reads each ComfyUI workflow,
 * works out which of its nodes are the prompt, the size, the sampler, the LoRA,
 * and reports that as a set of capabilities; this renders exactly those. So
 * Anima gets a negative-prompt box because its graph has somewhere to put one,
 * and Krea 2 Turbo does not because its negative conditioning is a
 * `ConditioningZeroOut` with no text input at all. A field that goes nowhere is
 * worse than a missing field: it looks like it works.
 *
 * The same is true of the lists. Samplers, schedulers, checkpoints, VAEs and
 * LoRAs all come from the running ComfyUI rather than from a table here, so a
 * model downloaded this morning is selectable this afternoon and a custom
 * sampler pack needs no code change.
 *
 * ## Why the resolution is two number boxes
 *
 * It was a dropdown of presets, which is the wrong control: the presets are
 * somebody's guesses, and the one you want is always the one missing. Any width
 * and height are allowed; the server rounds to the multiple of eight that
 * latents require and says so by showing the rounded number back.
 *
 * ## Why the history is in the browser
 *
 * A generation is expensive and easy to lose. ComfyUI keeps the files, but its
 * history is keyed by ids nobody has written down, so a refresh loses the
 * connection between "that picture" and "the prompt that made it".
 */

const HISTORY_KEY = 'studioHistory';
const MAX_HISTORY = 60;

const isPending = (job) => job.state === 'queued' || job.state === 'running' || job.state === 'starting';

/* How long a job that was still running when the page closed is worth trying
   to pick up again. ComfyUI keeps its history across a browser reload but not
   across its own restart, and a card that has been saying "generating" since
   yesterday is a card that is lying. */
const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Two galleries, as one.
 *
 * What another device sent and what is on screen here are both true: the
 * other device may have finished jobs this one never saw, and this one may be
 * running a job the other has never heard of. So neither replaces the other —
 * every job from both is kept, and where both know a job, the one further
 * along wins, because "done" is never followed by "running".
 */
const PROGRESS = { starting: 0, queued: 1, running: 2, failed: 3, done: 4 };
export const mergeJobs = (here, there) => {
  const byId = new Map(here.map(job => [job.id, job]));
  for (const job of there) {
    const mine = byId.get(job.id);
    if (!mine || (PROGRESS[job.state] ?? 0) > (PROGRESS[mine.state] ?? 0)) byId.set(job.id, job);
  }
  return [...byId.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
};

export const loadHistory = (scope, now = Date.now()) => {
  try {
    const raw = localStorage.getItem(`${HISTORY_KEY}:${scope || 'guest'}`);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      // A job still pending from a previous page load, within the window where
      // ComfyUI might still know about it. `restored` is what tells the poller
      // that one unrecognised answer means gone rather than not-yet-registered.
      .filter(job => !isPending(job) || (now - (job.startedAt || 0)) < RESUME_WINDOW_MS)
      .map(job => (isPending(job) ? { ...job, restored: true } : job));
  } catch (e) {
    return [];
  }
};

export const saveHistory = (scope, jobs) => {
  try {
    /* Finished jobs *and* running ones.
     *
     * Keeping only the finished ones is what lost a generation whenever this
     * panel was unmounted: ComfyUI carried on making the picture, but the card
     * tracking it was never written down, so it did not come back. ComfyUI's
     * own history survives a browser reload and the prompt id stays valid, so
     * a running job is worth saving — it can be picked up exactly where it
     * was.
     *
     * A job that has not been accepted by ComfyUI yet has a `pending-` id that
     * names nothing, so it is the one state not worth keeping. */
    /* Starred pictures are kept past the limit. Starring one is saying "not
       this one", and the limit is for everything nobody said that about. */
    const keep = jobs
      .filter(job => (job.state === 'done' || isPending(job))
        && !String(job.id).startsWith('pending-'))
      .filter((job, i) => i < MAX_HISTORY || job.favorite);
    const key = `${HISTORY_KEY}:${scope || 'guest'}`;
    const next = JSON.stringify(keep);
    // Unchanged is not a write — see `writeSettings` for the loop it prevents.
    if (localStorage.getItem(key) === next) return;
    localStorage.setItem(key, next);
    // Timestamped so the sync engine can tell which device wrote last. Without
    // it the record uploads as older than everything and comes straight back
    // down replaced.
    stampSetting(scope, key);
  } catch (e) { /* quota */ }
};

/** A number with a range, rendered as a slider that says what it is. */
const Range = ({ label, value, min, max, step = 1, onChange, hint }) => (
  <label className="studio-range" title={hint || undefined}>
    <span className="studio-range-label">{label}<b>{value}</b></span>
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={e => onChange(Number(e.target.value))} />
  </label>
);

/** One list from the running ComfyUI. Absent options mean "leave it alone". */
const Picker = ({ label, value, options, onChange, allowNone, noneLabel, wide = false }) => (
  <label className={`studio-field ${wide ? 'is-wide' : ''}`}>
    <span>{label}</span>
    <select className="settings-input" value={value} onChange={e => onChange(e.target.value)}>
      {allowNone && <option value="">{noneLabel}</option>}
      {(options || []).map(option => <option key={option} value={option}>{option}</option>)}
    </select>
  </label>
);

/**
 * A control this workflow does not have, shown as one it does not have.
 *
 * The first version of this panel simply left them out, and that was wrong in a
 * way worth keeping the note for: a missing control and an unbuilt feature look
 * identical. Opening the Studio on the default workflow and finding no negative
 * prompt box reads as "they did not build negative prompts", when the truth is
 * "this model is guidance-distilled and a negative prompt would do nothing".
 *
 * So it is drawn, disabled, with the reason beside it.
 */
const Absent = ({ label, why }) => (
  <label className="studio-field is-absent" title={why}>
    <span>{label}</span>
    <div className="studio-absent">{why}</div>
  </label>
);

/**
 * Settings chosen once, folded, with their values showing.
 *
 * Nine controls of equal weight made the form a wall, and most of them are
 * set once a month: the sampler, the checkpoint, the LoRA stack. Folded, a
 * group still says what it is set to — the summary is the current values — so
 * nothing is hidden, only quiet. Open, the summary steps aside, because the
 * values are then right below it.
 *
 * `<details>` rather than state: it is keyboard- and screen-reader-operable
 * with no code, and a constant `open` prop is only applied on mount, so a
 * group the person closed stays closed across renders.
 */
const Group = ({ label, summary = [], open = false, children }) => (
  <details className="studio-group" open={open}>
    <summary>
      <span className="studio-group-label">{label}</span>
      <span className="studio-group-summary">
        {summary.map((item, i) => <span key={i}>{item}</span>)}
      </span>
      <ChevronDown size={14} className="studio-group-chevron" aria-hidden="true" />
    </summary>
    <div className="studio-group-body">{children}</div>
  </details>
);

/* "1024×1360" as a CSS aspect ratio. A card that already has the shape of the
   picture coming into it does not jump when the picture arrives. */
const ratioOf = (size) => {
  const m = /(\d+)\s*[x×]\s*(\d+)/.exec(String(size || ''));
  return m ? `${m[1]} / ${m[2]}` : '1 / 1';
};

/**
 * A long list, searched rather than scrolled.
 *
 * Two hundred and five LoRAs in a `<select>` is a control with one route to the
 * item you want: scrolling. The native type-ahead does not rescue it, because it
 * matches from the start of the whole string and these names start with a
 * folder — typing "nyte" against `anima\style\NyteTyde.safetensors` matches
 * nothing at all.
 *
 * So it is a text box that filters, and the matching rules live in
 * studioSettings.js next to the names they were written for: separators,
 * extensions and run-together capitals are all punctuation the person typing
 * will leave out.
 */
const SearchPicker = ({ value, options, placeholder, emptyLabel, onChange, t }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const box = useRef(null);

  const hits = useMemo(() => searchNames(options || [], query), [options, query]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => setHighlight(0), [query]);

  const choose = (name) => { onChange(name); setOpen(false); setQuery(''); };

  return (
    <div className="studio-search" ref={box}>
      <button
        type="button"
        className={`studio-search-value ${value ? '' : 'is-empty'}`}
        onClick={() => { setOpen(v => !v); setQuery(''); }}
        title={value || emptyLabel}
      >
        <span>{value ? loraLabel(value) : emptyLabel}</span>
        {value && loraFolder(value) && <em>{loraFolder(value)}</em>}
      </button>

      {open && (
        <div className="studio-search-panel">
          <input
            autoFocus
            type="text"
            className="studio-search-input"
            placeholder={placeholder}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
              if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(i => Math.min(i + 1, hits.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(i => Math.max(i - 1, 0)); }
              if (e.key === 'Enter') { e.preventDefault(); if (hits[highlight]) choose(hits[highlight]); }
            }}
          />
          <div className="studio-search-list">
            {/* Clearing is a choice, so it is in the list rather than being a
                separate control beside it. */}
            {value && (
              <button type="button" className="studio-search-hit is-clear" onClick={() => choose('')}>
                {emptyLabel}
              </button>
            )}
            {hits.length === 0 && <div className="studio-search-none">{t('studio.noMatch')}</div>}
            {hits.map((name, i) => (
              <button
                key={name}
                type="button"
                className={`studio-search-hit ${i === highlight ? 'is-on' : ''} ${name === value ? 'is-chosen' : ''}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => choose(name)}
                title={name}
              >
                <span>{loraLabel(name)}</span>
                {loraFolder(name) && <em>{loraFolder(name)}</em>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * The LoRAs on this generation, as a list.
 *
 * It was one dropdown and one strength slider, which is one LoRA — and one LoRA
 * is not how anyone uses them. They stack: a style, a character, a detailer,
 * each at its own weight, and the weights are the whole craft of it.
 *
 * How many can stack is the workflow's business rather than this component's.
 * Anima loads them through a nine-slot stacker; Krea 2 has a single loader that
 * the server clones and chains. Either way `slots` is the ceiling and the add
 * button stops at it, so the interface never offers a row the graph cannot hold.
 */
const LoraStack = ({ label, rows, options, slots, onChange, t }) => {
  /* Every change is expressed as a function of the current list rather than of
     the list this render happened to close over. Two clicks of Add inside one
     frame both read the same `rows` otherwise, and the second one overwrites
     the first — so three quick clicks added one row. React batches; the fix is
     to stop capturing. */
  const set = (index, patch) =>
    onChange(current => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <div className="studio-loras">
      <span className="studio-loras-label">
        {label}
        <em>{rows.length} / {slots}</em>
      </span>

      {rows.map((row, index) => (
        <div className="studio-lora-row" key={index}>
          <SearchPicker
            value={row.name}
            options={options}
            placeholder={t('studio.searchLora')}
            emptyLabel={t('studio.pickLora')}
            onChange={name => set(index, { name })}
            t={t}
          />
          {/* The weight is the part people actually tune, so it is a number you
              can type rather than a slider you have to aim at. */}
          <input
            type="number"
            className="settings-input studio-lora-weight"
            step="0.05" min="-2" max="2"
            value={row.weight}
            aria-label={t('studio.loraStrength')}
            onChange={e => set(index, { weight: Number(e.target.value) })}
          />
          <button
            type="button"
            className="icon-btn"
            title={t('studio.removeLora')}
            onClick={() => onChange(current => current.filter((_, i) => i !== index))}
          >
            <X size={13} />
          </button>
        </div>
      ))}

      <button
        type="button"
        className="studio-lora-add"
        disabled={rows.length >= slots}
        onClick={() => onChange(current => (current.length >= slots
          ? current
          : [...current, { name: '', weight: 1 }]))}
      >
        <Plus size={13} /> {t('studio.addLora')}
      </button>
    </div>
  );
};

/* The gallery's copy of a picture: ComfyUI's WebP of the same file, about a
   twentieth of the size. The viewer and the download still use the file. */
export const thumbOf = (url) => (String(url || '').startsWith('/studio/view?')
  ? `${url}&preview=${encodeURIComponent('webp;85')}`
  : url);

/* A verdict for a picture whose job may not have been judged yet. See
   safeguard.js: the prompt has its say from the start, and until the picture
   has been looked at, "not yet known" is veiled rather than shown. */
const settleVerdict = (judged, asked) =>
  (judged ? strongest(judged, asked) : (asked === 'explicit' ? 'explicit' : 'pending'));

const SOURCE_LABEL = { a1111: 'AUTOMATIC1111', comfyui: 'ComfyUI', novelai: 'NovelAI' };

/**
 * What a card shows: the progress, the failure, or the picture — behind glass
 * when it should be.
 *
 * The prompt is read the moment the job exists, so the half-denoised preview
 * of a prompt that asked for something explicit is veiled from its first
 * frame. The finished picture is looked at by the classifier once; the answer
 * is kept on the job and syncs with it, so the phone does not look again.
 */
const JobMedia = ({ job, snapshot, lastFrame, level, t, onCancel, onOpen, onJudged }) => {
  const output = (job.outputs || [])[0];
  const picture = job.state === 'done' && output && output.media !== 'video' ? output : null;
  const verdict = useVerdict({
    src: picture?.url || '',
    look: picture ? thumbOf(picture.url) : '',
    prompt: job.prompt,
    known: job.safety?.verdict,
    onJudged,
    level,
  });
  const asked = promptSignal(job.prompt);
  const hidden = picture ? shouldVeil(verdict, level) : shouldVeil(asked, level);

  return (
    <div
      className="studio-job-media"
      style={{
        aspectRatio: ratioOf(job.size),
        // The last preview frame stands in while the file decodes -- but not
        // behind a veiled picture, because it is the same picture.
        ...(job.state === 'done' && lastFrame && !hidden ? { backgroundImage: `url(${lastFrame})` } : {}),
      }}
    >
      {isPending(job) && (
        <JobProgress
          snapshot={snapshot}
          jobId={job.id}
          queuedAhead={job.ahead || 0}
          t={t}
          onCancel={onCancel}
          veil={shouldVeil(asked, level)}
        />
      )}
      {job.state === 'failed' && (
        <div className="studio-job-failed">
          <TriangleAlert size={16} />
          <span>{job.error || t('studio.failed')}</span>
        </div>
      )}
      {job.state === 'done' && (job.outputs || []).map(item => (
        item.media === 'video'
          // A film cannot be classified frame by frame here; its prompt can.
          ? (
            <Veil key={item.url} verdict={asked || 'safe'} level={level} revealKey={item.url} t={t}>
              <video src={item.url} controls loop playsInline />
            </Veil>
          ) : (
            <Veil key={item.url} verdict={verdict} level={level} revealKey={item.url} t={t}>
              {/* A button, so the picture opens from the keyboard as well as
                  by a click. */}
              <button type="button" className="studio-job-open" onClick={onOpen}
                aria-label={t('studio.view.open')} title={t('studio.view.open')}>
                <img src={thumbOf(item.url)} alt={job.prompt} loading="lazy" />
              </button>
            </Veil>
          )
      ))}
    </div>
  );
};

/** The reference picture, small, so it is clear which one is being edited. */
const RefThumb = ({ name, level, t }) => {
  const slash = String(name).lastIndexOf('/');
  const src = `/studio/view?${new URLSearchParams({
    filename: String(name).slice(slash + 1),
    subfolder: slash >= 0 ? String(name).slice(0, slash) : '',
    type: 'input',
  })}`;
  const verdict = useVerdict({ src, look: thumbOf(src), level });
  return (
    <Veil verdict={verdict} level={level} revealKey={src} t={t} compact className="studio-reference-thumb">
      <img src={thumbOf(src)} alt="" />
    </Veil>
  );
};

export const StudioPanel = ({ scope, onAttachToChat }) => {
  const { t } = useI18n();

  const [catalogue, setCatalogue] = useState({ models: [], loading: true, error: '', offline: false });
  const [modelId, setModelId] = useState('');
  const [form, setForm] = useState({});
  const [jobs, setJobs] = useState(() => loadHistory(scope));
  const [copied, setCopied] = useState('');
  const [copyFailed, setCopyFailed] = useState('');
  // The job whose picture is open in the viewer, or null.
  const [viewing, setViewing] = useState(null);
  const level = useSafeguardLevel();
  // The gallery's filters. Not remembered: a search is for now.
  const [query, setQuery] = useState('');
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  /* Settings read out of a PNG, with the form as it was before -- so an
     import that was not what was wanted can be undone as a whole. */
  const [imported, setImported] = useState(null);
  const [importError, setImportError] = useState('');
  const [dragging, setDragging] = useState(false);
  // Which card's picture is being sent to ComfyUI as the reference, and which was.
  const [referencing, setReferencing] = useState('');
  const [referenced, setReferenced] = useState('');
  const importRef = useRef(null);
  /* One press, one job. `generate` is async, the button stays live while the
     request is on its way, and a generation takes minutes -- so a second click
     during the wait used to queue a second picture nobody asked for. */
  const submitting = useRef(false);
  const [queueing, setQueueing] = useState(false);
  const [stopping, setStopping] = useState(false);

  const promptRef = useRef(null);
  const fileRef = useRef(null);
  const pollers = useRef(new Map());

  useEffect(() => setJobs(loadHistory(scope)), [scope]);
  useEffect(() => { saveHistory(scope, jobs); }, [scope, jobs]);

  /* Which workflow draws what the chat asks for. Here, beside the workflows
     themselves, because this is where they are chosen between; it syncs with
     the rest of the Studio's settings. */
  const [chatModel, setChatModel] = useState(() => readChatPictureModel(scope));
  useEffect(() => {
    setChatModel(readChatPictureModel(scope));
    const onSynced = () => setChatModel(readChatPictureModel(scope));
    window.addEventListener('webui:studio-synced', onSynced);
    return () => window.removeEventListener('webui:studio-synced', onSynced);
  }, [scope]);

  /* ------------------------------------------------------------ the models */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/studio/models', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const data = await res.json();
        if (cancelled) return;
        setCatalogue({
          models: data.models || [],
          loading: false,
          error: data.success ? '' : (data.error || ''),
          offline: !!data.offline,
        });
      } catch (e) {
        if (!cancelled) setCatalogue({ models: [], loading: false, error: String(e.message || e), offline: true });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const model = useMemo(
    () => catalogue.models.find(m => m.id === modelId) || catalogue.models[0] || null,
    [catalogue.models, modelId],
  );
  const has = model?.has || {};
  const choices = model?.choices || {};

  /* Why a control this workflow does not have is absent. The server names a
   * reason; anything it has no name for gets the general one, so a workflow
   * added later without a `missing` entry still explains itself. */
  const reasonFor = (control) => {
    const key = model?.missing?.[control];
    return key ? t(`studio.why.${key}`) : t('studio.why.notInWorkflow');
  };

  /* Open a workflow where you left it.
   *
   * Per workflow, not per app: Krea 2 runs at 8 steps and Anima at 40, so one
   * shared set of numbers would be wrong for whichever one you did not set it
   * from. And every saved name is checked against what ComfyUI has *now* — a
   * checkpoint that was renamed last week is not a harmless leftover, it is a
   * generation that fails a minute in on a value the picker still shows as
   * chosen. See src/studioSettings.js. */
  const [dropped, setDropped] = useState(0);

  useEffect(() => {
    if (!model) return;
    const saved = readAll(scope)[model.id];
    setForm(restoreForm(model, saved));
    setDropped(droppedFrom(model, saved));
    setImported(null);
  }, [model?.id, scope, catalogue.models]);   // eslint-disable-line react-hooks/exhaustive-deps

  /* Written on every change rather than on generate: the settings worth keeping
   * are the ones you were in the middle of when the tab was closed, and a save
   * that only happens on success loses exactly those. */
  useEffect(() => {
    if (!model || !form || Object.keys(form).length === 0) return;
    writeSettings(scope, model.id, form);
  }, [scope, model?.id, form]);

  const set = (name, value) => setForm(f => ({ ...f, [name]: value }));

  /* Another device changed the Studio, and the sync has already written it to
     storage — only if it was genuinely newer than anything done here, which
     `applyLocal` now checks. Re-read it in place: the form for the workflow on
     screen, and the gallery merged rather than replaced. This is what used to
     be a whole-page reload. */
  useEffect(() => {
    const onSynced = () => {
      if (model) setForm(restoreForm(model, readAll(scope)[model.id]));
      setJobs(prev => mergeJobs(prev, loadHistory(scope)));
    };
    window.addEventListener('webui:studio-synced', onSynced);
    return () => window.removeEventListener('webui:studio-synced', onSynced);
  }, [model, scope]);

  /* ------------------------------------------------------------- progress

     One stream, not one per job. ComfyUI runs a single prompt at a time
     whatever is queued behind it, so the only job with anything to broadcast
     is the oldest one still pending -- and HTTP/1.1's six-connection budget is
     not something to spend on streams that will stay silent until their turn.
     The rest report their queue position through the polling below, which is
     the honest thing to show a job that has not started.

     A job whose id still begins with `pending-` has not been accepted by
     ComfyUI yet and has no id to subscribe to. */
  const watched = useMemo(() => {
    const waiting = jobs.filter(job => isPending(job) && !String(job.id).startsWith('pending-'));
    return waiting.length ? waiting[waiting.length - 1].id : null;
  }, [jobs]);
  const live = useJobStream(watched);

  /* The last frame of each job, kept after it finishes.
   *
   * The finished picture is a 14MB PNG and takes a moment to arrive, during
   * which the card was an empty grey square -- so the moment a generation
   * succeeded it looked, briefly, like it had produced nothing. The preview
   * frame is already in the browser's cache and is the same picture, so it
   * stands in behind the real one until that decodes. */
  const lastFrame = useRef(new Map());
  useEffect(() => {
    // Not a clip: it stands in as a background image, which a video cannot be.
    if (String(live?.previewMime || '').startsWith('video/')) return;
    if (live?.id && live.previewSeq) lastFrame.current.set(live.id, live.previewSeq);
  }, [live?.id, live?.previewSeq, live?.previewMime]);

  /* -------------------------------------------------------------- polling */

  const stopPolling = useCallback((id) => {
    const handle = pollers.current.get(id);
    if (handle) { clearTimeout(handle); pollers.current.delete(id); }
  }, []);

  const poll = useCallback((id) => {
    const tick = async () => {
      try {
        const data = await (await fetch(`/studio/job?id=${encodeURIComponent(id)}`)).json();
        let lost = false;
        setJobs(prev => prev.map(job => {
          if (job.id !== id) return job;
          /* `unknown` means ComfyUI has never heard of this prompt. For a job
             queued a moment ago that is a race and the next poll settles it;
             for one restored from a previous page load it is the answer —
             ComfyUI has been restarted and the run is gone. Without this the
             card polls a dead id for ever, which is the same picture of
             "generating" that this whole change is meant to stop showing. */
          if (data.state === 'unknown' && job.restored) {
            lost = true;
            return { ...job, state: 'failed', error: t('studio.lost') };
          }
          return {
            ...job,
            state: data.state === 'unknown' ? job.state : (data.state || job.state),
            // Once ComfyUI has answered about it, it is not a restored guess
            // any more.
            restored: data.state === 'unknown' ? job.restored : false,
            ahead: data.ahead,
            outputs: data.outputs || job.outputs,
            error: data.error || job.error,
            finishedAt: data.state === 'done' ? Date.now() : job.finishedAt,
          };
        }));
        if (lost || data.state === 'done' || data.state === 'failed' || data.success === false) {
          stopPolling(id);
          return;
        }
      } catch (e) { /* a dropped poll is not a dropped job */ }
      pollers.current.set(id, setTimeout(tick, 1200));
    };
    pollers.current.set(id, setTimeout(tick, 600));
  }, [stopPolling, t]);

  useEffect(() => () => {
    for (const handle of pollers.current.values()) clearTimeout(handle);
    pollers.current.clear();
  }, []);

  /* Pick up where the last page load left off.
   *
   * A job that was running when the tab was closed is still running in
   * ComfyUI, and its card came back from storage — but nothing was watching
   * it, so it would have sat at "generating" until the page was reloaded
   * again. Runs on every change of profile, because switching accounts loads a
   * different set of jobs.
   *
   * `pollers.current` is what stops this starting a second poller for a job
   * that already has one. */
  /* Keyed on which jobs are pending rather than on `jobs`, which changes on
     every poll tick — this only has anything to do when the set itself
     changes. */
  const pendingIds = jobs
    .filter(job => isPending(job) && !String(job.id).startsWith('pending-'))
    .map(job => job.id)
    .join(',');

  useEffect(() => {
    for (const id of pendingIds.split(',').filter(Boolean)) {
      if (pollers.current.has(id)) continue;
      poll(id);
    }
  }, [pendingIds, poll]);

  /* ------------------------------------------------------------ generating */

  const generate = async () => {
    /* The artist box goes where the workflow can use it. Anima has an artist
       encoder -- `AnimaArtistPack` conditions on each name separately and
       patches the model through cross attention -- and the other two have
       nowhere to put one, so for them the names are folded into the prompt,
       which is what naming an artist means when there is no encoder for it. */
    const foldArtist = !has.artist;
    if (!model || !hasPrompt(form, { foldArtist })) return;
    if (submitting.current) return;
    submitting.current = true;
    setQueueing(true);
    const body = {
      model: model.id,
      prompt: joinPrompt(form, { foldArtist }),
      ...(has.artist ? { artist: (form.artist || '').trim() } : {}),
      ...(has.negative ? { negative: (form.negative || '').trim() } : {}),
      size: `${form.width}x${form.height}`,
      steps: form.steps,
      cfg: form.cfg,
      ...(has.duration ? { duration: form.duration, fps: form.fps } : {}),
      ...(form.sampler ? { sampler: form.sampler } : {}),
      ...(form.scheduler ? { scheduler: form.scheduler } : {}),
      ...(form.model ? { model_file: form.model } : {}),
      ...(form.vae ? { vae: form.vae } : {}),
      ...(form.clip ? { clip: form.clip } : {}),
      // Only the rows that name something. An empty row is a row somebody
      // added and has not filled in yet, not a LoRA called "".
      ...((form.loras || []).some(l => l.name)
        ? { loras: form.loras.filter(l => l.name) }
        : {}),
      ...(form.referenceImage ? { referenceImage: form.referenceImage } : {}),
      /* How much to change it. Without this a reference picture reached the
         image workflows with no strength at all and the server's default was
         the only one there was. */
      ...(form.referenceImage && has.denoise ? { denoise: form.denoise ?? 0.65 } : {}),
    };
    // The checkpoint picker is `model` on the wire too, but `model` is already
    // the workflow's id — so it travels as `model_file` and is renamed here.
    if (body.model_file) { body.modelFile = body.model_file; delete body.model_file; }

    /* One job, queued. Returns the seed it was given, or null. */
    const submitOne = async (request, n) => {
      const pendingId = `pending-${Date.now()}-${n}`;
      setJobs(prev => [{
        id: pendingId, state: 'starting',
        prompt: request.prompt, negative: request.negative,
        /* The four boxes as they were, beside the one string they became. The
           string is what was generated from and what the card shows; the parts
           are what "load these settings back" has to restore, and rebuilding
           them by splitting the string back up would be guesswork. */
        parts: { lead: form.lead || '', artist: form.artist || '', prompt: form.prompt || '', tail: form.tail || '' },
        model: model.id, modelLabel: model.label, kind: model.kind,
        loras: request.loras,
        size: `${form.width}×${form.height}`, steps: form.steps, cfg: form.cfg,
        startedAt: Date.now(),
      }, ...prev]);

      try {
        const data = await (await fetch('/studio/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          /* Named, so the server can tell a retry from a second job. A browser
             re-sends a POST on its own when the connection it reused was
             already closed, and it does that after the server has read the
             first one -- which is one press and two pictures. */
          body: JSON.stringify({ ...request, requestId: `${pendingId}-${Math.random().toString(36).slice(2, 10)}` }),
        })).json();

        if (!data.success) {
          setJobs(prev => prev.map(job => (job.id === pendingId
            ? { ...job, state: 'failed', error: data.error || 'Generation failed' } : job)));
          return null;
        }
        setJobs(prev => prev.map(job => (job.id === pendingId
          ? { ...job, id: data.id, state: 'queued', seed: data.seed, warnings: data.warnings } : job)));
        poll(data.id);
        return data.seed;
      } catch (e) {
        setJobs(prev => prev.map(job => (job.id === pendingId
          ? { ...job, state: 'failed', error: String(e.message || e) } : job)));
        return null;
      }
    };

    /* A batch is the same request N times, each its own job with its own
       seed: a new one each time, or -- with the seed locked -- counting up
       from it, so a batch made from a locked seed can be made again exactly.
       Queued one after another, so they come back in the order asked for. */
    const count = Math.min(8, Math.max(1, Math.round(Number(form.batch) || 1)));
    const locked = form.lockSeed && form.seed !== '';
    let lastSeed = null;
    try {
      for (let n = 0; n < count; n++) {
        const request = locked ? { ...body, seed: Number(form.seed) + n } : body;
        const got = await submitOne(request, n);
        if (got !== null && got !== undefined) lastSeed = got;
      }
    } finally {
      submitting.current = false;
      setQueueing(false);
    }
    // Blank means a new one each time, which is what the lock is for.
    if (!form.lockSeed && lastSeed !== null) set('seed', String(lastSeed));
  };

  const askToStop = (payload) => fetch('/studio/cancel', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }).then(r => r.json()).catch(() => ({ success: false }));

  const cancel = async (id) => {
    stopPolling(id);
    setJobs(prev => prev.map(job => (job.id === id ? { ...job, state: 'failed', error: t('studio.cancelled') } : job)));
    await askToStop({ id });
  };

  /* Everything, including whatever is waiting behind it.
   *
   * Stopping the running job alone is not stopping: ComfyUI starts the next
   * prompt the instant the current one ends, so the GPU never goes quiet and
   * from the outside nothing was cancelled at all. This clears the queue and
   * then interrupts, and the server takes the models out of VRAM once there
   * is nothing left to run. */
  const stopEverything = async () => {
    setStopping(true);
    const pending = jobs.filter(isPending).map(job => job.id);
    for (const id of pending) stopPolling(id);
    setJobs(prev => prev.map(job => (isPending(job)
      ? { ...job, state: 'failed', error: t('studio.cancelled') } : job)));
    try {
      await askToStop({ all: true });
    } finally {
      setStopping(false);
    }
  };

  /** A reference image, uploaded into ComfyUI so a workflow can load it. */
  const pickReference = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const data = new FormData();
    data.append('image', file, file.name);
    try {
      const res = await fetch('/studio/upload', { method: 'POST', body: data });
      const out = await res.json();
      if (out.success) set('referenceImage', out.name);
    } catch (e) { /* the field simply stays empty */ }
  };

  /**
   * A booru post, as a prompt.
   *
   * The tags land in the main box and the artists in the artist box, because
   * that is where each of them belongs and the site already tells us which is
   * which -- danbooru returns them categorised. The gelbooru family returns one
   * flat list with the artists mixed in unmarked, so `artists` comes back empty
   * and everything goes to the main box rather than being guessed at.
   *
   * Appended rather than replacing. Pasting a second reference should add to
   * what is there; somebody who wanted a fresh start can clear the box, and
   * somebody who did not cannot un-destroy the prompt they had written.
   */
  const fillFromBooru = async (url) => {
    const data = await fetch(`/studio/booru?url=${encodeURIComponent(url)}`)
      .then(r => r.json())
      .catch(e => ({ success: false, error: String(e.message || e) }));
    if (!data?.success) return data;

    const add = (existing, addition) => {
      const before = String(existing || '').trim().replace(/[,\s]+$/, '');
      if (!addition) return before;
      return before ? `${before}, ${addition}` : addition;
    };

    setForm(f => ({
      ...f,
      prompt: add(f.prompt, data.prompt),
      // The artist box is on screen for every workflow -- what differs is where
      // it goes on the way out, which is `generate`'s problem and not this
      // one's. So the artists always land in it, and only an empty list is a
      // reason to leave the box alone.
      ...(data.artists ? { artist: add(f.artist, data.artists) } : {}),
    }));
    return data;
  };

  const reuse = (job) => {
    setModelId(job.model);
    setForm(f => ({
      ...f,
      /* The parts where the job kept them, and the whole string in the main box
         where it did not -- a job from before this existed, or one loaded from
         saved history. Dropping it into `prompt` is right either way: it is the
         box the subject belongs in, and the other three are empty. */
      ...(job.parts || { lead: '', artist: '', prompt: job.prompt, tail: '' }),
      negative: job.negative || '',
      ...(job.loras ? { loras: job.loras } : {}),
      ...(job.seed !== undefined ? { seed: String(job.seed), lockSeed: true } : {}),
    }));
    promptRef.current?.focus();
  };

  /* Through `copyText`, not `navigator.clipboard`. The clipboard API only
     exists on HTTPS or localhost, and this app is opened over plain HTTP by a
     LAN address or a nip.io name — so the button threw on `undefined`, the
     catch swallowed it, and nothing happened at all. `copyText` falls back to
     the older path that does work there, and says whether it did; a copy that
     failed shows a warning instead of a tick that lies. */
  const copyPrompt = async (job) => {
    if (await copyText(job.prompt)) {
      setCopied(job.id);
      setTimeout(() => setCopied(''), 1500);
    } else {
      setCopyFailed(job.id);
      setTimeout(() => setCopyFailed(''), 2500);
    }
  };

  const forget = (id) => { stopPolling(id); setJobs(prev => prev.filter(job => job.id !== id)); };

  const toggleFavorite = (id) =>
    setJobs(prev => prev.map(job => (job.id === id ? { ...job, favorite: !job.favorite } : job)));

  /* The classifier's answer, kept on the job -- so it is saved, synced, and
     never asked again for the same picture. */
  const judge = (id) => ({ verdict, scores }) => setJobs(prev => prev.map(job => (
    job.id === id && job.safety?.verdict !== verdict ? { ...job, safety: { verdict, scores } } : job)));

  /* "Change this one": the finished picture, handed back to ComfyUI as the
     reference for the next generation. The file is already on ComfyUI's
     machine, but in its output folder, and a LoadImage node reads only from
     input -- so it makes the round trip through the browser, as an upload
     would. */
  const takeAsReference = async (job) => {
    const output = (job.outputs || [])[0];
    if (!output) return;
    setReferencing(job.id);
    try {
      const blob = await (await fetch(output.url)).blob();
      const data = new FormData();
      data.append('image', blob, output.filename || 'reference.png');
      const out = await (await fetch('/studio/upload', { method: 'POST', body: data })).json();
      if (out.success) {
        set('referenceImage', out.name);
        setReferenced(job.id);
        setTimeout(() => setReferenced(''), 1800);
      }
    } catch (e) { /* the field simply stays as it was */ } finally {
      setReferencing('');
    }
  };

  /**
   * The settings a PNG was made with, into the form.
   *
   * The whole prompt goes in the main box and the three around it are
   * cleared: an imported prompt already carries its own quality tags and
   * artists, and keeping this form's would say them twice. Numbers are held to
   * what this workflow allows; a sampler this ComfyUI does not have is left as
   * it was rather than set to something that fails. What was applied is said,
   * and the whole import can be undone.
   */
  const importFrom = async (file) => {
    setImportError('');
    if (!file) return;
    let info = null;
    try { info = readGenerationInfo(await file.arrayBuffer()); } catch (e) { info = null; }
    if (!info) { setImportError(t('studio.importNone')); return; }

    const clamp = (value, range) => (Array.isArray(range) ? Math.min(range[1], Math.max(range[0], value)) : value);
    const next = { ...form, lead: '', artist: '', tail: '', prompt: info.prompt };
    const applied = [t('studio.main')];
    if (has.negative && typeof info.negative === 'string') { next.negative = info.negative; applied.push(t('studio.negative')); }
    if (has.steps && info.steps) { next.steps = clamp(Math.round(info.steps), model?.ranges?.steps); applied.push(t('studio.steps')); }
    if (has.cfg && info.cfg) { next.cfg = clamp(info.cfg, model?.ranges?.cfg); applied.push(t('studio.cfg')); }
    if (has.width && info.width && info.height) { next.width = info.width; next.height = info.height; applied.push(t('studio.size')); }
    if (has.sampler && info.sampler && (choices.sampler || []).includes(info.sampler)) {
      next.sampler = info.sampler; applied.push(t('studio.sampler'));
    }
    if (has.scheduler && info.scheduler && (choices.scheduler || []).includes(info.scheduler)) {
      next.scheduler = info.scheduler; applied.push(t('studio.scheduler'));
    }
    if (info.seed !== undefined) { next.seed = String(info.seed); next.lockSeed = true; applied.push(t('studio.seed')); }
    setImported({ source: info.source, applied, before: form });
    setForm(next);
  };

  const dropFiles = (event) => {
    event.preventDefault();
    setDragging(false);
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return;
    const png = files.find(f => /png/i.test(f.type) || /\.png$/i.test(f.name));
    if (png) importFrom(png); else setImportError(t('studio.importNone'));
  };

  /* ------------------------------------------------------------------ view */

  if (catalogue.loading) {
    return <div className="studio-empty"><RefreshCcw size={16} className="spin" /> {t('studio.loading')}</div>;
  }

  const busy = jobs.some(isPending);

  /* Pending jobs are always shown: a picture being made that vanished behind a
     filter would look like one that was never started. */
  const needle = query.trim().toLowerCase();
  const shown = jobs.filter(job => isPending(job) || (
    (!onlyFavorites || job.favorite)
    && (!needle || `${job.prompt || ''} ${job.modelLabel || job.model || ''} ${job.seed ?? ''}`
      .toLowerCase().includes(needle))
  ));
  const canGenerate = !!model && hasPrompt(form, { foldArtist: !has.artist }) && !catalogue.offline;

  /* The canvas on the empty light table: the chosen width and height, fitted
     into a box, so the outline is the actual shape of the picture that is
     about to be made and reshapes as the numbers are typed. */
  const canvasW = Math.max(64, Number(form.width) || model?.defaults?.width || 1024);
  const canvasH = Math.max(64, Number(form.height) || model?.defaults?.height || 1024);
  const fit = Math.min(400 / canvasW, 440 / canvasH);
  const canvasBox = { width: Math.round(canvasW * fit), height: Math.round(canvasH * fit) };

  // What each folded group is set to — its summary line.
  const canvasSummary = [
    has.width && `${canvasW} × ${canvasH}`,
    has.steps && `${form.steps ?? ''} ${t('studio.steps')}`,
    has.cfg && `cfg ${form.cfg ?? ''}`,
    has.duration && `${form.duration ?? ''}s`,
  ].filter(Boolean);
  const samplingSummary = [form.sampler, form.scheduler].filter(Boolean);
  const pickedFiles = [form.model, form.vae, form.clip].filter(Boolean).map(loraLabel);
  const modelSummary = pickedFiles.length ? pickedFiles : [t('studio.asSaved')];
  const loraCount = (form.loras || []).filter(l => l.name).length;

  const quietPart = (key, label, placeholder, note) => (
    <label className="studio-prompt-part is-quiet">
      <span className="studio-sheet-label">
        {label}
        {note && <em>{note}</em>}
      </span>
      <textarea
        className="studio-prompt is-small"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        writingsuggestions="false"
        placeholder={placeholder}
        value={form[key] || ''}
        onChange={e => set(key, e.target.value)}
        onKeyDown={e => onWeightKey(e, v => set(key, v))}
        rows={1}
      />
    </label>
  );

  return (
    <div className="studio">
      {catalogue.offline && (
        <div className="studio-offline">
          <TriangleAlert size={15} />
          <div>
            <div className="studio-offline-title">{t('studio.noBackend')}</div>
            <div className="studio-offline-detail">{catalogue.error}</div>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------- the instruments */}
      {dragging && <div className="studio-drop" aria-hidden="true"><FileImage size={22} />{t('studio.importDrop')}</div>}
      {/* A PNG dropped anywhere on the form loads the settings it was made
          with -- see `importFrom`. */}
      <div
        className={`studio-form ${dragging ? 'is-dropping' : ''}`}
        onDragOver={(e) => {
          if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); setDragging(true); }
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
        onDrop={dropFiles}
      >
        <div className="studio-form-body">
          <div className="studio-models" role="tablist">
            {catalogue.models.map(entry => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                className={`studio-model ${model?.id === entry.id ? 'is-on' : ''}`}
                aria-pressed={model?.id === entry.id}
                aria-selected={model?.id === entry.id}
                onClick={() => setModelId(entry.id)}
                title={entry.note || entry.label}
              >
                {entry.kind === 'video' ? <Film size={14} /> : <ImageIcon size={14} />}
                <span>{entry.label}</span>
              </button>
            ))}
          </div>

          <label className="studio-chat-model">
            <span>{t('studio.chatModel')}</span>
            <select
              value={chatModel}
              onChange={(e) => { setChatModel(e.target.value); writeChatPictureModel(scope, e.target.value); }}
            >
              {CHAT_PICTURE_MODELS.map(id => (
                <option key={id} value={id}>
                  {id === 'auto'
                    ? t('studio.chatModelAuto')
                    : (catalogue.models.find(m => m.id === id)?.label || id)}
                </option>
              ))}
            </select>
          </label>

          {model?.note && <p className="studio-note">{model.note}</p>}
          {/* Said once, because a setting that quietly vanished is worse than
              one that says it did. */}
          {dropped > 0 && (
            <div className="studio-dropped">{t('studio.dropped', { count: dropped })}</div>
          )}
          {model?.licence && <div className="studio-licence" title={model.licence}>{model.licence}</div>}

          {/* One sheet, four rows, in the order they are sent.
           *
           * They were four separate boxes that looked alike, which hid the one
           * thing that matters about them: these models read a prompt by
           * position, and the boxes are joined top to bottom. As rows of one
           * sheet they read as one prompt in four parts. The subject is the
           * row with the room, the completion and the paste-a-link; the other
           * three grow only as far as their text. */}
          <div className="studio-sheet studio-prompt-stack">
            {quietPart('lead', t('studio.lead'), t('studio.leadPlaceholder'))}
            {quietPart('artist', t('studio.artist'), t('studio.artistPlaceholder'),
              has.artist ? t('studio.artistEncoded') : t('studio.artistFolded'))}
            <label className="studio-prompt-part is-main">
              <span className="studio-sheet-label">{t('studio.main')}</span>
              <TagPrompt
                value={form.prompt || ''}
                onChange={v => set('prompt', v)}
                placeholder={t('studio.promptPlaceholder')}
                rows={6}
                t={t}
                complete
                onBooru={fillFromBooru}
                onSubmit={generate}
              />
            </label>
            {quietPart('tail', t('studio.tail'), t('studio.tailPlaceholder'))}
          </div>

          <div className="studio-prompt-tools">
            <input ref={importRef} type="file" accept="image/png" hidden
              onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; importFrom(file); }} />
            <button type="button" className="studio-link" onClick={() => importRef.current?.click()}>
              <FileImage size={13} /> {t('studio.importPng')}
            </button>
            <span className="studio-keys">{t('studio.keysHint')}</span>
          </div>
          {imported && (
            <div className="studio-imported" role="status">
              <span>{t('studio.imported', { source: SOURCE_LABEL[imported.source] || imported.source, fields: imported.applied.join(', ') })}</span>
              <button type="button" className="studio-link" onClick={() => { setForm(imported.before); setImported(null); }}>
                <Undo2 size={13} /> {t('studio.undo')}
              </button>
              <button type="button" className="icon-btn" onClick={() => setImported(null)}
                aria-label={t('studio.view.close')} title={t('studio.view.close')}><X size={12} /></button>
            </div>
          )}
          {importError && <div className="studio-import-error" role="alert">{importError}</div>}

          {/* What must not appear is a different kind of sentence, so it is a
              sheet of its own — or the reason there is none. */}
          {has.negative ? (
            <div className="studio-sheet is-negative">
              <label className="studio-prompt-part is-quiet">
                <span className="studio-sheet-label">{t('studio.negative')}</span>
                <textarea
                  className="studio-prompt is-small studio-negative-box"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  writingsuggestions="false"
                  placeholder={t('studio.negativePlaceholder')}
                  value={form.negative || ''}
                  onChange={e => set('negative', e.target.value)}
                  onKeyDown={e => onWeightKey(e, v => set('negative', v))}
                  rows={2}
                />
              </label>
            </div>
          ) : (
            <p className="studio-absent studio-absent-prompt">
              {t('studio.negative')}: {reasonFor('negative')}
            </p>
          )}

          <div className="studio-groups">
            <Group label={t('studio.group.canvas')} summary={canvasSummary} open>
              {/* Any size, not a list of somebody's favourites. */}
              {has.width && (
                <label className="studio-field studio-size is-wide">
                  <span>{t('studio.size')}</span>
                  <div className="studio-size-row">
                    <input type="number" className="settings-input" min="64" max="4096" step="8"
                      aria-label={t('studio.size')}
                      value={form.width || 0} onChange={e => set('width', Number(e.target.value))} />
                    <em>×</em>
                    <input type="number" className="settings-input" min="64" max="4096" step="8"
                      aria-label={t('studio.size')}
                      value={form.height || 0} onChange={e => set('height', Number(e.target.value))} />
                    <button type="button" className="icon-btn" title={t('studio.swap')} aria-label={t('studio.swap')}
                      onClick={() => setForm(f => ({ ...f, width: f.height, height: f.width }))}>⇄</button>
                  </div>
                </label>
              )}
              {has.steps && (
                <Range label={t('studio.steps')} value={form.steps ?? 20}
                  min={model.ranges?.steps?.[0] ?? 1} max={model.ranges?.steps?.[1] ?? 60}
                  onChange={v => set('steps', v)} hint={t('studio.stepsHelp')} />
              )}
              {has.cfg ? (
                <Range label={t('studio.cfg')} value={form.cfg ?? 5} step={0.1}
                  min={model.ranges?.cfg?.[0] ?? 1} max={model.ranges?.cfg?.[1] ?? 12}
                  onChange={v => set('cfg', v)} hint={t('studio.cfgHelp')} />
              ) : <Absent label={t('studio.cfg')} why={reasonFor('cfg')} />}
              {has.duration ? (
                <Range label={t('studio.seconds')} value={form.duration ?? 5}
                  min={model.ranges?.duration?.[0] ?? 1} max={model.ranges?.duration?.[1] ?? 20}
                  onChange={v => set('duration', v)} hint={t('studio.framesHelp')} />
              ) : <Absent label={t('studio.seconds')} why={reasonFor('duration')} />}
            </Group>

            {(has.sampler || has.scheduler) && (
              <Group label={t('studio.group.sampling')} summary={samplingSummary}>
                {has.sampler && <Picker label={t('studio.sampler')} value={form.sampler || ''}
                  options={choices.sampler} onChange={v => set('sampler', v)} />}
                {has.scheduler && <Picker label={t('studio.scheduler')} value={form.scheduler || ''}
                  options={choices.scheduler} onChange={v => set('scheduler', v)} />}
              </Group>
            )}

            <Group label={t('studio.group.model')} summary={modelSummary}>
              {has.model
                ? <Picker wide label={t('studio.checkpoint')} value={form.model || ''}
                    options={choices.model} onChange={v => set('model', v)} allowNone noneLabel={t('studio.asSaved')} />
                : <Absent label={t('studio.checkpoint')} why={reasonFor('model')} />}
              {has.vae
                ? <Picker wide label={t('studio.vae')} value={form.vae || ''}
                    options={choices.vae} onChange={v => set('vae', v)} allowNone noneLabel={t('studio.asSaved')} />
                : <Absent label={t('studio.vae')} why={reasonFor('vae')} />}
              {has.clip
                ? <Picker wide label={t('studio.clip')} value={form.clip || ''}
                    options={choices.clip} onChange={v => set('clip', v)} allowNone noneLabel={t('studio.asSaved')} />
                : <Absent label={t('studio.clip')} why={reasonFor('clip')} />}
              {!has.lora && <Absent label={t('studio.lora')} why={reasonFor('lora')} />}
            </Group>

            {has.lora && (
              <Group label={t('studio.lora')} summary={[`${loraCount} / ${model?.loraSlots || 1}`]}>
                <LoraStack
                  label={t('studio.lora')}
                  rows={form.loras || []}
                  options={choices.lora}
                  slots={model?.loraSlots || 1}
                  onChange={updater => setForm(f => ({ ...f, loras: updater(f.loras || []) }))}
                  t={t}
                />
              </Group>
            )}

            {/* A reference picture: what the video workflow animates, and what
                the image workflows edit rather than drawing from nothing. */}
            {has.referenceImage && (
              <Group label={t('studio.reference')} summary={form.referenceImage ? [form.referenceImage] : []}
                open={!!form.referenceImage}>
                <div className="studio-reference is-wide">
                  {form.referenceImage && <RefThumb name={form.referenceImage} level={level} t={t} />}
                  <input ref={fileRef} type="file" accept="image/*" onChange={pickReference} hidden />
                  <button type="button" className="studio-upload" onClick={() => fileRef.current?.click()}>
                    <Upload size={13} /> {t('studio.reference')}
                  </button>
                  {form.referenceImage && (
                    <span className="studio-reference-name">
                      {form.referenceImage}
                      <button type="button" className="icon-btn" aria-label={t('studio.removeLora')}
                        onClick={() => set('referenceImage', '')}><X size={12} /></button>
                    </span>
                  )}
                </div>
                {has.denoise && form.referenceImage && (
                  <Range label={t('studio.change')} value={form.denoise ?? 0.65} step={0.05}
                    min={0.1} max={0.9} onChange={v => set('denoise', v)} />
                )}
              </Group>
            )}
          </div>
        </div>

        {/* Always in reach: the one action the panel exists for, with the seed
            beside it because "the same again" and "a new one" are the two
            things asked of it. */}
        <div className="studio-footer">
          <label className="studio-field studio-seed">
            <span className="studio-visually-hidden">{t('studio.seed')}</span>
            <div className="studio-seed-row">
              <input type="text" inputMode="numeric" className="settings-input"
                aria-label={t('studio.seed')}
                placeholder={t('studio.seedRandom')} value={form.seed || ''}
                onChange={e => set('seed', e.target.value.replace(/[^0-9]/g, ''))} />
              <button type="button" className={`icon-btn bordered ${form.lockSeed ? 'toggled' : ''}`}
                aria-pressed={!!form.lockSeed}
                title={form.lockSeed ? t('studio.seedLocked') : t('studio.seedFree')}
                aria-label={form.lockSeed ? t('studio.seedLocked') : t('studio.seedFree')}
                onClick={() => set('lockSeed', !form.lockSeed)}>
                <Dices size={14} />
              </button>
            </div>
          </label>
          <label className="studio-batch" title={t('studio.batch')}>
            <span className="studio-visually-hidden">{t('studio.batch')}</span>
            <select className="settings-input" value={form.batch || 1} aria-label={t('studio.batch')}
              onChange={e => set('batch', Number(e.target.value))}>
              {[1, 2, 3, 4, 6, 8].map(n => <option key={n} value={n}>×{n}</option>)}
            </select>
          </label>
          <button type="button" className="studio-go" onClick={generate} disabled={!canGenerate || queueing}>
            {busy || queueing ? <RefreshCcw size={15} className="spin" /> : <Sparkles size={15} />}
            {model?.kind === 'video' ? t('studio.makeVideo') : t('studio.makeImage')}
          </button>
        </div>
      </div>

      {/* --------------------------------------------------- the light table */}
      <section className="studio-table" aria-label={t('studio.title')}>
        {jobs.length === 0 ? (
          <div className="studio-empty">
            <div className="studio-canvas" style={canvasBox}>
              <span className="studio-canvas-size">{canvasW} × {canvasH}</span>
            </div>
            <p className="studio-empty-hint">{t('studio.emptyHint')}</p>
          </div>
        ) : (
          <>
            {/* Finding one again, and deciding what is shown while doing it. */}
            <div className="studio-tools">
              <label className="studio-find">
                <Search size={14} aria-hidden="true" />
                <input type="search" value={query} onChange={e => setQuery(e.target.value)}
                  placeholder={t('studio.find')} aria-label={t('studio.find')} />
              </label>
              <button type="button" className={`studio-tool ${onlyFavorites ? 'is-on' : ''}`}
                aria-pressed={onlyFavorites} onClick={() => setOnlyFavorites(v => !v)}>
                <Star size={14} fill={onlyFavorites ? 'currentColor' : 'none'} aria-hidden="true" />
                <span>{t('studio.favorites')}</span>
              </button>
              {busy && (
                <button type="button" className="studio-tool is-stop" onClick={stopEverything} disabled={stopping}>
                  {stopping ? <RefreshCcw size={14} className="spin" aria-hidden="true" />
                    : <Square size={13} fill="currentColor" aria-hidden="true" />}
                  <span>{t('studio.stopAll', { count: jobs.filter(isPending).length })}</span>
                </button>
              )}
              <label className="studio-tool studio-safe-level" title={t('safe.level')}>
                <ShieldCheck size={14} aria-hidden="true" />
                <select value={level} onChange={e => setSafeguardLevel(e.target.value)} aria-label={t('safe.level')}>
                  {LEVELS.map(value => <option key={value} value={value}>{t(`safe.level.${value}`)}</option>)}
                </select>
              </label>
            </div>

            {shown.length === 0 ? (
              <p className="studio-none">{t('studio.noneMatch')}</p>
            ) : (
              <div className="studio-gallery">
                {shown.map(job => {
                  const output = (job.outputs || [])[0];
                  const picture = job.state === 'done' && output && output.media !== 'video';
                  const frame = lastFrame.current.get(job.id);
                  return (
                    <article key={job.id} className={`studio-job is-${job.state}`}>
                      <JobMedia
                        job={job}
                        snapshot={job.id === watched ? live : null}
                        lastFrame={job.state === 'done' && frame ? previewUrl(job.id, frame) : null}
                        level={level}
                        t={t}
                        onCancel={() => cancel(job.id)}
                        onOpen={() => setViewing(job.id)}
                        onJudged={judge(job.id)}
                      />

                      <div className="studio-job-body">
                        <p className="studio-job-prompt" title={job.prompt}>{job.prompt}</p>
                        <div className="studio-job-meta">
                          {job.favorite && (
                            <Star size={11} className="studio-job-fav" fill="currentColor" aria-label={t('studio.favorites')} />
                          )}
                          <span>{job.modelLabel || job.model}</span>
                          {job.size && <span>{job.size}</span>}
                          {job.seed !== undefined && <span>seed {job.seed}</span>}
                        </div>
                        <div className="studio-job-actions">
                          {job.state === 'done' && (
                            <button type="button" className={`icon-btn ${job.favorite ? 'is-fav' : ''}`}
                              aria-pressed={!!job.favorite}
                              title={job.favorite ? t('studio.unfavorite') : t('studio.favorite')}
                              aria-label={job.favorite ? t('studio.unfavorite') : t('studio.favorite')}
                              onClick={() => toggleFavorite(job.id)}>
                              <Star size={13} fill={job.favorite ? 'currentColor' : 'none'} />
                            </button>
                          )}
                          <button type="button" className="icon-btn" title={t('studio.reuse')} aria-label={t('studio.reuse')} onClick={() => reuse(job)}>
                            <RefreshCcw size={13} />
                          </button>
                          <button type="button" className="icon-btn"
                            title={copyFailed === job.id ? t('studio.copyFailed') : t('studio.copyPrompt')}
                            aria-label={copyFailed === job.id ? t('studio.copyFailed') : t('studio.copyPrompt')}
                            onClick={() => copyPrompt(job)}>
                            {copied === job.id ? <Check size={13} />
                              : copyFailed === job.id ? <TriangleAlert size={13} /> : <Copy size={13} />}
                          </button>
                          {picture && has.referenceImage && (
                            <button type="button" className="icon-btn"
                              title={t('studio.useAsReference')} aria-label={t('studio.useAsReference')}
                              disabled={referencing === job.id} onClick={() => takeAsReference(job)}>
                              {referencing === job.id ? <RefreshCcw size={13} className="spin" />
                                : referenced === job.id ? <Check size={13} /> : <ImagePlus size={13} />}
                            </button>
                          )}
                          {job.state === 'done' && output && (
                            <a className="icon-btn" href={output.url} download={output.filename}
                              title={t('studio.save')} aria-label={t('studio.save')}><Download size={13} /></a>
                          )}
                          {picture && onAttachToChat && (
                            <button type="button" className="icon-btn" title={t('studio.toChat')} aria-label={t('studio.toChat')}
                              onClick={() => onAttachToChat(job)}><ImageIcon size={13} /></button>
                          )}
                          <button type="button" className="icon-btn" title={t('studio.forget')} aria-label={t('studio.forget')} onClick={() => forget(job.id)}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}
      </section>

      {/* The pictures that can be opened, in the order on screen -- filters
          included -- so the arrows walk the same row the eye does. Films play
          in place and are left out. */}
      {viewing && (() => {
        const viewable = shown.filter(job => job.state === 'done'
          && (job.outputs || [])[0] && job.outputs[0].media !== 'video');
        const at = viewable.findIndex(job => job.id === viewing);
        if (at < 0) return null;
        return (
          <StudioLightbox
            items={viewable.map(job => ({
              url: job.outputs[0].url,
              filename: job.outputs[0].filename,
              prompt: job.prompt,
              model: job.modelLabel || job.model,
              size: job.size,
              seed: job.seed,
              verdict: settleVerdict(job.safety?.verdict, promptSignal(job.prompt)),
            }))}
            index={at}
            onIndex={n => setViewing(viewable[n].id)}
            onClose={() => setViewing(null)}
            onCopy={copyText}
            t={t}
          />
        );
      })()}
    </div>
  );
};

export default StudioPanel;
