/**
 * A picture behind frosted glass, until someone chooses to look.
 *
 * See safeguard.js for how the verdict is reached. This is the part that is
 * seen: the picture blurred past recognition, a line saying why, and one
 * button. Revealed, a small control stays in the corner to put the glass
 * back, because a picture shown on purpose is still not one that should stay
 * up while someone walks past.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, ShieldAlert, LoaderCircle } from 'lucide-react';
import {
  getSafeguardLevel, SAFEGUARD_EVENT, shouldVeil, strongest, verdictFrom, promptSignal,
  isRevealed, setRevealed, onRevealChange,
} from './safeguard.js';
import { classify, cacheKey } from './nsfwClassifier.js';
import { judgePicture, pictureFileOf } from './pictureSafety.js';
import { judgeVideo } from './videoSafety.js';
import './safeguard.css';

/** The level, kept current when it is changed anywhere in the app. */
export const useSafeguardLevel = () => {
  const [level, setLevel] = useState(getSafeguardLevel);
  useEffect(() => {
    const update = () => setLevel(getSafeguardLevel());
    window.addEventListener(SAFEGUARD_EVENT, update);
    // Another tab, or a sync that wrote the setting.
    window.addEventListener('storage', update);
    // A sync in this tab fires no 'storage' event: App.jsx says so itself.
    window.addEventListener('webui:settings-synced', update);
    return () => {
      window.removeEventListener(SAFEGUARD_EVENT, update);
      window.removeEventListener('storage', update);
      window.removeEventListener('webui:settings-synced', update);
    };
  }, []);
  return level;
};

export const useRevealed = (key) => {
  const [on, setOn] = useState(() => isRevealed(key));
  useEffect(() => {
    setOn(isRevealed(key));
    return onRevealChange(() => setOn(isRevealed(key)));
  }, [key]);
  return on;
};

/**
 * The verdict for a picture.
 *
 * `known` is a verdict already reached — a Studio job carries its own, synced,
 * so a picture judged on the laptop is not judged again on the phone. Without
 * one, the classifier is asked and `onJudged` hears the answer so the caller
 * can keep it. With the safeguard off, nothing is classified at all.
 *
 * `onJudged` is told which witness answered (`by`), because they are not equal
 * and a stored verdict that does not say where it came from cannot be compared
 * with a better one arriving later.
 *
 * An answer counts only for the picture it was given about. The viewer keeps
 * one of these and changes the picture under it, and a verdict held over from
 * the last picture would show the next one bare until the classifier caught
 * up -- for a frame, or for as long as the model takes to load.
 */
export const useVerdict = ({ src, look = src, prompt, known, onJudged, level, file = null }) => {
  const [result, setResult] = useState(null);   // { src, verdict } or { src, failed }
  /* And what ComfyUI's tagger makes of it, which is the witness that actually
     knows -- see src/pictureSafety.js. Held apart from the classifier's answer
     because it arrives a round trip later and, when it does, it is the one
     that is believed. See the note above the verdict below. */
  const [tagged, setTagged] = useState(null);   // { key, verdict }

  useEffect(() => {
    if (known || !src || level === 'off') return undefined;
    let cancelled = false;
    classify(look, cacheKey(src))
      .then((scores) => {
        if (cancelled) return;
        const verdict = verdictFrom(scores);
        setResult({ src, verdict });
        onJudged?.({ verdict, scores, by: 'classifier' });
      })
      // A classifier that could not load is not a verdict of "safe": the
      // prompt still has its say, and that is all that is left to go on.
      .catch(() => { if (!cancelled) setResult({ src, failed: true }); });
    return () => { cancelled = true; };
  }, [src, look, known, level]);   // eslint-disable-line react-hooks/exhaustive-deps

  /* Asked separately, because it is asked of a different thing: the classifier
     reads the bytes in this browser, the tagger reads the file ComfyUI wrote.
     A picture with no such file -- one the reader attached -- has nothing to
     ask about, and this does not run. */
  const asKey = file ? `${file.type}:${file.subfolder}/${file.filename}` : '';
  useEffect(() => {
    if (!asKey || level === 'off') return undefined;
    let cancelled = false;
    judgePicture(file)
      .then(({ verdict, tags }) => {
        if (cancelled) return;
        setTagged({ key: asKey, verdict });
        onJudged?.({ verdict, tags, by: 'tagger' });
      })
      // No tagger, or no ComfyUI. The other two witnesses stand.
      .catch(() => {});
    return () => { cancelled = true; };
  }, [asKey, level]);   // eslint-disable-line react-hooks/exhaustive-deps

  /* Three witnesses, and the order they are believed in.
   *
   * Two of them answer "what was asked for" and "what does a photo classifier
   * make of this drawing". The third reads the file ComfyUI wrote, in the
   * vocabulary these models are trained in. Once it has read it, it answers.
   *
   * **The prompt included.** This was the last thing still able to overrule
   * the tagger, and it is wrong for the same reason the classifier was: a
   * prompt is a *request made before the picture exists*, not a description
   * of what arrived. Reported, and correct: `bottomless` in the prompt, and a
   * drawing of a girl in an oversized shirt that covers her completely --
   * veiled, permanently, because a word in the request outranked the thing
   * that had looked at the picture.
   *
   * So the prompt is the gate while there is nothing else to go on: during
   * the minute the picture is being drawn, and afterwards on anything the
   * tagger cannot read. That is the job it is good at -- it is available
   * before the first step has run. It is not the job of deciding what a
   * finished picture contains.
   *
   * This does not weaken the thing the safeguard is for. A prompt that asked
   * for something explicit and got it is a picture the tagger tags `nude`,
   * `nipples`, `pussy` -- the tags it is most confident about, well above the
   * threshold it is run at. What changes is only the case where the request
   * and the result disagree, and there the result is what is on screen. */
  const asked = promptSignal(prompt);
  const seen = tagged?.key === asKey ? tagged.verdict : null;
  if (seen) return seen;
  if (known) return strongest(known, asked);
  const mine = result?.src === src ? result : null;
  if (mine?.verdict) return strongest(mine.verdict, asked);
  if (mine?.failed) return asked || 'safe';
  /* Still being looked at. Covered, as before -- except where the prompt has
     already decided, in which case there is nothing to wait for. */
  return asked === 'explicit' ? 'explicit' : 'pending';
};

