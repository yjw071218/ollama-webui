/**
 * The prompt box, with the tag vocabulary behind it.
 *
 * ## What it adds to a textarea
 *
 * Two things, and both are about not having to know two hundred thousand tags
 * by heart:
 *
 *   * **Completion.** Type into the tag the caret is in and the danbooru tags
 *     that match appear under it, most-used first, with the Korean description
 *     beside each — so `홍조` finds `blush` and `긴 머리` finds `long hair`.
 *     The list comes from the server (see `server/booruTags.js`); the file it
 *     reads is 22MB and does not belong in a phone's browser.
 *   * **Pasting a link.** A booru post address pasted into the box is replaced
 *     by that post's tags. It is the fastest way to describe a picture you have
 *     already found, and the tags are already written, in the vocabulary the
 *     model was trained on.
 *
 * ## Why the caret arithmetic is somewhere else
 *
 * `promptTags.js` holds it, because "which tag is the caret in" is where the
 * off-by-ones live and they are invisible from a screenshot: the wrong answer
 * completes the word before the one you are typing, which looks like the
 * feature working until you look at what it wrote.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import { tokenAt, replaceToken, looksLikeBooruLink, onWeightKey } from './promptTags.js';

/* Long enough that a fast typist does not fire a request per keystroke, short
   enough that the list is there by the time they stop to look at it. */
const DEBOUNCE_MS = 140;

