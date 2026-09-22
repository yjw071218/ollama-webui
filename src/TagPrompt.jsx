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
 *   * **Pasting a picture.** The same idea for a picture that is not on a
 *     booru: the tagger reads it and a vision model says what tags cannot, and
 *     both land in the box. See `src/describeImage.js`. A picture and a link
 *     are the same gesture — "describe this" — so they are the same paste.
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
import { tokenAt, replaceToken, looksLikeBooruLink, booruLinkIn, onWeightKey } from './promptTags.js';
import { imageOnClipboard, isDescribable } from './describeImage.js';

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
  /* Given a pasted or dropped picture. Absent on the boxes that hold settings
     rather than a subject, so pasting a picture into the artist row does
     nothing rather than something surprising. */
  onImage,
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
  /* A paste fires `paste` and then `change`, and on a phone sometimes only
     the second. Both look at the same link, so the first one to claim it
     holds this until the post has been fetched -- otherwise the tags are
     written in twice. */
  const busy = useRef(false);
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

  /* Fetching the post, wherever the link was noticed.
   *
   * `replace` is the difference between adding a reference and swapping one.
   * The box having been selected whole is the reader saying "this, instead" --
   * and so is a link that arrives as the entire new value, which is what a
   * paste over a full selection produces on the platforms that give no usable
   * paste event. `rest` is whatever prompt the link was appended to, which
   * survives. */
  const fetchBooru = useCallback(async (url, { replace, rest }) => {
    if (!onBooru || busy.current) return;
    busy.current = true;
    setLinkState('loading');
    quiet.current = true;
    try {
      const result = await onBooru(url, { replace, rest });
      setLinkState(result?.success ? null : { error: result?.error || 'failed' });
    } catch (e) {
      setLinkState({ error: String(e.message || e) });
    } finally {
      busy.current = false;
    }
  }, [onBooru]);

  const onPaste = useCallback(async (event) => {
    /* A picture first, because a clipboard carrying one usually carries a file
       name or an empty string beside it -- so reading the text first would
       take the ordinary-paste branch and drop the picture on the floor. */
    const picture = onImage ? imageOnClipboard(event.clipboardData) : null;
    if (picture) {
      event.preventDefault();
      const el = event.currentTarget;
      /* The same question a pasted link is asked, and the same answer: the box
         selected whole is the one gesture that unambiguously means "this,
         instead of that". An empty box says it quietly. */
      const all = el.selectionStart === 0 && el.selectionEnd >= String(value || '').length;
      onImage(picture, { replace: all || !String(value || '').trim() });
      return;
    }

    if (!onBooru) return;
    const text = event.clipboardData?.getData('text') || '';
    if (!looksLikeBooruLink(text)) return;      // an ordinary paste, left alone

    event.preventDefault();
    /* Whether this paste is meant to replace the prompt or to add to it, asked
       of the selection it is landing on. Everything selected -- Ctrl+A, or the
       phone's "Select all" -- is the one gesture that unambiguously means
       "this, instead of that". An empty box is the same thing said quietly. */
    const el = event.currentTarget;
    const all = el.selectionStart === 0 && el.selectionEnd >= String(value || '').length;
    const rest = all ? '' : String(value || '');
    fetchBooru(text.trim(), { replace: all || !String(value || '').trim(), rest });
  }, [onBooru, onImage, value, fetchBooru]);

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
          const next = e.target.value;
          /* A link that got in without a paste event -- see `booruLinkIn`.
             Checked here rather than only in `onPaste` because on a phone this
             is usually the only place it can be caught. The box is left holding
             whatever was around the link while the post is fetched; `onBooru`
             writes the tags when they arrive. */
          const link = onBooru && !busy.current ? booruLinkIn(next) : null;
          if (link) {
            quiet.current = true;
            onChange(link.rest);
            fetchBooru(link.url, { replace: link.replaced, rest: link.rest });
            return;
          }
          quiet.current = false;
          armed.current = true;
          onChange(next);
          setCaret(e.target.selectionStart);
        }}
        onKeyUp={track}
        onClick={track}
        onPaste={onPaste}
        /* A picture dropped on the box itself. Handled here as well as on the
           form around it, because a textarea's own default for a dropped file
           is to insert its *name* as text -- so without this, dropping a
           picture on the prompt writes `IMG_4831.png` into it. Anything else
           is left to bubble, so dropping a settings PNG on the box still
           reaches the form's importer. */
        onDragOver={(e) => { if (onImage && [...(e.dataTransfer?.items || [])].some(i => i.kind === 'file')) e.preventDefault(); }}
        onDrop={(e) => {
          const picture = onImage && [...(e.dataTransfer?.files || [])].find(isDescribable);
          if (!picture) return;
          e.preventDefault();
          e.stopPropagation();
          onImage(picture, { replace: !String(value || '').trim() });
        }}
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
