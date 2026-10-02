/**
 * Teaching this install a character or a style, and keeping what it learnt.
 *
 * The library and the training form are one panel because they are one thing
 * seen twice: every card in the library was, at some point, this form. Pulling
 * them apart would mean a reader who has just trained something has to go
 * somewhere else to find out whether it worked.
 *
 * ## What happens when the button is pressed
 *
 * Nothing here trains anything. The run is five HTTP conversations in a row,
 * and they are in this order for reasons that are not interchangeable:
 *
 *   1. ask whether a run could work at all (`/studio/train/state`) -- the
 *      ComfyUI pack and the training daemon are separate things that can be
 *      separately missing, and finding out after the uploads means uploading
 *      for nothing;
 *   2. upload each picture into a folder of ComfyUI's `input/`;
 *   3. read each one's tags back with the tagger that is already installed;
 *   4. upload one caption beside each picture, written from those tags -- see
 *      `captionsFor` in src/characters.js, which is the part that decides
 *      whether a character or a style comes out;
 *   5. queue the run, and watch it like any other job.
 *
 * The tagging is step three rather than something the reader does because a
 * caption per picture is the whole difference between the two kinds of LoRA,
 * and nobody is going to hand-write twelve of them. They are shown before the
 * run starts and can be edited, because the tagger is confidently wrong often
 * enough that "it trained the wrong thing" must not be discoverable only
 * afterwards.
 *
 * ## Why the wait is not hidden
 *
 * This is tens of minutes on one graphics card, and it is the only thing in
 * this app that is. So the run is a job like any other -- same progress
 * stream, same cancel -- and the panel says what stage it is at in words,
 * because a bar that sits at 4% for six minutes is indistinguishable from one
 * that has died.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Upload, X, Trash2, Sparkles, TriangleAlert, Check, GraduationCap, Square,
} from 'lucide-react';
import { useVerdict, Veil } from './SafeImage.jsx';
import { useJobStream } from './studioProgress.jsx';
import {
  KINDS, DEFAULT_KIND, triggerFor, captionsFor, characterRecord, withCharacter, withoutCharacter,
} from './characters.js';

/* A picture in ComfyUI's input folder, as a URL. The same shape `RefThumb` in
   StudioPanel builds; duplicated rather than exported because that one also
   carries the Studio's own veil state and this needs only the address. */
const inputUrl = (name) => {
  const slash = String(name).lastIndexOf('/');
  return `/studio/view?${new URLSearchParams({
    filename: String(name).slice(slash + 1),
    subfolder: slash >= 0 ? String(name).slice(0, slash) : '',
    type: 'input',
  })}`;
};

const thumbOf = (url) => `${url}&preview=webp;85`;

/** A reference picture, veiled by the same rules as everything else here. */
const Reference = ({ item, level, t, onRemove }) => {
  const src = item.name ? inputUrl(item.name) : item.preview;
  const verdict = useVerdict({ src, look: item.name ? thumbOf(src) : src, level });
  return (
    <div className="charlab-ref">
      <Veil verdict={verdict} level={level} revealKey={src} t={t} compact className="charlab-ref-frame">
        <img src={item.name ? thumbOf(src) : item.preview} alt="" />
      </Veil>
      <button type="button" className="icon-btn charlab-ref-x" onClick={onRemove}
        aria-label={t('charlab.remove')}><X size={12} /></button>
    </div>
  );
};

/* Between reading one picture's tags and the next. The tagger is a ComfyUI job
   like any other and they are queued one at a time; a poll faster than this is
   requests the server answers with "still going". */
const TAG_POLL_MS = 700;
/* A tagging run is seconds. A minute means something is wrong with it, and
   going on without that picture's tags is better than never starting. */
const TAG_LIMIT_MS = 60000;

/* Where a run in progress is remembered, so a reload does not lose it.
 *
 * One key rather than one per account: the daemon runs one job at a time on
 * one graphics card, so there is only ever one run to remember, and which
 * account started it does not change which job ComfyUI is running.
 *
 * Only the fact of the run is kept -- the id, what it will be called, and what
 * it is being called. The pictures are already in ComfyUI's input folder and
 * the captions are already beside them; nothing here needs to be re-uploaded
 * to finish. */
const RUN_KEY = 'characterRun';

const readRun = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(RUN_KEY) || 'null');
    return raw?.id && raw?.saveAs ? raw : null;
  } catch (e) {
    return null;
  }
};

const writeRun = (run) => {
  try {
    if (run) localStorage.setItem(RUN_KEY, JSON.stringify(run));
    else localStorage.removeItem(RUN_KEY);
  } catch (e) { /* quota, or storage disabled */ }
};