/**
 * The verdict for a video: its frames, tagged, and its prompt -- the stronger
 * of the two, as for a picture. See videoSafety.js.
 *
 * `file` is which video ComfyUI wrote (`{ filename, subfolder, type }`); null
 * for a picture, which makes this a no-op so it can sit beside `useVerdict`
 * unconditionally. Until the frames have been read the video is `pending` --
 * covered, as a picture is while the classifier looks -- and if they cannot be
 * read at all (no tagger, ComfyUI not running) the prompt is what is left.
 */
export const useVideoVerdict = ({ file, prompt, known, onJudged, level, duration }) => {
  const [result, setResult] = useState(null);   // { key, verdict } or { key, failed }, as for a picture
  const key = file ? `${file.type}:${file.subfolder}/${file.filename}` : '';

  useEffect(() => {
    if (known || !key || level === 'off') return undefined;
    let cancelled = false;
    judgeVideo(file, { duration })
      .then((judged) => {
        if (cancelled) return;
        setResult({ key, verdict: judged.verdict });
        // A video's frames are the tagger too, read a frame at a time.
        onJudged?.({ ...judged, by: 'frames' });
      })
      .catch(() => { if (!cancelled) setResult({ key, failed: true }); });
    return () => { cancelled = true; };
  }, [key, known, level]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!key) return null;
  const asked = promptSignal(prompt);
  if (known) return strongest(known, asked);
  const mine = result?.key === key ? result : null;
  if (mine?.verdict) return strongest(mine.verdict, asked);
  if (mine?.failed) return asked || 'safe';
  return asked === 'explicit' ? 'explicit' : 'pending';
};

/** The glass itself, for a caller that lays out its own picture. */
export const VeilOverlay = ({ verdict, revealKey, t, compact = false }) => {
  const checking = verdict === 'pending';
  const why = checking ? t('safe.checking')
    : verdict === 'explicit' ? t('safe.explicit') : t('safe.suggestive');

  /* A reference thumbnail is 56 pixels square: a button with a word on it does
     not fit in one, and the glass is small enough to press as a whole. So the
     compact veil *is* the button — the icon says it is covered, the tooltip
     says why, and a click shows it. */
  if (compact) {
    return (
      <button
        type="button"
        className="safe-veil is-compact"
        title={`${why} — ${t('safe.show')}`}
        aria-label={`${why} — ${t('safe.show')}`}
        onClick={(event) => { event.stopPropagation(); setRevealed(revealKey, true); }}
      >
        {checking ? <LoaderCircle size={15} className="spin" aria-hidden="true" />
          : <Eye size={15} aria-hidden="true" />}
      </button>
    );
  }

  return (
    <div className="safe-veil">
      {checking
        ? <LoaderCircle size={20} className="spin" aria-hidden="true" />
        : <ShieldAlert size={20} aria-hidden="true" />}
      <span className="safe-veil-note">{why}</span>
      <button
        type="button"
        className="safe-veil-show"
        onClick={(event) => { event.stopPropagation(); setRevealed(revealKey, true); }}
      >
        <Eye size={14} /> {t('safe.show')}
      </button>
    </div>
  );
};