/** A count, as something you can take in at a glance. */
export const shortCount = (n) => {
  const value = Number(n) || 0;
  if (value >= 1000000) return `${(value / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
};

/**
 * The bracketed category a description opens with — `[표정 > 감정] …`.
 *
 * Pulled out and shown as its own chip rather than left at the front of the
 * sentence, because it is the part that says *what kind of tag this is*, and
 * that is what a reader scanning a list is actually using to choose.
 */
export const splitDescription = (description) => {
  const text = String(description || '').trim();
  const match = /^\[([^\]]+)\]\s*/.exec(text);
  if (!match) return { category: '', rest: text };
  return { category: match[1].trim(), rest: text.slice(match[0].length).trim() };
};

export const TagPrompt = ({
  value,
  onChange,
  placeholder,
  rows = 6,
  className = '',
  t,
  /* Completion and link-pasting are the same feature — knowing the tag
     vocabulary — and both belong to the main prompt only. The lead, artist and
     trailing boxes hold settings rather than a subject, and a dropdown over
     them would be in the way. */
  complete = false,
  onBooru,
  onSubmit,
  disabled = false,
}) => {
  const box = useRef(null);
  const [hits, setHits] = useState([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [linkState, setLinkState] = useState(null);   // 'loading' | {error} | null
  const query = useRef('');
  /* Set when the text changed because something other than typing changed it.
     Filling the box from a pasted link moves the caret into the middle of forty
     tags it just wrote, and without this the reader is handed a dropdown for a
     word they did not type and are not editing. */
  const quiet = useRef(false);
  /* Whether the person is typing in this box right now.

     The list is for a tag being typed and for nothing else. It used to follow
     the caret alone, and the caret starts at 0 — so a prompt restored from the
     last session put its *first* tag under a caret nobody had placed, the
     search ran, and the list opened over the form the moment the Studio did,
     with the box not even focused. Armed by a keystroke (or Ctrl+Space, to ask
     for it), disarmed by leaving the box. */
  const armed = useRef(false);
  const [summon, setSummon] = useState(0);

  /* The token under the caret, recomputed on every change and every click —
     moving the caret with an arrow key changes which tag you are in without
     changing a character of the text. */
  const [caret, setCaret] = useState(0);
  const token = useMemo(
    () => (complete ? tokenAt(value || '', caret) : { text: '' }),
    [complete, value, caret],
  );

  useEffect(() => {
    if (!complete) return undefined;
    // Not typing here: nothing to suggest, whatever the caret happens to be in.
    if (!armed.current || document.activeElement !== box.current) {
      setHits([]); setOpen(false); return undefined;
    }
    const needle = token.text.trim();
    query.current = needle;
    if (needle.length < 1) { setHits([]); setOpen(false); return undefined; }

    if (quiet.current) { quiet.current = false; setHits([]); setOpen(false); return undefined; }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const data = await fetch(`/studio/tags?q=${encodeURIComponent(needle)}`)
          .then(r => r.json());
        /* Two guards, and they are different. `cancelled` covers the keystroke
           that happened while this was in flight; the `query.current` check
           covers responses arriving out of order, which is what a slow request
           for `b` landing after a fast one for `blue` looks like. */
        if (cancelled || query.current !== needle) return;
        setHits(data?.tags || []);
        setHighlight(0);
        setOpen((data?.tags || []).length > 0);
      } catch (e) {
        // No suggestions is a fine outcome; it must not be an error in the way.
        if (!cancelled) { setHits([]); setOpen(false); }
      }
    }, DEBOUNCE_MS);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [complete, token.text, summon]);

  const accept = useCallback((tag) => {
    const el = box.current;
    const at = el ? el.selectionStart : caret;
    const next = replaceToken(value || '', at, tag);
    onChange(next.value);
    setOpen(false);
    setHits([]);
    /* After React has written the new value. Setting it now would put the caret
       where the *old* string ended, which on a long prompt is visibly wrong. */
    requestAnimationFrame(() => {
      if (!box.current) return;
      box.current.focus();
      box.current.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  }, [value, caret, onChange]);

  const onPaste = useCallback(async (event) => {
    if (!onBooru) return;
    const text = event.clipboardData?.getData('text') || '';
    if (!looksLikeBooruLink(text)) return;      // an ordinary paste, left alone

    event.preventDefault();
    setLinkState('loading');
    quiet.current = true;
    try {
      const result = await onBooru(text.trim());
      setLinkState(result?.success ? null : { error: result?.error || 'failed' });
    } catch (e) {
      setLinkState({ error: String(e.message || e) });
    }
  }, [onBooru]);

  const onKeyDown = (event) => {
    // Ctrl+↑/↓ weighs the tag under the caret — before the list's own arrows.
    if (onWeightKey(event, (next) => { quiet.current = true; setOpen(false); onChange(next); })) return;
    // Ctrl+Space asks for suggestions for the tag under the caret, without
    // having to type a character to get them.
    if (event.ctrlKey && (event.code === 'Space' || event.key === ' ')) {
      event.preventDefault();
      armed.current = true;
      setCaret(event.currentTarget.selectionStart);
      setSummon(n => n + 1);
      return;
    }
    if (open && hits.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault(); setHighlight(h => (h + 1) % hits.length); return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault(); setHighlight(h => (h - 1 + hits.length) % hits.length); return;
      }
      /* Tab and Enter both accept. Tab is what the muscle memory of every other
         completion expects; Enter is what people press anyway. Plain Enter with
         the list closed still inserts a newline, which is how these prompts get
         written in paragraphs. */
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey)) {
        event.preventDefault(); accept(hits[highlight].name); return;
      }
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSubmit?.();
    }
  };

  const track = (event) => setCaret(event.target.selectionStart);

  return (
    <div className={`tag-prompt ${className}`}>
      <textarea
        ref={box}
        className="studio-prompt"
        placeholder={placeholder}
        value={value || ''}
        rows={rows}
        disabled={disabled}
        /* A tag prompt is not prose. Spell-check underlines every tag in it,
           and on a phone autocapitalise and autocorrect do worse than underline
           — they rewrite them, silently, into words that are not tags. */
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        writingsuggestions="false"
        onChange={(e) => {
          quiet.current = false;
          armed.current = true;
          onChange(e.target.value);
          setCaret(e.target.selectionStart);
        }}
        onKeyUp={track}
        onClick={track}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        // Not on blur: the mousedown that picks a suggestion blurs the box
        // first, so closing here would close the list before the click lands.
        onBlur={() => { armed.current = false; setTimeout(() => setOpen(false), 120); }}
      />

      {linkState === 'loading' && (
        <div className="tag-prompt-link is-loading">
          <Loader2 size={12} className="spin" /> {t('studio.booruLoading')}
        </div>
      )}
      {linkState?.error && (
        <div className="tag-prompt-link is-error" onClick={() => setLinkState(null)} role="alert">
          {linkState.error}
        </div>
      )}

      {open && hits.length > 0 && (
        <ul className="tag-suggest" role="listbox">
          {hits.map((hit, i) => {
            const { category, rest } = splitDescription(hit.description);
            return (
              <li key={hit.name}>
                <button
                  type="button"
                  className={`tag-suggest-hit ${i === highlight ? 'is-on' : ''}`}
                  role="option"
                  aria-selected={i === highlight}
                  onMouseEnter={() => setHighlight(i)}
                  // mousedown, not click: click arrives after blur has already
                  // taken the list down.
                  onMouseDown={(e) => { e.preventDefault(); accept(hit.name); }}
                >
                  <span className="tag-suggest-name">{hit.name}</span>
                  {category && <span className="tag-suggest-cat">{category}</span>}
                  <span className="tag-suggest-count">{shortCount(hit.count)}</span>
                  {rest && <span className="tag-suggest-desc">{rest}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {complete && onBooru && !open && (
        <div className="tag-prompt-hint">
          <Link2 size={11} /> {t('studio.booruHint')}
        </div>
      )}
    </div>
  );
};

export default TagPrompt;