export const CharacterLab = ({
  t, level, loraOptions = [], applied = [], onApply, onRemoveLora,
  /* The library lives in the panel: the folded group's summary needs it
     too, and two copies of a list one of them writes to is one copy too
     many. */
  library = [], onLibrary,
}) => {
  const [state, setState] = useState(null);        // what /studio/train/state said
  const [items, setItems] = useState([]);          // the references being gathered
  const [name, setName] = useState('');
  const [kind, setKind] = useState(DEFAULT_KIND);
  const [captions, setCaptions] = useState(null);  // once read, editable
  const [stage, setStage] = useState(() => (readRun() ? 'training' : ''));
  const [note, setNote] = useState('');
  /* Restored rather than started empty: a run left going when the page was
     closed is still going, and the only thing that was lost was this. */
  const [job, setJob] = useState(readRun);
  const [plan, setPlan] = useState(null);          // what the server calls this run
  const fileRef = useRef(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const live = useJobStream(job?.id || null);

  const keep = onLibrary;

  // Asked once when the panel opens, and again after a run: the daemon is
  // started by hand and the answer changes without anything here doing it.
  const ask = useCallback(async () => {
    try {
      const data = await fetch('/studio/train/state').then(r => r.json());
      if (alive.current) setState(data);
      return data;
    } catch (e) {
      if (alive.current) setState({ success: false, can: false });
      return null;
    }
  }, []);
  useEffect(() => { ask(); }, [ask]);

  const trigger = useMemo(() => triggerFor(name), [name]);
  const busy = !!stage;

  const addFiles = (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    const room = Math.max(0, (state?.images?.max || 40) - items.length);
    for (const file of files.slice(0, room)) {
      const reader = new FileReader();
      reader.onload = () => setItems(prev => [...prev, { file, preview: reader.result, name: '', tags: null }]);
      reader.readAsDataURL(file);
    }
    // The captions were written from the old set and no longer describe it.
    setCaptions(null);
  };

  const drop = (index) => {
    setItems(prev => prev.filter((_, i) => i !== index));
    setCaptions(null);
  };

  /* ------------------------------------------------------- reading the set

     Uploaded first, then tagged, because the tagger reads a file ComfyUI has
     rather than bytes sent to it -- the same road the reference picture and
     every safeguard check already take. */

  const upload = async (file, filename, folder) => {
    const data = new FormData();
    data.append('image', file, filename);
    data.append('subfolder', folder);
    data.append('overwrite', 'true');
    const out = await fetch('/studio/upload', { method: 'POST', body: data }).then(r => r.json());
    if (!out?.success) throw new Error(out?.error || 'the picture could not be uploaded');
    return out.name;
  };

  /** One picture's tags, through the tagger already installed here. */
  const tagsOf = async (name2) => {
    const queued = await fetch('/studio/op', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'tag', image: name2, requestId: `tag-${name2}-${Date.now()}` }),
    }).then(r => r.json());
    if (!queued?.success) throw new Error(queued?.error || 'the tagger refused the picture');
    const deadline = Date.now() + TAG_LIMIT_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, TAG_POLL_MS));
      const state2 = await fetch(`/studio/job?id=${encodeURIComponent(queued.id)}`).then(r => r.json());
      if (state2?.state === 'failed') throw new Error(state2.error || 'the tagger failed');
      if (state2?.state === 'done') {
        return String((state2.texts || []).join(', ')).split(',').map(s => s.trim()).filter(Boolean);
      }
    }
    throw new Error('the tagger did not answer');
  };

  /**
   * Everything up to the captions, so they can be read before anything is
   * committed to.
   *
   * Separate from the run because forty minutes of a graphics card should not
   * start on captions nobody has looked at, and because the tagger is the part
   * most likely to be wrong in a way only a person can see.
   */
  const readSet = async () => {
    if (!items.length || busy) return;
    setStage('uploading');
    setNote('');
    try {
      /* What to call the folder, asked rather than worked out: the graph the
         server builds names this folder, and two copies of the rule that
         turns "루나" into a directory name is how they stop being the same
         folder. */
      const named2 = await fetch('/studio/train/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }).then(r => r.json());
      if (!named2?.success) throw new Error(named2?.error || 'that name cannot be used');
      setPlan(named2);
      const dataset = named2.dataset;
      const named = [];
      for (let i = 0; i < items.length; i += 1) {
        const stem = `img_${String(i + 1).padStart(4, '0')}`;
        // eslint-disable-next-line no-await-in-loop
        named.push(await upload(items[i].file, `${stem}.png`, dataset));
      }
      setItems(prev => prev.map((item, i) => ({ ...item, name: named[i] })));

      setStage('tagging');
      const read = [];
      for (const one of named) {
        // eslint-disable-next-line no-await-in-loop
        read.push(await tagsOf(one).catch(() => []));
      }
      if (!alive.current) return;
      setItems(prev => prev.map((item, i) => ({ ...item, tags: read[i] })));
      setCaptions(captionsFor({ kind, trigger, tags: read }));
      setNote('');
    } catch (e) {
      setNote(String(e?.message || e));
    } finally {
      if (alive.current) setStage('');
    }
  };

  /* The captions follow the kind: switching between a character and a style
     after they have been read rewrites them, because they are opposite
     answers to the same tags and a stale set would train the other thing. */
  useEffect(() => {
    const read = items.map(item => item.tags).filter(Boolean);
    if (read.length !== items.length || !items.length) return;
    setCaptions(captionsFor({ kind, trigger, tags: read }));
  }, [kind, trigger]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------------------- the run */

  const start = async () => {
    if (!captions || busy || !plan) return;
    const ready = await ask();
    if (!ready?.can) {
      setNote(ready?.daemon && !ready.daemon.running
        ? t('charlab.noDaemon')
        : t('charlab.noPack', { pack: ready?.pack || '' }));
      return;
    }
    setStage('training');
    setNote('');
    try {
      const { id, dataset } = plan;
      for (let i = 0; i < captions.length; i += 1) {
        const stem = `img_${String(i + 1).padStart(4, '0')}`;
        const blob = new Blob([`${captions[i]}\n`], { type: 'text/plain' });
        // eslint-disable-next-line no-await-in-loop
        await upload(blob, `${stem}.txt`, dataset);
      }
      const preset = ready.presets?.[kind] || {};
      const queued = await fetch('/studio/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id, name, images: items.length, base: ready.base || undefined,
          rank: preset.rank, epochs: preset.epochs, lr: preset.lr, gpu: '16GB',
          requestId: `train-${id}-${Date.now()}`,
        }),
      }).then(r => r.json());
      if (!queued?.success) throw new Error(queued?.error || 'the training job was refused');
      const run = {
        id: queued.id, saveAs: queued.saveAs || plan.saveAs, name, kind, trigger,
        images: items.length, rank: preset.rank, epochs: preset.epochs,
      };
      writeRun(run);
      setJob(run);
    } catch (e) {
      setNote(String(e?.message || e));
      setStage('');
    }
  };

  /* A finished run leaves a file, and only ComfyUI can say what it is called
     in the list the LoRA slots offer -- the separator and the casing are its
     to choose. Asked once the job ends rather than guessed. */
  useEffect(() => {
    if (!job || !live || (live.state !== 'done' && live.state !== 'failed')) return undefined;
    let stop = false;
    (async () => {
      if (live.state === 'failed') {
        if (!stop) { setNote(live.error || t('charlab.failed')); setStage(''); setJob(null); writeRun(null); }
        return;
      }
      let lora = null;
      try {
        const out = await fetch(`/studio/train/result?saveAs=${encodeURIComponent(job.saveAs)}`).then(r => r.json());
        lora = out?.lora || null;
      } catch (e) { /* asked again below, through the plain name */ }
      if (stop) return;
      if (!lora) { setNote(t('charlab.noFile')); setStage(''); setJob(null); writeRun(null); return; }
      /* Built from what the run recorded, not from the form: after a reload
         the form is empty and the run is the only thing that still knows who
         this was going to be. */
      const made = characterRecord({
        id: job.saveAs, name: job.name, kind: job.kind, trigger: job.trigger, lora,
        images: job.images, rank: job.rank, epochs: job.epochs,
      });
      keep(withCharacter(library, made));
      writeRun(null);
      setStage('');
      setJob(null);
      setItems([]);
      setCaptions(null);
      setName('');
      setPlan(null);
      setNote(t('charlab.done', { name: made.name }));
    })();
    return () => { stop = true; };
  }, [live?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const stop = async () => {
    if (!job?.id) return;
    try { await fetch('/studio/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id }) }); } catch (e) { /* it may already have stopped */ }
    writeRun(null);
    setJob(null);
    setStage('');
  };

  /* ------------------------------------------------------------ the shelf */

  const isApplied = (character) => applied.some(row => row?.name === character.lora);
  const missing = (character) => loraOptions.length > 0 && !loraOptions.includes(character.lora);

  return (
    <div className="charlab">
      {/* What has been learnt. First, because after the first run this is the
          part anybody opening this panel came for. */}
      {library.length > 0 && (
        <div className="charlab-shelf is-wide">
          {library.map((character) => {
            const on = isApplied(character);
            const gone = missing(character);
            return (
              <div key={character.id} className={`charlab-card ${on ? 'is-on' : ''} ${gone ? 'is-gone' : ''}`}>
                <button type="button" className="charlab-card-main"
                  title={gone ? t('charlab.gone') : character.lora}
                  disabled={gone}
                  onClick={() => (on ? onRemoveLora?.(character) : onApply?.(character))}>
                  <span className="charlab-card-name">{character.name}</span>
                  <span className="charlab-card-meta">
                    <em>{t(`charlab.kind.${character.kind}`)}</em>
                    <code>{character.trigger}</code>
                  </span>
                  {on && <Check size={13} className="charlab-card-tick" aria-hidden="true" />}
                </button>
                <button type="button" className="charlab-mini is-danger"
                  onClick={() => keep(withoutCharacter(library, character.id))}
                  title={t('charlab.forget')} aria-label={t('charlab.forget')}><Trash2 size={12} /></button>
              </div>
            );
          })}
        </div>
      )}

      {/* Why a run cannot start, where that is already known. Said here rather
          than when the button is pressed: the daemon is a process somebody has
          to start, and finding that out after choosing twelve pictures is
          finding it out too late. */}
      {state && !state.can && (
        <p className="charlab-blocked is-wide">
          <TriangleAlert size={13} aria-hidden="true" />
          {state.daemon && !state.daemon.running
            ? t('charlab.noDaemon')
            : (state.missing?.length ? t('charlab.noPack', { pack: state.pack }) : t('charlab.noComfy'))}
        </p>
      )}

      {/* The references. */}
      <div className="charlab-refs is-wide">
        {items.map((item, i) => (
          <Reference key={i} item={item} level={level} t={t} onRemove={() => drop(i)} />
        ))}
        <input ref={fileRef} type="file" accept="image/*" multiple onChange={addFiles} hidden />
        <button type="button" className="charlab-add" onClick={() => fileRef.current?.click()} disabled={busy}>
          <Upload size={13} />
          <span>{t('charlab.add')}</span>
        </button>
      </div>

      <label className="studio-field is-wide">
        <span>{t('charlab.name')}</span>
        <input className="settings-input" value={name} disabled={busy}
          placeholder={t('charlab.namePlaceholder')} onChange={e => setName(e.target.value)} />
      </label>

      <div className="studio-field charlab-kinds is-wide" role="group" aria-label={t('charlab.what')}>
        <span>{t('charlab.what')}</span>
        <div className="charlab-kind-row">
          {KINDS.map(one => (
            <button key={one} type="button" disabled={busy}
              className={`charlab-kind ${kind === one ? 'is-on' : ''}`}
              onClick={() => setKind(one)}>
              {t(`charlab.kind.${one}`)}
              <em>{t(`charlab.kindHint.${one}`)}</em>
            </button>
          ))}
        </div>
      </div>

      {/* The word the prompt will say. Shown rather than asked for: it is
          derived from the name and is meant to be a token the model has no
          prior opinion about, which is not a thing to invite anybody to
          improve on -- but it is what they will type later, so it cannot be
          invisible either. */}
      {name.trim() && (
        <p className="charlab-trigger is-wide">
          {t('charlab.trigger')} <code>{trigger}</code>
        </p>
      )}

      {/* The captions, once read. Editable, because the tagger is confidently
          wrong often enough that the only place to catch it is here. */}
      {captions && (
        <div className="charlab-captions is-wide">
          <span className="charlab-captions-label">{t('charlab.captions')}</span>
          <p className="charlab-captions-why">{t(`charlab.captionsWhy.${kind}`)}</p>
          {captions.map((caption, i) => (
            <input key={i} className="settings-input charlab-caption" value={caption} disabled={busy}
              aria-label={`${t('charlab.captions')} ${i + 1}`}
              onChange={e => setCaptions(prev => prev.map((c, n) => (n === i ? e.target.value : c)))} />
          ))}
        </div>
      )}

      {note && <p className="charlab-note is-wide">{note}</p>}

      {/* What it is doing, in words. A bar alone cannot tell six minutes of
          work from a run that has died. */}
      {stage && (
        <p className="charlab-stage is-wide">
          <Sparkles size={13} aria-hidden="true" />
          {stage === 'training' && job?.name ? `${job.name} — ` : ''}
          {t(`charlab.stage.${stage}`)}
          {stage === 'training' && live?.percent ? ` ${Math.round(live.percent)}%` : ''}
        </p>
      )}

      <div className="charlab-go is-wide">
        {!captions && (
          <button type="button" className="studio-go is-secondary" disabled={!items.length || !name.trim() || busy}
            onClick={readSet}>
            <Sparkles size={14} /> {t('charlab.read')}
          </button>
        )}
        {captions && stage !== 'training' && (
          <button type="button" className="studio-go" disabled={busy || !state?.can} onClick={start}>
            <GraduationCap size={14} /> {t('charlab.start')}
          </button>
        )}
        {stage === 'training' && (
          <button type="button" className="studio-go is-danger" onClick={stop}>
            <Square size={13} /> {t('charlab.stop')}
          </button>
        )}
      </div>
    </div>
  );
};