/** The control that puts the glass back. */
export const Rehide = ({ revealKey, t }) => (
  <button
    type="button"
    className="safe-rehide"
    onClick={(event) => { event.stopPropagation(); setRevealed(revealKey, false); }}
    title={t('safe.hide')}
    aria-label={t('safe.hide')}
  >
    <EyeOff size={13} />
  </button>
);

/**
 * A picture with the whole treatment: judged, veiled if it should be, and
 * revealable. `children` is the picture — an `<img>`, or a button around one.
 */
export const Veil = ({ verdict, level, revealKey, t, compact = false, className = '', children }) => {
  const revealed = useRevealed(revealKey);
  const hides = shouldVeil(verdict, level);
  const veiled = hides && !revealed;
  const frame = useRef(null);

  /* Where the pointer is on the glass, as two custom properties.
   *
   * Written straight onto the node rather than held in state: this fires on
   * every pointer move, and a `setState` here would re-render a picture --
   * and the classifier hooks under it -- sixty times a second to move a
   * highlight four pixels. The value is only ever read by CSS, so React never
   * needs to know it. See safeguard.css.
   *
   * The ripple reveals nothing. It is light on the surface, not a lens: what
   * is underneath stays exactly as blurred, because a hover is not somebody
   * asking to see the picture. */
  const follow = (event) => {
    const node = frame.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    if (!box.width || !box.height) return;
    node.style.setProperty('--rx', `${((event.clientX - box.left) / box.width) * 100}%`);
    node.style.setProperty('--ry', `${((event.clientY - box.top) / box.height) * 100}%`);
  };

  /* Whether the rings run is decided here, not by `:hover`. On a phone a tap
   * leaves the element "hovered" (and focused) until something else is
   * touched, so rings driven by `:hover` kept spreading after the finger had
   * left the glass. A class toggled from pointer events goes away the moment
   * the finger lifts, whatever the browser thinks is hovered. */
  const setRippling = (on) => frame.current?.classList.toggle('is-rippling', on);
  const enter = (event) => { follow(event); setRippling(true); };
  const leave = () => setRippling(false);
  const lift = (event) => { if (event.pointerType !== 'mouse') setRippling(false); };

  useEffect(() => { if (!veiled) setRippling(false); }, [veiled]);

  return (
    <div
      ref={frame}
      className={`safe-frame ${veiled ? 'is-veiled' : ''} ${className}`}
      onPointerMove={veiled ? follow : undefined}
      onPointerEnter={veiled ? enter : undefined}
      onPointerDown={veiled ? enter : undefined}
      onPointerLeave={veiled ? leave : undefined}
      onPointerUp={veiled ? lift : undefined}
      onPointerCancel={veiled ? leave : undefined}
    >
      {children}
      {veiled && !compact && (
        <div className="safe-ripples" aria-hidden="true">
          <span className="safe-ring" />
          <span className="safe-ring" />
          <span className="safe-ring" />
        </div>
      )}
      {veiled && <VeilOverlay verdict={verdict} revealKey={revealKey} t={t} compact={compact} />}
      {hides && revealed && <Rehide revealKey={revealKey} t={t} />}
    </div>
  );
};

/**
 * A generated picture shown in a conversation -- or a video, given `video` and
 * the `file` ComfyUI wrote it as, which is judged by its frames rather than put
 * through the picture classifier it cannot pass through.
 */
export const SafePicture = ({ src, prompt, t, video = false, file = null, duration, filename = '', children }) => {
  const level = useSafeguardLevel();
  const pictureVerdict = useVerdict({
    src: video ? '' : src,
    prompt,
    /* A picture drawn in a conversation is a file ComfyUI wrote, and the
       tagger can read it -- which matters most here, where `src` is often a
       data URL the classifier reads and the prompt says nothing useful. A
       picture the reader attached has no such file and is judged as before.
       See src/pictureSafety.js. */
    file: video ? null : pictureFileOf({ url: src, filename }),
    level,
  });
  const filmVerdict = useVideoVerdict({ file: video ? file : null, prompt, level, duration });
  // A film with no file to read (an old message) has only its prompt.
  const verdict = video ? (file ? filmVerdict : (promptSignal(prompt) || 'safe')) : pictureVerdict;
  return (
    <Veil verdict={verdict} level={level} revealKey={cacheKey(src)} t={t}>
      {children}
    </Veil>
  );
};
