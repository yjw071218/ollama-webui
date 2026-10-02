import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image as ImageIcon, Film, Sparkles, RefreshCcw, Download, Dices,
  TriangleAlert, Copy, Check, Trash2, Upload, X, Plus, ChevronDown,
  Star, Search, ShieldCheck, ImagePlus, FileImage, Undo2, Square,
  MoreHorizontal, Scaling, Eraser, Clapperboard, Grid3x3, LayoutGrid, Maximize2, Wand2, Share2,
  Bookmark, BookmarkPlus, Plus as PlusIcon, ListOrdered, Contrast,
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
import { stampSetting, getSetting } from './settingsStore.js';
import { JobProgress, useJobStream, previewUrl, FailureNote } from './studioProgress.jsx';
import { TagPrompt } from './TagPrompt.jsx';
import { joinPrompt, hasPrompt, onWeightKey } from './promptTags.js';
import { applyMonochrome, monochromeParts } from './monochrome.js';
import {
  DESCRIBE_PROMPT, tagsFromFrames, readDescription, composePrompt,
  isDescribable, imageOnClipboard,
} from './describeImage.js';
import { segmentPlan } from './videoPrompt.js';
import { useSafeguardLevel, useVerdict, useVideoVerdict, Veil } from './SafeImage.jsx';
import { videoFileOf } from './videoSafety.js';
import { pictureFileOf } from './pictureSafety.js';
import { LEVELS, setSafeguardLevel, promptSignal, shouldVeil, strongest } from './safeguard.js';
import {
  MODES, setRetouchMode, INSPECT_PROMPT, readVerdict, retouchPlan, retouchPrompt, RETOUCH_DENOISE,
  regionLabel,
} from './retouch.js';
import { blobToDataUrl } from './pictureTools.js';
import {
  loadStudioPresets, saveStudioPresets, withPreset, withoutPreset,
  applyPreset, presetValues, isEmptyPreset, matchingPreset,
} from './studioPresets.js';
import { axesFor, axisRange, sweepJobs, sweepValues } from './sweep.js';
import {
  GUIDE_STRENGTH, MASK_GROW_SCALE, getInpaintTuning, setInpaintTuning, inpaintFields, asFactor,
} from './inpaint.js';
import { readGenerationInfo } from './pngInfo.js';
import { readJson } from './jsonFetch.js';
import { CharacterLab } from './CharacterLab.jsx';
import {
  stackWith, stackWithout, promptWith, loadCharacters, saveCharacters,
} from './characters.js';
import { keptOutputs } from './galleryItems.js';
import {
  ASPECT_PRESETS, presetSize, matchPreset, ratioGlyph, megapixels, pictureOutput, opRequest, opJobFrom,
  viewableOf, readDensity, writeDensity, justFinished, parseJobSize, mergeJobs, trimJobs, MAX_HISTORY,
} from './studioTools.js';

/* The page's own title, for putting back after a finished job has been seen.
   Read at load, before anything has marked it -- see App.jsx, which does the
   same for a chat answer. */
const PAGE_TITLE = typeof document !== 'undefined' ? document.title : '';

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

const isPending = (job) => job.state === 'queued' || job.state === 'running' || job.state === 'starting';

/* How long a job that was still running when the page closed is worth trying
   to pick up again. ComfyUI keeps its history across a browser reload but not
   across its own restart, and a card that has been saying "generating" since
   yesterday is a card that is lying. */
const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Two galleries, as one.
 *
 * Both galleries are true at once; see `mergeJobs` in studioTools.js, which is
 * where this went so that the sync can do the same merge as it writes, without
 * this panel having to be on screen for it to happen.
 */
