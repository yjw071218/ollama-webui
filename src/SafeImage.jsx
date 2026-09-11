/**
 * A picture behind frosted glass, until someone chooses to look.
 *
 * See safeguard.js for how the verdict is reached. This is the part that is
 * seen: the picture blurred past recognition, a line saying why, and one
 * button. Revealed, a small control stays in the corner to put the glass
 * back, because a picture shown on purpose is still not one that should stay
 * up while someone walks past.
 */

import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, ShieldAlert, LoaderCircle } from 'lucide-react';
import {
  getSafeguardLevel, SAFEGUARD_EVENT, shouldVeil, strongest, verdictFrom, promptSignal,
  isRevealed, setRevealed, onRevealChange,
} from './safeguard.js';
import { classify, cacheKey } from './nsfwClassifier.js';
import './safeguard.css';

/** The level, kept current when it is changed anywhere in the app. */
export const useSafeguardLevel = () => {
  const [level, setLevel] = useState(getSafeguardLevel);
  useEffect(() => {
    const update = () => setLevel(getSafeguardLevel());
    window.addEventListener(SAFEGUARD_EVENT, update);
    // Another tab, or a sync that wrote the setting.
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(SAFEGUARD_EVENT, update);
      window.removeEventListener('storage', update);
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
 */
export const useVerdict = ({ src, look = src, prompt, known, onJudged, level }) => {
  const [judged, setJudged] = useState(known || null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (known) { setJudged(known); return undefined; }
    if (!src || level === 'off') return undefined;
    let cancelled = false;
    classify(look, cacheKey(src))
      .then((scores) => {
        if (cancelled) return;
        const verdict = verdictFrom(scores);
        setJudged(verdict);
        onJudged?.({ verdict, scores });
      })
      // A classifier that could not load is not a verdict of "safe": the
      // prompt still has its say, and that is all that is left to go on.
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [src, look, known, level]);   // eslint-disable-line react-hooks/exhaustive-deps

  const asked = promptSignal(prompt);
  if (judged) return strongest(judged, asked);
  if (failed) return asked || 'safe';
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
  return (
    <div className={`safe-frame ${veiled ? 'is-veiled' : ''} ${className}`}>
      {children}
      {veiled && <VeilOverlay verdict={verdict} revealKey={revealKey} t={t} compact={compact} />}
      {hides && revealed && <Rehide revealKey={revealKey} t={t} />}
    </div>
  );
};

/** A generated picture shown in a conversation. */
export const SafePicture = ({ src, prompt, t, children }) => {
  const level = useSafeguardLevel();
  const verdict = useVerdict({ src, prompt, level });
  return (
    <Veil verdict={verdict} level={level} revealKey={cacheKey(src)} t={t}>
      {children}
    </Veil>
  );
};