export { mergeJobs };

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
      .map(job => (isPending(job) ? { ...job, restored: true } : job))
      // Kept before the server knew better: each picture three times, two of
      // them in a temp folder that is gone by now. See `keptOutputs`.
      .map(job => (Array.isArray(job.outputs) ? { ...job, outputs: keptOutputs(job.outputs) } : job));
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
    // Held to the limit, with the starred ones kept past it -- see `trimJobs`.
    const kept = trimJobs(jobs.filter(job => (job.state === 'done' || isPending(job))
      && !String(job.id).startsWith('pending-')));
    const key = `${HISTORY_KEY}:${scope || 'guest'}`;
    /* Each job carries when it last changed, because each is a record of its
       own on the wire and a record with no timestamp cannot win or lose a
       conflict. `startedAt` will not do: a job is starred, or finishes, long
       after it started, and the other device's copy has to lose to that.
       Stamped only where something really changed, so a save that rewrites an
       unchanged list does not make every job look new to every device. */
    let was = new Map();
    try {
      const prev = JSON.parse(localStorage.getItem(key) || '[]');
      if (Array.isArray(prev)) was = new Map(prev.filter(Boolean).map(job => [String(job.id), job]));
    } catch (e) { /* nothing to compare against, so everything is new */ }
    // Compared without the stamp, or the stamp would make every job differ
    // from itself. Rest-destructured rather than overwritten, so two jobs that
    // differ only in whether they *have* a stamp still compare equal.
    const bare = (job) => { const { savedAt, ...rest } = job || {}; return JSON.stringify(rest); };
    const now = Date.now();
    const keep = kept.map((job) => {
      const before = was.get(String(job.id));
      return before && bare(before) === bare(job)
        ? { ...job, savedAt: before.savedAt ?? job.savedAt ?? now }
        : { ...job, savedAt: now };
    });
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
const Range = ({ label, value, min, max, step = 1, onChange, hint, format }) => (
  <label className="studio-range" title={hint || undefined}>
    {/* `format` for a slider whose number is not a quantity: "×1.25" reads as a
        multiplier, where a bare 1.25 reads as 1.25 of something. */}
    <span className="studio-range-label">{label}<b>{format ? format(value) : value}</b></span>
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

/** One thing on or off, drawn like the other fields rather than as a bare box. */
const Switch = ({ label, checked, onChange, hint }) => (
  <label className="studio-field studio-switch" title={hint || undefined}>
    <span>{label}</span>
    <input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)} />
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
  // ComfyUI can return a preview, a video and the saved still in one history
  // entry. The first item is not guaranteed to be the finished picture, so
  // never let result ordering decide what the card displays.
  const output = pictureOutput(job);
  const picture = job.state === 'done' && output ? output : null;
  const film = job.state === 'done' ? (job.outputs || []).find(item => item.media === 'video') : null;
  const verdict = useVerdict({
    src: picture?.url || '',
    look: picture ? thumbOf(picture.url) : '',
    prompt: job.prompt,
    known: job.safety?.verdict,
    // What ComfyUI's tagger reads in the file it wrote -- see pictureSafety.js.
    file: picture ? pictureFileOf({ url: picture.url, filename: picture.filename }) : null,
    onJudged,
    level,
  });
  /* A film is judged by its frames, tagged in ComfyUI -- see videoSafety.js.
     It used to be the prompt alone, because the classifier reads stills. */
  const filmVerdict = useVideoVerdict({
    file: film ? videoFileOf({ url: film.url }) : null,
    prompt: job.prompt,
    known: job.safety?.verdict,
    onJudged,
    level,
    duration: job.duration,
  });
  const asked = promptSignal(job.prompt);
  const hidden = picture ? shouldVeil(verdict, level) : film ? shouldVeil(filmVerdict, level) : shouldVeil(asked, level);

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
          // What the polling heard from ComfyUI's queue -- see JobProgress.
          polledState={job.state}
          t={t}
          onCancel={onCancel}
          veil={shouldVeil(asked, level)}
        />
      )}
      {job.state === 'failed' && (
        <div className="studio-job-failed">
          {/* The same words as the progress card: what went wrong, and
              ComfyUI's own message behind a press. */}
          <FailureNote error={job.error} t={t} />
        </div>
      )}
      {job.state === 'done' && (job.outputs || []).map(item => (
        item.media === 'video'
          ? (
            <Veil key={item.url} verdict={filmVerdict || asked || 'safe'} level={level} revealKey={item.url} t={t}>
              <video src={item.url} controls loop playsInline />
              {/* The player takes every click on the film, so opening it big
                  has a button of its own. */}
              <button type="button" className="studio-job-expand" onClick={onOpen}
                aria-label={t('studio.view.open')} title={t('studio.view.open')}>
                <Maximize2 size={13} />
              </button>
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

/**
 * The rest of what can be done to a picture, behind one button.
 *
 * The corner of a card holds four buttons before it covers the picture it
 * belongs to, and a picture now has nine things that can be done to it. The
 * four done most -- keep, again, copy, save -- stay in the corner; the rest are
 * here, with their names, because "upscale" and "remove background" are not
 * things an icon alone says.
 */
const JobMenu = ({ label, items }) => {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    // Captured, so Escape closes the menu and not the Studio behind it.
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const shown = items.filter(Boolean);
  if (!shown.length) return null;
  return (
    <div className="studio-job-more" ref={box}>
      <button type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={open}
        title={label} aria-label={label} onClick={() => setOpen(v => !v)}>
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="studio-job-menu" role="menu">
          {shown.map(item => (
            <button key={item.key} type="button" role="menuitem"
              className={item.danger ? 'is-danger' : ''} disabled={item.busy}
              onClick={() => { setOpen(false); item.onClick(); }}>
              {item.busy ? <RefreshCcw size={14} className="spin" /> : item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
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

/* A prompt with one tag taken out of it.
 *
 * `promptWith` puts the trigger in; this is the other direction, for switching
 * a character off. Only the exact tag goes: a prompt that happens to contain
 * the word inside a longer tag is not a prompt that named the character, and
 * rewriting somebody's words further than they asked is worse than leaving a
 * stray tag behind. */
const withoutTrigger = (prompt, trigger) => {
  const word = String(trigger || '').trim().toLowerCase();
  if (!word) return prompt;
  return String(prompt || '')
    .split(',')
    .map(tag => tag.trim())
    .filter(tag => tag && tag.toLowerCase() !== word)
    .join(', ');
};

/* The same two shapes as the chat side; see `postJson` in src/App.jsx.
   `panelJson` turns a body that is not JSON into a sentence, and `quietJson`
   lets the job poll shrug one off and ask again. */
const panelJson = (response) => readJson(response, 'The picture server');

const quietJson = (url, init) => fetch(url, init)
  .then(r => r.text())
  .then((text) => { try { return JSON.parse(text); } catch (e) { return null; } });

export const StudioPanel = ({
  scope, onAttachToChat, onSharePicture,
  retouchMode = 'off', onRetouchMode, inspectModel = '',
  /* Whether the panel is the thing on screen. It stays mounted once opened --
     see `studio-place`, which hides it rather than unmounting it, so switching
     back to it is free -- and anything that polls has to know the difference
     between "open" and "merely still here". */
  open = true,
}) => {
  const { t } = useI18n();
  // The server's note is English; the app's own words for it, where it has them.
  const noteFor = (entry) => {
    if (!entry?.note) return '';
    const key = `studio.note.${entry.id}`;
    const said = t(key);
    return said === key ? entry.note : said;
  };

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
  // How big the cards are -- this screen's choice, see studioTools.js.
  const [density, setDensityState] = useState(readDensity);
  const setDensity = (value) => { setDensityState(value); writeDensity(value); };
  // Which picture is being post-processed, as `${jobId}:${op}`.
  const [operating, setOperating] = useState('');
  // A line saying what just happened, when the next move is the reader's.
  const [notice, setNotice] = useState('');
  /* A reference to set on the workflow being switched to. Switching reloads
     that workflow's saved form, which never keeps a reference -- so it waits
     here and is put in after. */
  const pendingReference = useRef(null);
  /* The check, as the running poll sees it. `checkFinished` is started from an
     effect and settles minutes later, so the value it closed over would be the
     one from the render that started it. */
  const retouchRef = useRef(retouchMode);
  retouchRef.current = retouchMode;
  /* Prompt blocks kept by name -- see src/studioPresets.js. An account
     setting, like the sampling presets and the personas it is modelled on, so
     a character written on a phone is there on the desktop. */
  const [presets, setPresetsState] = useState(() => loadStudioPresets(scope));
  /* Who this install has been taught to draw. Kept here rather than in the
     lab below, because the folded group's summary needs it too. */
  const [characters, setCharacters] = useState(() => loadCharacters(scope));
  const [naming, setNaming] = useState('');
  // Which setting a batch walks across, or '' for the ordinary same-prompt
  // batch. Not remembered: a sweep is a question asked once. See src/sweep.js.
  const [sweepAxis, setSweepAxis] = useState('');
  const [presetName, setPresetName] = useState('');
  useEffect(() => setPresetsState(loadStudioPresets(scope)), [scope]);
  /* Re-read on a sync as well as on a change of account: a character trained
     on the desktop should appear on the phone without a reload, which is what
     the Studio's other lists already do. */
  useEffect(() => {
    setCharacters(loadCharacters(scope));
    const onSynced = () => setCharacters(loadCharacters(scope));
    window.addEventListener('webui:studio-synced', onSynced);
    return () => window.removeEventListener('webui:studio-synced', onSynced);
  }, [scope]);
  const keepCharacters = useCallback((next) => {
    setCharacters(next);
    saveCharacters(scope, next);
  }, [scope]);
  const persistPresets = (next) => {
    setPresetsState(next);
    saveStudioPresets(scope, next);
  };

  /* The two dials a region edit cannot measure for you -- see src/inpaint.js.
     Held here because this is where they are turned; they are an account
     setting, so a redraw asked for in a chat is made with the same two. */
  const [tuning, setTuningState] = useState(getInpaintTuning);
  const setTuning = (patch) => {
    setInpaintTuning(patch);
    // Read back rather than merged in: the store rounds to the slider's step,
    // and what is shown has to be what was written down and what is sent.
    setTuningState(getInpaintTuning());
  };
  // Which finished picture is being looked at, and the ones already looked at.
  const [inspecting, setInspecting] = useState('');
  const inspected = useRef(new Set());

  const promptRef = useRef(null);
  const fileRef = useRef(null);
  const poseFileRef = useRef(null);
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

  /* What a batch may be walked across here. The two region dials are offered
     only when there is a region for them to act on -- without one they change
     nothing, and a sweep of eight identical pictures is the worst possible
     answer to "what does this setting do". See src/sweep.js. */
  /* What a long clip will actually be rendered as. One definition, shared with
     the server -- see segmentPlan in src/videoPrompt.js. */
  const segments = segmentPlan(form.duration ?? model?.defaults?.duration ?? 5);

  const sweepable = {
    has,
    hasReference: !!form.referenceImage,
    region: !!form.referenceImage && !!String(form.region || '').trim(),
  };

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
    const restored = restoreForm(model, saved);
    if (pendingReference.current && model.has?.referenceImage) {
      restored.referenceImage = pendingReference.current;
      pendingReference.current = null;
    }
    setForm(restored);
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
      setPresetsState(loadStudioPresets(scope));
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
        const data = await quietJson(`/studio/job?id=${encodeURIComponent(id)}`);
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
            outputs: data.outputs ? keptOutputs(data.outputs) : job.outputs,
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

  /* Finished while nobody was looking.
   *
   * A video is minutes, and nobody watches it; the tab's title says it is
   * done, with how many, and a warning sign instead of a tick when one failed.
   * The title only, for the reason App.jsx gives for a chat answer: a
   * notification needs a permission prompt, and asking for one is how a page
   * teaches people to press Block. Cleared when the tab is looked at. */
  const lastJobs = useRef(jobs);
  const unseen = useRef({ count: 0, failed: false });
  useEffect(() => {
    const finished = justFinished(lastJobs.current, jobs);
    lastJobs.current = jobs;
    /* Looked at before anything else is done about it. Whether the tab is in
       front makes no difference to whether a hand came back with six fingers,
       and the title below is only for a tab that is not. */
    checkFinished(finished);
    if (!finished.length || typeof document === 'undefined' || !document.hidden) return;
    unseen.current = {
      count: unseen.current.count + finished.length,
      failed: unseen.current.failed || finished.some(job => job.state === 'failed'),
    };
    document.title = `${unseen.current.failed ? '⚠️' : '✅'} (${unseen.current.count}) ${PAGE_TITLE}`;
  }, [jobs]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden || !unseen.current.count) return;
      unseen.current = { count: 0, failed: false };
      document.title = PAGE_TITLE;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  /* ------------------------------------------------------------ generating */

  const generate = async () => {
    /* The artist box goes into the prompt, and also to the encoder where the
       workflow has one.
       *
       * It used to go to one or the other: Anima has `AnimaArtistPack`, which
       * conditions on each name separately and patches the model through cross
       * attention, so the names were sent only there -- and the prompt, and the
       * settings recorded beside the picture, never said who it was drawn like.
       * Folding them in as well is what makes the prompt describe itself.
       *
       * For Anima that means the artists now act twice, as tokens and through
       * cross attention. That is stronger than before, and deliberate. */
    const foldArtist = true;
    if (!model || !hasPrompt(form, { foldArtist })) return;
    if (submitting.current) return;
    submitting.current = true;
    setQueueing(true);
    setNotice('');
    /* Black and white is applied box by box -- see src/monochrome.js -- on the
       way out, so the boxes themselves keep what was typed. */
    const mono = !!form.monochrome && model.kind === 'image';
    const parts = mono ? { ...form, ...monochromeParts(form) } : form;
    let body = {
      model: model.id,
      prompt: joinPrompt(parts, { foldArtist }),
      ...(has.artist ? { artist: (parts.artist || '').trim() } : {}),
      ...(has.negative ? { negative: (form.negative || '').trim() } : {}),
      size: `${form.width}x${form.height}`,
      steps: form.steps,
      cfg: form.cfg,
      ...(has.duration ? { duration: form.duration, fps: form.fps } : {}),
      ...(has.loop && form.loop ? { loop: true } : {}),
      ...(has.cut && form.cut && !form.loop ? { cut: true, transition: form.transition === 'none' ? 'none' : 'fade' } : {}),
      ...(has.upscale && form.upscale ? { upscale: true } : {}),
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
      /* Redraw only this part of it, as the chat has always been able to ask.
         SAM3 finds it from the word and everything outside is kept pixel for
         pixel -- see `applyRegionEdit` on the server. Honor gentle strengths
         so repairing details does not replace the character. */
      ...(form.referenceImage && String(form.region || '').trim()
        ? { region: String(form.region).trim(), denoise: Math.min(1, Math.max(0.1, form.denoise ?? 0.65)) }
        : {}),
      // See src/inpaint.js: nothing where neither dial has been moved.
      ...(form.referenceImage ? inpaintFields() : {}),
      /* Draw in the pose of this picture. See applyPoseGuide on the server. */
      ...(has.pose && form.poseImage ? {
        poseImage: form.poseImage,
        poseStrength: form.poseStrength ?? 1,
        poseDetect: form.poseDetect !== false,
      } : {}),
    };
    // The checkpoint picker is `model` on the wire too, but `model` is already
    // the workflow's id — so it travels as `model_file` and is renamed here.
    if (body.model_file) { body.modelFile = body.model_file; delete body.model_file; }

    /* And the rest of black and white: the negative, and the style LoRAs,
       which are the reason it needs a switch at all -- see src/monochrome.js
       for what was measured. */
    if (mono) body = applyMonochrome(body, { characterLoras: characters.map(one => one.lora) });

    /* One job, queued. Returns the seed it was given, or null. */
    const submitOne = async (request, n, sweep = null) => {
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
        /* What the stack was before the switch took the style LoRAs out, so
           loading this back and switching it off gets them back. */
        ...(mono ? { monochrome: true, formLoras: (form.loras || []).filter(l => l.name) } : {}),
        size: `${form.width}×${form.height}`,
        // What this one actually ran at, which for a sweep is not what the
        // form says: the card has to name the value it is showing.
        steps: request.steps ?? form.steps,
        cfg: request.cfg ?? form.cfg,
        // Which of the sweep this is, for the badge on the card.
        ...(sweep ? { sweep } : {}),
        // A clip's length, so its frames are tagged across the whole of it.
        ...(request.duration ? { duration: request.duration } : {}),
        /* A picture made from a picture is compared against it in the viewer.
           The reference is in ComfyUI's input folder, where it was uploaded
           to be worked from. Not for a film: a clip is not laid over a still. */
        ...(request.referenceImage && model.kind === 'image'
          ? { before: `/studio/view?${new URLSearchParams({ filename: request.referenceImage, type: 'input' })}` }
          : {}),
        startedAt: Date.now(),
      }, ...prev]);

      try {
        const data = await panelJson(await fetch('/studio/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          /* Named, so the server can tell a retry from a second job. A browser
             re-sends a POST on its own when the connection it reused was
             already closed, and it does that after the server has read the
             first one -- which is one press and two pictures. */
          body: JSON.stringify({
            ...request,
            requestId: `${pendingId}-${Math.random().toString(36).slice(2, 10)}`,
            // The named lists `__poses__` draws from; see src/wildcards.js.
            wildcards: getSetting('wildcards') || '',
          }),
        }));

        if (!data.success) {
          setJobs(prev => prev.map(job => (job.id === pendingId
            ? { ...job, state: 'failed', error: data.error || 'Generation failed' } : job)));
          return null;
        }
        setJobs(prev => prev.map(job => (job.id === pendingId
          ? {
            ...job, id: data.id, state: 'queued', seed: data.seed, warnings: data.warnings,
            /* What was drawn, when a wildcard chose or the tag list corrected --
               `parts` keeps the template as it was typed, for loading back. */
            ...(data.prompt ? { prompt: data.prompt } : {}),
          } : job)));
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
      /* A sweep, rather than a batch: one setting moved a step at a time with
         everything else -- the seed above all -- held still. Two pictures that
         differ in their seed differ everywhere, so a sweep whose seed moved
         would cost eight generations and teach nothing. The seed is pinned to
         whatever is in the box, or to one chosen here and written back, so the
         whole row can be made again. See src/sweep.js. */
      const axis = sweepAxis ? axesFor(sweepable).find(a => a.id === sweepAxis) : null;
      const range = axis ? axisRange(axis, model?.ranges || {}) : null;
      const runs = axis && range
        ? sweepJobs({ axis, range, count, seed: locked ? Number(form.seed) : Math.floor(Math.random() * 2 ** 47) })
        : [];
      if (runs.length) {
        for (let n = 0; n < runs.length; n++) {
          const got = await submitOne({ ...body, ...runs[n].patch }, n, {
            axis: axis.id, value: runs[n].value, of: runs.length, at: n + 1,
          });
          if (got !== null && got !== undefined) lastSeed = got;
        }
        // The seed the row was made at, so it can be swept again along another
        // axis and compared against this one.
        if (runs[0]) { set('seed', String(runs[0].seed)); set('lockSeed', true); }
        return;
      }
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
    setQueue(prev => prev.filter(item => item.id !== id));
  };

  /* Everything ComfyUI has been asked to do, in the order it will do it.
   *
   * This panel has always known about the jobs *this browser* started. It knew
   * nothing about the picture the chat is drawing, nothing about what another
   * device queued, and nothing about the order -- one job's card said how many
   * were in front of it, and that was the whole of it. So the machine could be
   * busy for half an hour on work with no card anywhere, and the only cancel
   * that could be trusted was the one that stopped everything.
   *
   * ComfyUI's own queue is the list. What each id *is* comes from this server,
   * and only for the account that queued it -- somebody else's job is in the
   * list because it is in front of yours, with nothing said about what it is.
   * See `/studio/queue`. */
  const [queue, setQueue] = useState([]);
  useEffect(() => {
    if (!open) return undefined;
    let stopped = false;
    const look = async () => {
      const answer = await fetch('/studio/queue', { cache: 'no-store' })
        .then(r => r.json()).catch(() => null);
      if (stopped || !answer?.success) return;
      setQueue(answer.jobs || []);
    };
    look();
    // Slower than a progress bar on purpose: this is the shape of the wait, not
    // the wait itself, and it changes only when a job starts or finishes.
    const timer = setInterval(look, 2500);
    return () => { stopped = true; clearInterval(timer); };
  }, [open]);

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

  /* ------------------------------------------- a picture, read back as a prompt

     "Make me one like this" is the commonest thing anybody wants from a
     reference, and nothing here could hear it: every other use of a reference
     hands ComfyUI a file for a workflow to *redraw*. See src/describeImage.js
     for why the tags come from the tagger and the sentence from a vision
     model, and why neither can do the other's half. */
  const [describing, setDescribing] = useState(null);   // { stage } while it runs
  const [describeError, setDescribeError] = useState('');
  const describeRef = useRef(null);
  const describeFileRef = useRef(null);

  /* The tags, from ComfyUI's tagger, by pointing it at the file just uploaded.
     `/studio/picture-tags` is the same route the safeguard uses to ask what is
     in a finished picture: it waits for the answer, keeps it per file, and
     runs one job however many callers ask at once. An uploaded reference lands
     in ComfyUI's `input/`, which is one of the folders that route accepts. */
  const tagUploaded = async (uploaded, signal) => {
    const res = await fetch('/studio/picture-tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: uploaded.filename,
        subfolder: uploaded.subfolder || '',
        type: uploaded.type || 'input',
      }),
      signal,
    });
    const data = await panelJson(res);
    if (!data?.success) throw new Error(data?.error || t('describe.taggerFailed'));
    return tagsFromFrames(data.frames);
  };

  /* And the sentence, from whichever model can see -- the same one the retouch
     check uses, chosen once in App.jsx. Never fatal: the tags are the more
     valuable half and a vision model that is absent, slow or confused must not
     cost them. */
  const describeWith = async (base64, signal) => {
    if (!inspectModel) return '';
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: inspectModel,
          messages: [{ role: 'user', content: DESCRIBE_PROMPT, images: [base64] }],
          stream: false,
          // Or a reasoning model spends its whole budget deciding how to
          // describe a picture and answers with nothing at all.
          think: false,
          options: { temperature: 0.3, num_predict: 220 },
        }),
      });
      if (!res.ok) return '';
      const data = await res.json();
      return readDescription(data?.message?.content || '');
    } catch (e) {
      return '';
    }
  };

  /**
   * A picture in, a prompt out.
   *
   * The two halves run one after the other rather than together, and that is
   * not an oversight: the tagger is a ComfyUI job and the description is an
   * Ollama one, and this machine takes the language model off the card before
   * ComfyUI is given anything (see server/vram.js). Asking for both at once
   * would be the two of them swapping the card underneath each other.
   *
   * The tagger goes first because it is the half worth having: if the vision
   * model is missing or fails, the tags still land.
   *
   * It replaces the box rather than adding to it. "One like this" is a prompt
   * for *this* picture, and appended to the last one it is two pictures'
   * worth of tags pulling against each other.
   */
  const describeImage = useCallback(async (file, { replace = true } = {}) => {
    if (!file || !isDescribable(file)) return;
    describeRef.current?.abort();
    const controller = new AbortController();
    describeRef.current = controller;
    setDescribeError('');

    try {
      setDescribing({ stage: 'upload' });
      const data = new FormData();
      data.append('image', file, file.name || 'pasted.png');
      const uploaded = await panelJson(
        await fetch('/studio/upload', { method: 'POST', body: data, signal: controller.signal }),
      );
      if (!uploaded?.success) throw new Error(uploaded?.error || t('describe.uploadFailed'));

      setDescribing({ stage: 'tags' });
      const tags = await tagUploaded(uploaded, controller.signal);

      let sentence = '';
      if (inspectModel) {
        setDescribing({ stage: 'describe' });
        const base64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
          reader.onerror = () => resolve('');
          reader.readAsDataURL(file);
        });
        if (base64) sentence = await describeWith(base64, controller.signal);
      }

      if (tags.length === 0 && !sentence) {
        setDescribeError(t('describe.nothing'));
        return;
      }
      setForm(f => ({ ...f, prompt: composePrompt(f.prompt, { tags, sentence }, { replace }) }));
      promptRef.current?.focus();
    } catch (e) {
      if (e.name !== 'AbortError') setDescribeError(String(e.message || e));
    } finally {
      if (describeRef.current === controller) describeRef.current = null;
      setDescribing(null);
    }
  }, [inspectModel, t]);

  useEffect(() => () => describeRef.current?.abort(), []);

  /** A picture chosen with the button, rather than pasted or dropped. */
  const pickDescribe = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) describeImage(file);
  };

  /** A reference image, uploaded into ComfyUI so a workflow can load it. */
  const pickReference = async (event, field = 'referenceImage') => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const data = new FormData();
    data.append('image', file, file.name);
    try {
      const res = await fetch('/studio/upload', { method: 'POST', body: data });
      const out = await res.json();
      if (out.success) set(field, out.name);
    } catch (e) { /* the field simply stays empty */ }
  };

  /**
   * A booru post, as a prompt.
   *
   * The tags land in the main box, and the artists land nowhere.
   *
   * They used to fill the artist box. That box is a standing choice -- the
   * style this install draws in, set once and left alone -- and a pasted
   * reference is about the subject of one picture. Overwriting the style every
   * time somebody pastes a link is not what pasting a link means, and it was
   * silent: the artists of the post replaced the artists being worked with.
   *
   * The server still reports them (`artists`), because knowing who drew the
   * reference is worth having. Nothing writes them into a box.
   *
   * Appended by default: pasting a second reference should add to what is
   * there, and somebody who did not want that cannot un-destroy the prompt
   * they had written.
   *
   * `replace` is the exception, and it is asked for rather than guessed at --
   * the reader selected the whole box before pasting, which is the one gesture
   * that says "this, instead of that" in every text field there has ever been.
   * `rest` is what the link was pasted *after*, when it was pasted after
   * something; the box is holding it while this runs.
   */
  const fillFromBooru = async (url, { replace = false, rest = null } = {}) => {
    const data = await fetch(`/studio/booru?url=${encodeURIComponent(url)}`)
      .then(r => panelJson(r))
      .catch(e => ({ success: false, error: String(e.message || e) }));

    const base = (current) => (rest === null ? String(current || '') : rest);

    if (!data?.success) {
      /* The link is out of the box either way -- `booruLinkIn` took it out
         before this ran -- so a failed fetch has to put back what was around
         it, or the prompt is left short of whatever the reader had typed. */
      if (rest !== null) setForm(f => ({ ...f, prompt: rest }));
      return data;
    }

    const add = (existing, addition) => {
      const before = String(existing || '').trim().replace(/[,\s]+$/, '');
      if (!addition) return before;
      return before ? `${before}, ${addition}` : addition;
    };

    // Only the prompt. The artist box is left exactly as it was, replace or
    // not: it is not part of what was pasted.
    setForm(f => ({
      ...f,
      prompt: replace ? String(data.prompt || '') : add(base(f.prompt), data.prompt),
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
      ...(job.formLoras || job.loras ? { loras: job.formLoras || job.loras } : {}),
      monochrome: !!job.monochrome,
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
  /* Kept on the job and synced with it: a picture's classifier scores, or a
     video's deciding tags -- the frames' own lists stay on the server. */
  /* Which witness said so is kept with the verdict.
   *
   * It used to be enough to know the answer. It is not any more: a verdict
   * from the tagger outranks one from the classifier, so a stored verdict that
   * does not say where it came from cannot be compared with a new one -- and
   * the classifier's answer, written down once, would outlive every correction
   * the tagger made afterwards. */
  const judge = (id) => ({ verdict, scores, tags, by = 'classifier' }) => setJobs(prev => prev.map((job) => {
    if (job.id !== id) return job;
    /* A classifier answer must not overwrite what the tagger already decided.
       `frames` is the tagger as well -- the same node, read a frame at a time
       off a video -- so it outranks the classifier for the same reason. */
    const TAGGED = new Set(['tagger', 'frames']);
    if (TAGGED.has(job.safety?.by) && !TAGGED.has(by)) return job;
    if (job.safety?.verdict === verdict && job.safety?.by === by) return job;
    return {
      ...job,
      safety: { verdict, by, ...(scores ? { scores } : {}), ...(tags ? { tags } : {}) },
    };
  }));

  /* A finished picture, into ComfyUI's input folder. The file is already on
     ComfyUI's machine, but in its output folder, and a LoadImage node reads
     only from input -- so it makes the round trip through the browser, as an
     upload would. Returns the name ComfyUI filed it under, or null. */
  const uploadOutput = async (job) => {
    const output = pictureOutput(job);
    if (!output) return null;
    const blob = await (await fetch(output.url)).blob();
    const data = new FormData();
    data.append('image', blob, output.filename || 'reference.png');
    const out = await panelJson(await fetch('/studio/upload', { method: 'POST', body: data }));
    return out.success ? out.name : null;
  };

  /* "Change this one": the finished picture, as the reference for the next
     generation. */
  const takeAsReference = async (job) => {
    setReferencing(job.id);
    try {
      const name = await uploadOutput(job);
      if (name) {
        set('referenceImage', name);
        setReferenced(job.id);
        setTimeout(() => setReferenced(''), 1800);
      }
    } catch (e) { /* the field simply stays as it was */ } finally {
      setReferencing('');
    }
  };

  const videoWorkflow = catalogue.models.find(entry => entry.kind === 'video') || null;

  /* "Make this move": the picture becomes the video workflow's starting frame,
     the Studio switches to it, and the prompt box is left for the motion --
     which is the one thing only the reader can say. Nothing is queued: a
     video is minutes of GPU, and it is started by the reader, not by this. */
  const animate = async (job) => {
    if (!videoWorkflow) return;
    setOperating(`${job.id}:animate`);
    try {
      const name = await uploadOutput(job);
      if (!name) return;
      if (model?.id === videoWorkflow.id) set('referenceImage', name);
      else { pendingReference.current = name; setModelId(videoWorkflow.id); }
      setNotice(t('studio.op.animateReady'));
    } catch (e) { /* nothing changed */ } finally {
      setOperating('');
    }
  };

  /* Enlarging or cutting out a picture, as a job of its own beside it -- see
     studioTools.js. Watched like a generation, so it has the same progress
     card, and a failure is a failed card saying why rather than nothing. */
  const runOp = async (job, op) => {
    setOperating(`${job.id}:${op}`);
    const label = `${job.modelLabel || job.model || ''} · ${t(`studio.op.${op}`)}`;
    const failed = (error) => setJobs(prev => [
      { ...opJobFrom(job, op, { id: `op-${op}-${Date.now()}`, label }), state: 'failed', error },
      ...prev,
    ]);
    try {
      const image = await uploadOutput(job);
      if (!image) { failed(t('studio.failed')); return; }
      const data = await panelJson(await fetch('/studio/op', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opRequest(job, op, image, `${op}-${job.id}-${Date.now()}`)),
      }));
      if (!data?.success) { failed(data?.error || t('studio.failed')); return; }
      setJobs(prev => [opJobFrom(job, op, { id: data.id, label }), ...prev]);
      poll(data.id);
    } catch (e) {
      failed(String(e.message || e));
    } finally {
      setOperating('');
    }
  };

  /* ------------------------------------------ checking what was drawn

     The same check the chat makes, on the pictures made here: a model that can
     see the picture names the part that came back malformed, from a fixed list
     of nouns, and that part is redrawn inside its own mask. See src/retouch.js.

     The redraw is a job of its own beside the picture it came from, not a
     replacement for it. Both are on the wall, the card carries the original as
     what it is compared against -- so the viewer's bar lays one over the other
     -- and the reader keeps whichever is better by keeping whichever card is
     better. Nothing is decided here that cannot be undone by looking. */

  /** A finished job's picture, as base64, for a model that can look at it. */
  const pictureBytes = async (job) => {
    const output = pictureOutput(job);
    if (!output?.url) return '';
    try {
      const url = await blobToDataUrl(await (await fetch(output.url)).blob());
      return String(url || '').split(',')[1] || '';
    } catch (e) {
      return '';
    }
  };

  /* What the model makes of it. Never throws and never reports a fault it is
     unsure of: a check that fails has to leave the picture exactly as it was,
     because the expensive mistake is redrawing a hand that was fine. */
  const inspectJob = async (job) => {
    const base64 = await pictureBytes(job);
    if (!base64 || !inspectModel) return { ok: true };
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: inspectModel,
          messages: [{ role: 'user', content: INSPECT_PROMPT, images: [base64] }],
          stream: false,
          // Without this a reasoning model spends its whole budget deciding
          // whether a hand is stylised and answers with nothing at all.
          think: false,
          options: { temperature: 0, num_predict: 200 },
        }),
      });
      if (!res.ok) return { ok: true };
      const data = await res.json();
      return readVerdict(data?.message?.content || '');
    } catch (e) {
      return { ok: true };
    }
  };

  /** The part a plan names, redrawn -- as a new job beside the one it came from. */
  const runRetouch = async (job, plan) => {
    /* `pending-` because that prefix is what keeps a card ComfyUI has not
       accepted out of the saved history -- see saveHistory. Without it a
       redraw that never got queued comes back on the next page load as a
       card polling an id that names nothing. */
    const pendingId = `pending-retouch-${job.id}-${Date.now()}`;
    const source = pictureOutput(job);
    const size = parseJobSize(job?.size);
    const failed = (error) => setJobs(prev => prev.map(card => (card.id === pendingId
      ? { ...card, state: 'failed', error } : card)));
    setJobs(prev => [{
      id: pendingId,
      state: 'starting',
      op: 'retouch',
      parent: job.id,
      prompt: job.prompt || '',
      ...(job.negative ? { negative: job.negative } : {}),
      ...(job.parts ? { parts: job.parts } : {}),
      model: job.model,
      modelLabel: `${job.modelLabel || job.model || ''} · ${t('retouch.op')}`,
      kind: 'image',
      size: job.size,
      retouch: { region: plan.region, problem: plan.problem },
      // What it is laid against in the viewer: the picture it redrew part of.
      ...(source?.url ? { before: source.url } : {}),
      startedAt: Date.now(),
    }, ...prev]);
    try {
      const image = await uploadOutput(job);
      if (!image) { failed(t('studio.failed')); return; }
      const data = await panelJson(await fetch('/studio/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: job.model,
          /* The part as it should have been drawn, and nothing else: a region
             edit draws whatever the prompt names *inside the mask*. */
          prompt: retouchPrompt(plan),
          ...(job.negative ? { negative: job.negative } : {}),
          // The size it was sampled at, which is what the reference is brought down to.
          ...(size ? { size: `${size.width}x${size.height}` } : {}),
          referenceImage: image,
          denoise: RETOUCH_DENOISE,
          region: plan.region,
          // The two dials, where either has been moved. See src/inpaint.js.
          ...inpaintFields(),
          requestId: pendingId,
        }),
      }));
      if (!data?.success) { failed(data?.error || t('studio.failed')); return; }
      for (const warning of data.warnings || []) setNotice(warning);
      setJobs(prev => prev.map(card => (card.id === pendingId
        ? { ...card, id: data.id, state: 'queued', seed: data.seed } : card)));
      poll(data.id);
    } catch (e) {
      failed(String(e.message || e));
    }
  };

  /**
   * Every picture that has just finished, checked once.
   *
   * Once: `inspected` remembers the ids, because the jobs list is saved and
   * reloaded and a card that came back from storage has not just finished --
   * it finished yesterday, and checking it again would queue a redraw of a
   * picture the reader has already lived with. A redraw is never checked
   * either; a check of a check is a loop with a GPU in it.
   */
  const checkFinished = async (finished) => {
    if (retouchRef.current === 'off' || !inspectModel) return;
    for (const job of finished) {
      if (job.state !== 'done' || job.op || job.kind !== 'image' || !pictureOutput(job)) continue;
      if (inspected.current.has(job.id)) continue;
      inspected.current.add(job.id);
      setInspecting(job.id);
      try {
        const plan = retouchPlan(await inspectJob(job));
        if (!plan) continue;
        if (retouchRef.current === 'auto') await runRetouch(job, plan);
        else {
          setJobs(prev => prev.map(card => (card.id === job.id
            ? { ...card, retouchOffer: { region: plan.region, problem: plan.problem } } : card)));
        }
      } finally {
        setInspecting('');
      }
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
  /* Returns whether it found anything, because a drop now has somewhere else
     to go when it did not -- see `dropFiles`. It no longer reports "no
     settings in that picture" itself, since that is no longer a dead end. */
  const importFrom = async (file) => {
    setImportError('');
    if (!file) return false;
    let info = null;
    try { info = readGenerationInfo(await file.arrayBuffer()); } catch (e) { info = null; }
    if (!info) return false;

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
    return true;
  };

  /* A picture dropped on the form is one of two quite different requests, and
     the file says which.

     A PNG this app wrote carries the settings it was made with, and dropping
     it means "put me back where that was" -- that is `importFrom`, and it has
     been here for a while. A picture from anywhere else has no such metadata,
     and dropping it can only mean the other thing: describe it. Guessing
     between them is not needed, because trying the import is how you find out;
     it either finds a generation block or it does not. */
  const dropFiles = async (event) => {
    event.preventDefault();
    setDragging(false);
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return;

    const png = files.find(f => /png/i.test(f.type) || /\.png$/i.test(f.name));
    if (png && await importFrom(png)) return;

    const picture = files.find(isDescribable);
    if (picture) describeImage(picture);
    else setImportError(t('studio.importNone'));
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
  /* Which characters are switched on, for the folded group's summary. Matched
     on the LoRA rather than on the trigger: the word can be typed by hand and
     deleted by hand, but the file is either in a slot or it is not. */
  const characterNames = (form.loras || []).map(row => String(row?.name || ''));
  const characterSummary = characters
    .filter(one => characterNames.includes(one.lora))
    .map(one => one.name);
  // Which ratio button the size already is, if any.
  const activeRatio = matchPreset(canvasW, canvasH);

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
                title={noteFor(entry) || entry.label}
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

          {model?.note && <p className="studio-note">{noteFor(model)}</p>}
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
              <span className="studio-sheet-label">
                {t('studio.main')}
                {/* Beside the label rather than under the box: it describes
                    into *this* row, and a button floating under a four-row
                    sheet would not say which row it filled. */}
                <button
                  type="button"
                  className="studio-describe"
                  onClick={() => describeFileRef.current?.click()}
                  disabled={!!describing}
                  title={inspectModel ? t('describe.help') : t('describe.helpNoVision')}
                >
                  {describing
                    ? <RefreshCcw size={11} className="spin" aria-hidden="true" />
                    : <ImagePlus size={11} aria-hidden="true" />}
                  <span>{t('describe.button')}</span>
                </button>
                {/* Black and white, as one press. Beside the picture button
                    because both change what this prompt becomes; only for
                    pictures, since a clip's prompt is sentences. */}
                {model?.kind === 'image' && (
                  <button
                    type="button"
                    className={`studio-describe studio-mono ${form.monochrome ? 'is-on' : ''}`}
                    aria-pressed={!!form.monochrome}
                    onClick={() => set('monochrome', !form.monochrome)}
                    title={t('studio.monoHelp')}
                  >
                    <Contrast size={11} aria-hidden="true" />
                    <span>{form.monochrome ? t('studio.mono') : t('studio.color')}</span>
                  </button>
                )}
              </span>
              <TagPrompt
                value={form.prompt || ''}
                onChange={v => set('prompt', v)}
                placeholder={t('studio.promptPlaceholder')}
                rows={6}
                t={t}
                complete
                onBooru={fillFromBooru}
                onImage={describeImage}
                onSubmit={generate}
              />
              {/* Which half is running, because they are minutes apart in cost:
                  the tagger is a ComfyUI job that can be queued behind a
                  generation, and the description is a language model being put
                  back on a card the tagger just had. A spinner that says
                  nothing for ninety seconds is one people press twice. */}
              {describing && (
                <div className="studio-describe-state">
                  <RefreshCcw size={12} className="spin" aria-hidden="true" />
                  {t(`describe.stage.${describing.stage}`)}
                </div>
              )}
              {describeError && (
                <div className="studio-describe-state is-error">
                  <TriangleAlert size={12} aria-hidden="true" />
                  {describeError}
                </div>
              )}
              <input
                ref={describeFileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/bmp"
                hidden
                onChange={pickDescribe}
              />
            </label>
            {quietPart('tail', t('studio.tail'), t('studio.tailPlaceholder'))}
          </div>

          {/* What black and white will send, box by box. The boxes keep what
              was typed, so without this the switch would change the picture
              and nothing on screen would say how. Only the boxes it changed. */}
          {form.monochrome && model?.kind === 'image' && (() => {
            const sent = monochromeParts(form);
            const rows = [['lead', t('studio.lead')], ['artist', t('studio.artist')], ['prompt', t('studio.main')], ['tail', t('studio.tail')]]
              .filter(([key]) => (sent[key] || '') !== String(form[key] || '').trim());
            return (
              <div className="studio-mono-preview" aria-live="polite">
                <div className="studio-mono-preview-title">
                  <Contrast size={11} aria-hidden="true" />
                  {t('studio.monoSent')}
                </div>
                {rows.map(([key, label]) => (
                  <div key={key} className="studio-mono-preview-row">
                    <span>{label}</span>
                    <code>{sent[key] || t('studio.monoEmpty')}</code>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Prompt blocks, by name.
              *
              * Under the boxes rather than above them, because they are a
              * shortcut for what is in the boxes and not a thing to choose
              * before writing. Loading one replaces what it names and leaves
              * the rest; the `+` adds it to what is already there, which is
              * what a block of quality tags is for. Both, because both are
              * real -- see `applyPreset`. */}
          <div className="studio-presets">
            <div className="studio-preset-chips">
              {presets.map((preset) => {
                const on = matchingPreset(presets, form)?.id === preset.id;
                return (
                  <span key={preset.id} className={`studio-preset ${on ? 'is-on' : ''}`}>
                    <button type="button" className="studio-preset-load"
                      title={t('block.load', { name: preset.name })}
                      onClick={() => setForm(f => applyPreset(f, preset.values, 'replace'))}>
                      <Bookmark size={12} aria-hidden="true" />
                      <span>{preset.name}</span>
                    </button>
                    <button type="button" className="studio-preset-add"
                      title={t('block.add', { name: preset.name })}
                      aria-label={t('block.add', { name: preset.name })}
                      onClick={() => setForm(f => applyPreset(f, preset.values, 'add'))}>
                      <PlusIcon size={11} aria-hidden="true" />
                    </button>
                    <button type="button" className="studio-preset-drop"
                      title={t('block.forget', { name: preset.name })}
                      aria-label={t('block.forget', { name: preset.name })}
                      onClick={() => persistPresets(withoutPreset(presets, preset.id))}>
                      <X size={11} aria-hidden="true" />
                    </button>
                  </span>
                );
              })}
              {naming ? (
                <form
                  className="studio-preset-naming"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = presetName.trim();
                    if (!name) return;
                    persistPresets(withPreset(presets, { name, values: presetValues(form) }));
                    setNaming('');
                    setPresetName('');
                  }}
                >
                  <input
                    autoFocus
                    value={presetName}
                    maxLength={60}
                    placeholder={t('block.namePlaceholder')}
                    aria-label={t('block.namePlaceholder')}
                    onChange={e => setPresetName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') { setNaming(''); setPresetName(''); } }}
                  />
                  <button type="submit" className="studio-link" disabled={!presetName.trim()}>
                    {t('block.save')}
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  className="studio-preset-new"
                  disabled={isEmptyPreset(presetValues(form))}
                  title={isEmptyPreset(presetValues(form)) ? t('block.nothingToSave') : t('block.saveThese')}
                  onClick={() => { setNaming('new'); setPresetName(''); }}
                >
                  <BookmarkPlus size={12} aria-hidden="true" />
                  <span>{t('block.saveThese')}</span>
                </button>
              )}
            </div>
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
          {notice && (
            <div className="studio-imported" role="status">
              <span>{notice}</span>
              <button type="button" className="icon-btn" onClick={() => setNotice('')}
                aria-label={t('studio.view.close')} title={t('studio.view.close')}><X size={12} /></button>
            </div>
          )}

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
              {/* The shape, as a ratio, at the pixel count already chosen --
                  see studioTools.js. Each button draws its own shape. */}
              {has.width && (
                <div className="studio-field studio-ratios is-wide" role="group" aria-label={t('studio.aspect')}>
                  <span>
                    {t('studio.aspect')}
                    <em className="studio-mp">{megapixels(canvasW, canvasH)} MP</em>
                  </span>
                  <div className="studio-ratio-row">
                    {ASPECT_PRESETS.map((preset) => {
                      const on = activeRatio === preset;
                      return (
                        <button key={preset} type="button" className={`studio-ratio ${on ? 'is-on' : ''}`}
                          aria-pressed={on} title={preset}
                          onClick={() => setForm(f => ({
                            ...f,
                            ...presetSize(preset, f.width, f.height, model?.kind === 'video' ? 32 : 16),
                          }))}>
                          <i style={ratioGlyph(preset)} aria-hidden="true" />
                          <span>{preset}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
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
                  min={model.ranges?.duration?.[0] ?? 1}
                  /* Past one pass the clip is rendered as segments, so the
                     ceiling is only as high as the node pack that can join
                     them. Without it, twenty seconds as before. */
                  max={has.longVideo ? (model.ranges?.duration?.[1] ?? 60) : 20}
                  onChange={v => set('duration', v)} hint={t('studio.framesHelp')} />
              ) : <Absent label={t('studio.seconds')} why={reasonFor('duration')} />}
              {/* What a long clip is actually made of. Said plainly, because
                  "six segments of ten seconds" is the fact that explains both
                  the wait and anything odd at a join. */}
              {has.duration && segments.count > 1 && (
                <p className="studio-note">{t('studio.segments', { count: segments.count, seconds: segments.seconds })}</p>
              )}
              {has.loop ? (
                <Switch label={t('studio.loop')} checked={!!form.loop}
                  onChange={v => set('loop', v)} hint={t('studio.loopHelp')} />
              ) : model?.missing?.loop ? (
                /* The workflow can loop, but the node pack that does it is not
                   installed. Said, rather than left out: a switch that is
                   simply absent reads as a feature nobody built. */
                <Absent label={t('studio.loop')} why={reasonFor('loop')} />
              ) : null}
              {/* Shots, cross-faded, rather than one continuous take -- see
                  server/longVideo.js. Only with more than one segment to cut. */}
              {has.cut && segments.count > 1 && !form.loop && (
                <>
                  <Switch label={t('studio.cut')} checked={!!form.cut}
                    onChange={v => set('cut', v)} hint={t('studio.cutHelp')} />
                  {form.cut && (
                    <label className="studio-field">
                      <span>{t('studio.transition')}</span>
                      <select className="settings-input" value={form.transition === 'none' ? 'none' : 'fade'}
                        onChange={e => set('transition', e.target.value)}>
                        <option value="fade">{t('studio.transitionFade')}</option>
                        <option value="none">{t('studio.transitionNone')}</option>
                      </select>
                    </label>
                  )}
                </>
              )}
              {has.upscale && (
                <Switch label={t('studio.upscale')} checked={!!form.upscale}
                  onChange={v => set('upscale', v)} hint={t('studio.upscaleHelp')} />
              )}
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

            {/* Who it has been taught to draw.

                Under the LoRA stack because that is what a character *is* here
                -- a trained file in one of those slots and a word in the
                prompt -- and pressing a card does both of those at once, which
                is the whole point of the card existing. See src/characters.js.

                Only on Anima. What the trainer makes is an Anima LoRA,
                trained against the Anima DiT -- see server/training.js -- and
                a LoRA belongs to the base it was trained on. Offering this
                under Krea 2 Turbo would let somebody spend forty minutes of a
                graphics card on a file that loads into that workflow and does
                nothing, which is the worst way to find out. The LoRA stack
                above is still there for a file they already have. */}
            {has.lora && model?.id === 'anima-base' && (
              <Group label={t('charlab.title')}
                summary={characterSummary}>
                <CharacterLab
                  library={characters}
                  onLibrary={keepCharacters}
                  t={t}
                  level={level}
                  loraOptions={choices.lora}
                  applied={form.loras || []}
                  onApply={(character) => setForm(f => ({
                    ...f,
                    loras: stackWith(f.loras || [], character),
                    prompt: promptWith(character, f.prompt || ''),
                  }))}
                  onRemoveLora={(character) => setForm(f => ({
                    ...f,
                    loras: stackWithout(f.loras || [], character),
                    prompt: withoutTrigger(f.prompt || '', character.trigger),
                  }))}
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
                {/* Only one part of it redrawn -- what the chat has always been
                    able to ask for and this panel could not. A short English
                    noun, because it is handed to SAM3 to find in the picture.
                    Empty is the whole picture, as before. */}
                {has.denoise && form.referenceImage && has.region && (
                  <label className="studio-field is-wide">
                    <span>{t('studio.region')}</span>
                    <input
                      className="settings-input"
                      value={form.region || ''}
                      placeholder={t('studio.regionPlaceholder')}
                      onChange={e => set('region', e.target.value)}
                    />
                  </label>
                )}
              </Group>
            )}

            {/* Another picture's pose, kept while the prompt decides everything
                else. Only where the pose guide is installed; see
                applyPoseGuide in server/workflows.js. */}
            {has.pose && (
              <Group label={t('studio.pose')} summary={form.poseImage ? [form.poseImage] : []}
                open={!!form.poseImage}>
                <p className="studio-note">{t('studio.poseHelp')}</p>
                <div className="studio-reference is-wide">
                  {form.poseImage && <RefThumb name={form.poseImage} level={level} t={t} />}
                  <input ref={poseFileRef} type="file" accept="image/*" hidden
                    onChange={e => pickReference(e, 'poseImage')} />
                  <button type="button" className="studio-upload" onClick={() => poseFileRef.current?.click()}>
                    <Upload size={13} /> {t('studio.pose')}
                  </button>
                  {form.poseImage && (
                    <span className="studio-reference-name">
                      {form.poseImage}
                      <button type="button" className="icon-btn" aria-label={t('studio.removeLora')}
                        onClick={() => set('poseImage', '')}><X size={12} /></button>
                    </span>
                  )}
                </div>
                {form.poseImage && (
                  <>
                    <Range label={t('studio.poseStrength')} value={form.poseStrength ?? 1} step={0.05}
                      min={0.2} max={1.5} onChange={v => set('poseStrength', v)} />
                    {has.poseDetect && (
                      <label className="studio-field is-wide" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
                        <input type="checkbox" checked={form.poseDetect === false}
                          onChange={e => set('poseDetect', !e.target.checked)} />
                        <span>{t('studio.poseIsSkeleton')}</span>
                      </label>
                    )}
                  </>
                )}
              </Group>
            )}

            {/* Redrawing one part of a picture, wherever it is asked for.
                Always here rather than beside the reference picker, because
                these two are not this workflow's settings: they are used by
                the check that fixes a finished picture, by an edit asked for
                in a conversation, and by an area painted over one -- and a
                control that comes and went with the workflow would be a
                control nobody could find twice. Multipliers on what the app
                already measures, so 1 is exactly the behaviour before there
                was a dial. See src/inpaint.js. */}
            <Group
              label={t('inpaint.title')}
              summary={[asFactor(tuning.guideStrength), asFactor(tuning.maskGrowScale)]}
              open={tuning.guideStrength !== GUIDE_STRENGTH.default
                || tuning.maskGrowScale !== MASK_GROW_SCALE.default}
            >
              <p className="studio-note">{t('inpaint.help')}</p>
              <Range
                label={t('inpaint.guide')}
                hint={t('inpaint.guideHelp')}
                format={asFactor}
                value={tuning.guideStrength}
                min={GUIDE_STRENGTH.min} max={GUIDE_STRENGTH.max} step={GUIDE_STRENGTH.step}
                onChange={v => setTuning({ guideStrength: v })}
              />
              <Range
                label={t('inpaint.grow')}
                hint={t('inpaint.growHelp')}
                format={asFactor}
                value={tuning.maskGrowScale}
                min={MASK_GROW_SCALE.min} max={MASK_GROW_SCALE.max} step={MASK_GROW_SCALE.step}
                onChange={v => setTuning({ maskGrowScale: v })}
              />
              <button
                type="button"
                className="studio-upload"
                disabled={tuning.guideStrength === GUIDE_STRENGTH.default
                  && tuning.maskGrowScale === MASK_GROW_SCALE.default}
                onClick={() => setTuning({
                  guideStrength: GUIDE_STRENGTH.default, maskGrowScale: MASK_GROW_SCALE.default,
                })}
              >
                <Undo2 size={13} /> {t('inpaint.reset')}
              </button>
            </Group>
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
          {/* How many, and what they differ by.
              *
              * One control in two parts, not two controls. The second does not
              * sit *beside* the count, it changes what the count means: ×6 is
              * six seeds, and ×6 along Steps is six values of one setting. Read
              * left to right they are a phrase -- "six, of steps" -- which is
              * the only arrangement in which the second is self-explanatory.
              *
              * Both label-free, like the seed beside them: this row is the
              * action row, the accent is spent once on the button at the end
              * of it, and a row of four labelled fields is a form. */}
          <div className={`studio-batch ${sweepAxis ? 'is-sweeping' : ''}`}>
            <select className="settings-input studio-batch-count" value={form.batch || 1}
              title={t('studio.batch')} aria-label={t('studio.batch')}
              onChange={e => set('batch', Number(e.target.value))}>
              {[1, 2, 3, 4, 6, 8].map(n => <option key={n} value={n}>×{n}</option>)}
            </select>
            {axesFor(sweepable).length > 0 && (
              <select
                className="settings-input studio-batch-axis"
                value={sweepAxis}
                title={t('sweep.hint')}
                aria-label={t('sweep.title')}
                onChange={e => setSweepAxis(e.target.value)}
              >
                <option value="">{t('sweep.off')}</option>
                {axesFor(sweepable).map(axis => (
                  <option key={axis.id} value={axis.id}>{t(`sweep.axis.${axis.id}`)}</option>
                ))}
              </select>
            )}
          </div>
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
              <div className="studio-density" role="group" aria-label={t('studio.density')}>
                {[['s', Grid3x3], ['m', LayoutGrid], ['l', Square]].map(([value, Icon]) => (
                  <button key={value} type="button" className={`studio-density-btn ${density === value ? 'is-on' : ''}`}
                    aria-pressed={density === value}
                    title={`${t('studio.density')}: ${t(`studio.density.${value}`)}`}
                    aria-label={`${t('studio.density')}: ${t(`studio.density.${value}`)}`}
                    onClick={() => setDensity(value)}>
                    <Icon size={14} aria-hidden="true" />
                  </button>
                ))}
              </div>
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
              {/* Whether a finished picture is checked for the parts image
                  models get wrong. Here rather than in the app's settings
                  because this is where the pictures are, and it is the same
                  choice for the ones the chat draws -- see src/retouch.js.
                  Without a model that can see a picture it is a setting that
                  would silently do nothing, so it says so instead. */}
              <label
                className="studio-tool studio-safe-level"
                title={inspectModel ? t('retouch.help') : t('retouch.noModel')}
              >
                <Wand2 size={14} aria-hidden="true" />
                <select
                  value={retouchMode}
                  disabled={!inspectModel}
                  onChange={(e) => { setRetouchMode(e.target.value); onRetouchMode?.(e.target.value); }}
                  aria-label={t('retouch.title')}
                >
                  {MODES.map(value => <option key={value} value={value}>{t(`retouch.mode.${value}`)}</option>)}
                </select>
              </label>
            </div>

            {/* What the machine is doing and what it will do next. Only when
                there is something: an empty strip is a permanent reminder that
                nothing is happening. */}
            {queue.length > 0 && (
              <div className="studio-queue" aria-label={t('studio.queue')}>
                <span className="studio-queue-title">
                  <ListOrdered size={13} aria-hidden="true" />
                  {t('studio.queue')}
                </span>
                {queue.map(item => (
                  <span key={item.id} className={`studio-queue-item is-${item.state}`}>
                    <b>{item.state === 'running' ? t('studio.state.running') : `${item.ahead + 1}`}</b>
                    {/* A job of another account's is in the list because it is
                        in front of this one. What it is drawing is not said. */}
                    <span className="studio-queue-what" title={item.mine ? item.prompt : undefined}>
                      {item.mine ? (item.prompt || t(`studio.kind.${item.kind || 'image'}`)) : t('studio.queueOther')}
                    </span>
                    {item.mine && (
                      <button type="button" className="icon-btn" onClick={() => cancel(item.id)}
                        title={t('studio.stop')} aria-label={`${t('studio.stop')}: ${item.prompt || item.id}`}>
                        <Square size={10} fill="currentColor" aria-hidden="true" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}

            {shown.length === 0 ? (
              <p className="studio-none">{t('studio.noneMatch')}</p>
            ) : (
              <div className={`studio-gallery is-density-${density}`}>
                {shown.map(job => {
                  const output = pictureOutput(job);
                  const picture = job.state === 'done' && !!output;
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
                          {/* Being looked at, or redrawn because it was. Said
                              on the card rather than nowhere: a picture that
                              quietly grew a second card beside it is a thing
                              the reader has to be able to account for. */}
                          {/* Which of a sweep this one is. First among the
                              meta, because when six cards differ in one number
                              that number is the only thing worth reading. */}
                          {job.sweep && (
                            <span className="studio-sweep-badge">
                              {t(`sweep.axis.${job.sweep.axis}`)} {job.sweep.value}
                              <b>{job.sweep.at}/{job.sweep.of}</b>
                            </span>
                          )}
                          {inspecting === job.id && <span>{t('retouch.checking')}</span>}
                          {job.retouch && (
                            <span title={job.retouch.problem}>{t('retouch.fixed', { region: regionLabel(job.retouch.region, t) })}</span>
                          )}
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
                          {/* Found, and waiting to be acted on. Its own button
                              rather than a line in the menu: it is an offer
                              with a shelf life, and it is the thing somebody
                              looking at this card wants to do next. */}
                          {job.retouchOffer && picture && (
                            <button type="button" className="icon-btn is-offer"
                              title={job.retouchOffer.problem
                                || t('retouch.found', { region: regionLabel(job.retouchOffer.region, t) })}
                              aria-label={t('retouch.fix', { region: regionLabel(job.retouchOffer.region, t) })}
                              onClick={() => {
                                const region = job.retouchOffer.region || '';
                                const parts = region.split(',')
                                  .map(word => ({ region: word.trim() })).filter(part => part.region);
                                if (!parts.length) return;
                                setJobs(prev => prev.map(card => (card.id === job.id
                                  ? { ...card, retouchOffer: undefined } : card)));
                                runRetouch(job, { region, problem: job.retouchOffer.problem || '', parts });
                              }}>
                              <Wand2 size={13} />
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
                          {job.state === 'done' && output && (
                            <a className="icon-btn" href={output.url} download={output.filename}
                              title={t('studio.save')} aria-label={t('studio.save')}><Download size={13} /></a>
                          )}
                          {/* Everything else, named, behind one button. See JobMenu. */}
                          <JobMenu label={t('studio.more')} items={[
                            picture && {
                              key: 'upscale', icon: <Scaling size={14} />, label: t('studio.op.upscale'),
                              busy: operating === `${job.id}:upscale`, onClick: () => runOp(job, 'upscale'),
                            },
                            picture && {
                              key: 'rmbg', icon: <Eraser size={14} />, label: t('studio.op.rmbg'),
                              busy: operating === `${job.id}:rmbg`, onClick: () => runOp(job, 'rmbg'),
                            },
                            picture && videoWorkflow && {
                              key: 'animate', icon: <Clapperboard size={14} />, label: t('studio.op.animate'),
                              busy: operating === `${job.id}:animate`, onClick: () => animate(job),
                            },
                            picture && has.referenceImage && {
                              key: 'reference',
                              icon: referenced === job.id ? <Check size={14} /> : <ImagePlus size={14} />,
                              label: t('studio.useAsReference'),
                              busy: referencing === job.id, onClick: () => takeAsReference(job),
                            },
                            picture && onAttachToChat && {
                              key: 'chat', icon: <ImageIcon size={14} />, label: t('studio.toChat'),
                              onClick: () => onAttachToChat(job),
                            },
                            /* Out of the app: the share sheet on a phone, a
                               link anybody can open otherwise. Which one is
                               not a preference -- see `sharePictureOut`. */
                            picture && onSharePicture && output && {
                              key: 'share', icon: <Share2 size={14} />, label: t('picture.share'),
                              onClick: () => onSharePicture({
                                dataUrl: output.url,
                                url: output.url,
                                filename: output.filename,
                                prompt: job.prompt || '',
                              }),
                            },
                            {
                              key: 'forget', icon: <Trash2 size={14} />, label: t('studio.forget'), danger: true,
                              onClick: () => forget(job.id),
                            },
                          ]} />
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

      {/* What can be opened, in the order on screen -- filters included -- so
          the arrows walk the same row the eye does. Films too, now: they play
          in the viewer. See `viewableOf`. */}
      {viewing && (() => {
        const viewable = viewableOf(shown);
        const at = viewable.findIndex(({ job }) => job.id === viewing);
        if (at < 0) return null;
        return (
          <StudioLightbox
            items={viewable.map(({ job, output }) => ({
              url: output.url,
              filename: output.filename,
              video: output.media === 'video',
              favorite: !!job.favorite,
              prompt: job.prompt,
              model: job.modelLabel || job.model,
              size: job.size,
              seed: job.seed,
              /* Only where there is one.
               *
               * A verdict handed to the viewer is final -- carrying one is how
               * a caller says "this has been judged, do not judge it again" --
               * so handing over `pending` for a job nobody had looked at yet
               * froze the picture behind "checking…" for the life of the
               * viewer, and 보기 was the only way past it. What it needs
               * instead is to be left to look for itself, which is what it does
               * with no verdict at all. The prompt still has its say there.
               *
               * The card is a different question and keeps `settleVerdict`:
               * a card is on screen while the job is still running, and "not
               * yet known" genuinely is the answer then. */
              ...(job.safety?.verdict
                ? { verdict: strongest(job.safety.verdict, promptSignal(job.prompt)) }
                : {}),
              // What it was upscaled or made from, for the before-and-after bar.
              ...(output.media === 'image' && job.before ? { before: job.before } : {}),
            }))}
            index={at}
            onIndex={n => setViewing(viewable[n].job.id)}
            onClose={() => setViewing(null)}
            onCopy={copyText}
            onFavorite={n => toggleFavorite(viewable[n].job.id)}
            onReuse={(n) => { reuse(viewable[n].job); setViewing(null); }}
            /* A frame of a film, straight into the reference box: the loop
               that was missing. A film could be watched and nothing else, so
               the one shot in it worth keeping could not be edited, enlarged
               or animated again. See `frameFromVideo`. */
            onFrame={async ({ blob, name, prompt }) => {
              const data = new FormData();
              data.append('image', blob, name);
              try {
                const out = await panelJson(await fetch('/studio/upload', { method: 'POST', body: data }));
                if (!out.success) { setNotice(t('frame.failed')); return; }
                setViewing(null);
                /* Into the picture workflow, not the video one it came from:
                   a frame is a picture, and what anybody wants next is to
                   change it. The prompt travels with it, because the frame is
                   of that prompt and retyping it is the chore this avoids. */
                const target = catalogue.models.find(entry => entry.kind === 'image');
                if (target && model?.id !== target.id) {
                  pendingReference.current = out.name;
                  setModelId(target.id);
                } else {
                  set('referenceImage', out.name);
                }
                if (prompt && !String(form.prompt || '').trim()) set('prompt', prompt);
                setNotice(t('frame.taken'));
              } catch (e) {
                setNotice(t('frame.failed'));
              }
            }}
            t={t}
          />
        );
      })()}
    </div>
  );
};

export default StudioPanel;
