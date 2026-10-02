/**
 * A picture from the Studio, big.
 *
 * The gallery shows a picture at a quarter of its width, which is enough to
 * choose between pictures and not enough to judge one — a hand, an eye, a line
 * of text in the background is exactly the detail these models get wrong, and
 * exactly the detail a 260px card hides.
 *
 * So a click opens it over everything, fitted to the screen, and a second
 * click takes the last of that screen: the prompt, the counter and the padding
 * step aside and the picture is laid out edge to edge, still whole.
 *
 * It deliberately stops there. It used to go to actual size at the point
 * clicked, and a 2520×3676 picture at actual size is four screens tall — every
 * view of it was a fragment, and getting back to the whole picture meant
 * remembering that a click undid it. The largest useful size for a picture is
 * the largest one you can see all of, so that is the ceiling; a picture
 * already smaller than the screen is left at its own size rather than blown up
 * into mush.
 *
 * Arrow keys move through the gallery, and Escape steps back out of the full
 * screen before it closes the viewer.
 *
 * The keyboard handler listens in the capture phase and stops what it handles:
 * the app has its own Escape and arrow shortcuts, and a viewer that also closed
 * the Studio behind it would be a viewer nobody could use twice.
 *
 * It is rendered into <body>, not where the Studio puts it: the Studio lives
 * in a positioned pane beside the sidebar, and a fixed overlay inside it came
 * out clipped to that pane with the sidebar drawn over its left edge.
 *
 * The gallery and the conversation open their pictures in it too. They had
 * the attachment viewer -- a box with a picture in it, no arrows, no way to
 * see the whole of a tall picture at the size of the screen -- so the same
 * picture looked different depending on where it was opened from.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X, ChevronLeft, ChevronRight, Maximize2, Minimize2, Download, Copy, Check, EyeOff, Star, RefreshCcw,
  SquareSplitHorizontal, Crop,
} from 'lucide-react';
import {
  FIT, clampScale, clampOffset, zoomAt, pointIn, wheelScale,
  pinchOf, toggleZoom, isZoomed, transformOf,
} from './zoomPan.js';
import { useSafeguardLevel, useRevealed, useVerdict, useVideoVerdict, VeilOverlay } from './SafeImage.jsx';
import { shouldVeil, setRevealed, promptSignal } from './safeguard.js';
import { pictureFileOf } from './pictureSafety.js';
import { BeforeAfter } from './BeforeAfter.jsx';
import { frameFromVideo, frameName } from './pictureTools.js';
import './studio.css';

/* How far a finger has to travel, and how much more along than across, for a
   drag to be a swipe rather than a wobble on the way to a tap. */
const SWIPE = 56;

/**
 * The verdict for the item on screen.
 *
 * The Studio hands its own, already reached and synced; the gallery and the
 * conversation do not have one to hand, so the viewer asks as their cards do --
 * the classifier for a picture (it remembers, so a picture already judged on
 * its card is not judged again), the frames for a film.
 */
const useItemVerdict = (item, level) => {
  const given = item?.verdict !== undefined;
  const picture = useVerdict({
    src: !given && item && !item.video ? item.url : '',
    look: item?.look || item?.url,
    prompt: item?.prompt,
    // The tagger's say, where this is a still ComfyUI wrote. See pictureSafety.js.
    file: !given && item && !item.video
      ? pictureFileOf({ url: item.url, filename: item.filename })
      : null,
    level,
  });
  const film = useVideoVerdict({
    file: !given && item?.video ? item.file || null : null,
    prompt: item?.prompt,
    level,
    duration: item?.duration,
  });
  if (!item) return 'safe';
  if (given) return item.verdict;
  if (!item.video) return picture;
  // A film with no file to read (an old message) has only its prompt.
  return item.file ? film : (promptSignal(item.prompt) || 'safe');
};

/* Films are in the viewer too, and play in it: a video watched only at card
   size is a video nobody can judge. `item.video` says which element to use.

   `onFavorite` and `onReuse`, when given, are the two things done to a
   picture while looking at it -- keep it, or make it again -- so they are here
   rather than only on the card behind the viewer. `F` stars.

   `tools` is what else the place it was opened from can do with it:
   `[{ id, icon, label, run(index), when?(item), disabled? }]`. The viewer
   closes before running one, because every one of them leads somewhere else.

   An item is `{ url, prompt, video?, filename?, model?, size?, seed?, origin?,
   verdict?, look?, file?, duration?, revealKey?, before? }`. `verdict` when the
   place has one; otherwise `look` (a lighter copy) or `file` (a film's) to judge
   it by. `revealKey` is the key the place shows it under, so showing it here
   shows it there. `before` is the picture an upscale or an edit was made from:
   with it, a button (and `C`) lays the two in one frame with a bar between
   them -- see BeforeAfter.jsx. */
/* How far a finger or a mouse may wander before a press stops counting as a
   press. Under this, a drag that moved by a pixel still toggles the zoom the
   way a click does; over it, the click that ends the drag is swallowed. */
const SLOP = 6;

export const StudioLightbox = ({
  items, index, onIndex, onClose, onCopy, onFavorite, onReuse, onDownload, onFrame, tools = [], t,
}) => {
  const item = items[index];
  // Whether the picture has the whole screen, chrome and padding included.
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  /* The before-and-after bar. Kept on while walking through pictures, for
     going down a row of upscales; a picture with nothing to compare with is
     shown as itself meanwhile. */
  const [comparing, setComparing] = useState(false);
  // Natural sizes by URL, so a cached image that loads before an effect runs
  // is not forgotten by a reset that follows it.
  const [natural, setNatural] = useState({});
  const dims = natural[item?.url];

  /* A veiled picture is veiled here too, and cannot be enlarged until it is
     shown: a bigger blur is not a picture, it is a bigger blur. */
  const level = useSafeguardLevel();
  const verdict = useItemVerdict(item, level);
  const revealKey = item?.revealKey || item?.url;
  const revealed = useRevealed(revealKey);
  const hides = !!item && shouldVeil(verdict, level);
  const veiled = hides && !revealed;
  const veiledNow = useRef(veiled);
  veiledNow.current = veiled;

  /* How far in, and where. `FIT` is the resting state and is what every
     other gesture in here assumes: at fit a drag belongs to the viewer, and
     only past it does it belong to the picture. See src/zoomPan.js. */
  const [view, setView] = useState(FIT);
  /* The key handler is installed once and must not close over a stale view:
     Escape at 6x has to know it is at 6x. */
  const viewRef = useRef(view);
  viewRef.current = view;
  const gesture = useRef(null);   // the drag or pinch in progress
  const zoomRef = useRef(false);  // whether this picture can be zoomed at all
  const moved = useRef(false);    // did it move far enough to swallow the click

  const dialog = useRef(null);
  const stage = useRef(null);
  const img = useRef(null);

  const boxOf = () => stage.current?.getBoundingClientRect() || { left: 0, top: 0, width: 0, height: 0 };


  /* The wheel, zooming about the pointer.
   *
   * Attached here rather than as `onWheel`, because React attaches `wheel` at
   * the root as a *passive* listener: `preventDefault` inside `onWheel` is
   * ignored with a warning, and the page scrolls behind the picture while the
   * picture zooms. A listener of this element's own, asked for with
   * `{ passive: false }`, is the only way to be allowed to take the gesture.
   *
   * Every wheel, not only Ctrl+wheel: there is nothing to scroll in a picture
   * viewer, so a plain wheel has no other job here, and requiring a modifier
   * is requiring people to know about it. */
  useEffect(() => {
    const el = stage.current;
    if (!el) return undefined;
    const onWheel = (event) => {
      if (!zoomRef.current) return;
      event.preventDefault();
      const box = el.getBoundingClientRect();
      setView(v => zoomAt(v, wheelScale(v, event.deltaY, event.deltaMode),
        pointIn(box, event.clientX, event.clientY), box));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /* Following a drag of the picture with a mouse.
   *
   * Installed once and idle until there is a drag, rather than installed when
   * one starts: the gesture lives in a ref, and a ref changing does not
   * re-render, so an effect keyed off it would never run. On `window` rather
   * than on the image, because a drag that reaches the edge of the picture
   * carries on past it and has to keep being heard. */
  useEffect(() => {
    const onMove = (event) => {
      const g = gesture.current;
      if (!g || g.kind !== 'pan' || g.touch) return;
      const dx = event.clientX - g.x;
      const dy = event.clientY - g.y;
      if (Math.abs(dx) > SLOP || Math.abs(dy) > SLOP) moved.current = true;
      setView(clampOffset({ scale: g.from.scale, x: g.from.x + dx, y: g.from.y + dy }, boxOf()));
    };
    const onUp = () => { if (gesture.current && !gesture.current.touch) gesture.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);
  const film = useRef(null);
  /* Whether the reader has moved off the picture they opened.
   *
   * The viewer's entrance -- the picture rising into the backdrop -- is right
   * once, when it opens over what was already there. Re-running it on every
   * arrow press is a third of a second of scaling per press, which is a viewer
   * that cannot be flicked through. Derived rather than stored: the index it
   * opened at is a fact about this mounting. */
  const openedAt = useRef(index);
  const walking = index !== openedAt.current;
  // A frame being taken off the player -- one at a time, because the button
  // stays live while the canvas and the upload happen.
  const [grabbing, setGrabbing] = useState(false);
  const touch = useRef(null);

  // A picture it can be laid against, and the bar is up. Never through the glass.
  const canCompare = !!item?.before && !item?.video;
  const showCompare = comparing && canCompare && !veiled;

  /* Back to fit whenever what is on screen changes underneath it. A picture
     left at 4x while the arrow key moves to the next one shows the middle of
     a different picture, which reads as the viewer having lost its place.

     Below `showCompare` rather than up with the other effects, because it
     reads it: a `const` read from above its own declaration throws at run
     time and passes every check that does not run the code. */
  /* On `index`, not on the picture's URL.
   *
   * The URL is not what changes when somebody walks the gallery: two entries
   * can be the same file -- a retouch kept beside its original, one picture in
   * two messages -- and keyed on the URL those walked past without resetting.
   * The symptom was an arrow that appeared not to work: the picture did change,
   * and the view stayed at 5x on the middle of the new one, which looks exactly
   * like nothing having happened. */
  useEffect(() => { setView(FIT); }, [index, item?.url, showCompare]);

  /* And when the veil goes up -- but not when it comes down.
   *
   * `veiled` is true while the verdict is still pending and turns false when
   * the picture comes back safe, which is about a second after it opens. Tied
   * to every change of it, this threw away a zoom that had been made in that
   * second, with nothing on screen to explain why. Going up is the case that
   * has to reset: a picture that has just been covered must not still be held
   * at 4x underneath the cover. */
  useEffect(() => { if (veiled) setView(FIT); }, [veiled]);

  // Focus goes into the viewer, and back to whatever opened it afterwards.
  useEffect(() => {
    const before = document.activeElement;
    dialog.current?.focus();
    return () => { if (before && typeof before.focus === 'function') before.focus(); };
  }, []);

  // Another picture starts framed, with its prompt on screen.
  useEffect(() => { setCopied(false); }, [index]);
  useEffect(() => { if (veiled) setFull(false); }, [veiled]);

  const go = useCallback((step) => {
    if (items.length < 2) return;
    onIndex((index + step + items.length) % items.length);
  }, [index, items.length, onIndex]);

  const enlarge = () => { if (!veiledNow.current) setFull(true); };

  useEffect(() => {
    const onKey = (event) => {
      const onButton = event.target instanceof HTMLElement && event.target.closest('button, a');
      // The bar's handle has the arrows while it has the focus; they move the bar.
      const onBar = event.target instanceof HTMLElement && event.target.closest('.before-after');
      if (onBar && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        /* One step back at a time: the zoom, then the full screen, then the
           bar, then the viewer. Escape closing the whole thing from 6x is a
           gesture nobody can undo. */
        if (isZoomed(viewRef.current)) setView(FIT);
        else if (full) setFull(false);
        else if (showCompare) setComparing(false);
        else onClose();
      } else if ((event.key === 'c' || event.key === 'C') && canCompare && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); event.stopPropagation();
        setComparing(on => !on);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault(); event.stopPropagation(); go(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault(); event.stopPropagation(); go(-1);
      } else if (event.key === ' ' && !onButton && item?.video) {
        // On a film, space is play and pause, as it is in every player.
        event.preventDefault(); event.stopPropagation();
        const video = film.current;
        if (video) { if (video.paused) video.play?.().catch?.(() => {}); else video.pause(); }
      } else if ((event.key === 'z' || event.key === 'Z' || (event.key === ' ' && !onButton))) {
        event.preventDefault(); event.stopPropagation();
        if (full) setFull(false); else enlarge();
      } else if ((event.key === 'f' || event.key === 'F') && onFavorite && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); event.stopPropagation();
        onFavorite(index);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [full, go, onClose, onFavorite, index, item?.video, canCompare, showCompare]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!item) return null;

  const copy = async () => {
    if (await onCopy(item.prompt)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const shownTools = tools.filter(tool => !tool.when || tool.when(item));

  /* Whether this picture can be zoomed at all.
   *
   * A film has its own controls and a scrubber that a drag belongs to, and the
   * comparison has a bar of its own that a drag moves. Both keep their
   * gestures.
   *
   * A covered picture does not need to keep its own. The veil is
   * `filter: blur(44px)` on the picture itself, so scaling it scales the
   * blurred result -- nothing is uncovered by zooming into it. Refusing the
   * gesture only produced a viewer that ignored the wheel without saying
   * why. */
  const zoomable = !item.video && !showCompare;
  // Read by the wheel listener, which is installed once and cannot close over it.
  zoomRef.current = zoomable;


  /* ---- a drag, with a mouse ---- */

  const onMouseDown = (event) => {
    if (!zoomable || event.button !== 0 || !isZoomed(view)) return;
    event.preventDefault();
    moved.current = false;
    gesture.current = { kind: 'pan', x: event.clientX, y: event.clientY, from: view };
  };

  /* ---- one finger and two ----

     One finger moves the picture where there is room to move it, and is the
     viewer's own gesture where there is not: across to the next picture, down
     to close -- what a finger does in every other photo viewer, and the arrows
     are small targets on a picture that fills the screen.

     Two fingers zoom about the point between them, which is the only place a
     pinch can be about without the thing being pinched sliding away. */
  const onTouchStart = (event) => {
    if (zoomable && event.touches.length === 2) {
      const { distance, mid } = pinchOf(event.touches[0], event.touches[1]);
      const box = boxOf();
      gesture.current = { kind: 'pinch', touch: true, distance, from: view, point: pointIn(box, mid.clientX, mid.clientY) };
      touch.current = null;
      return;
    }
    if (event.touches.length !== 1) { touch.current = null; gesture.current = null; return; }
    const [one] = event.touches;
    if (zoomable && isZoomed(view)) {
      gesture.current = { kind: 'pan', touch: true, x: one.clientX, y: one.clientY, from: view };
      touch.current = null;
      return;
    }
    gesture.current = null;
    touch.current = { x: one.clientX, y: one.clientY };
  };

  const onTouchMove = (event) => {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch' && event.touches.length === 2) {
      /* No `preventDefault` -- React's touch listeners are passive and it would
         do nothing. `touch-action: none` on the stage is what stops the browser
         taking the gesture, and it does it before the first frame rather than
         after it. */
      const { distance } = pinchOf(event.touches[0], event.touches[1]);
      if (!g.distance) return;
      const box = boxOf();
      setView(zoomAt(g.from, clampScale(g.from.scale * (distance / g.distance)), g.point, box));
      return;
    }
    if (g.kind === 'pan' && event.touches.length === 1) {
      const [one] = event.touches;
      setView(clampOffset({
        scale: g.from.scale,
        x: g.from.x + (one.clientX - g.x),
        y: g.from.y + (one.clientY - g.y),
      }, boxOf()));
    }
  };

  const onTouchEnd = (event) => {
    if (gesture.current) {
      // A pinch that has lifted one finger leaves the other one holding the
      // picture, rather than starting a swipe from wherever it happens to be.
      if (event.touches.length === 0) gesture.current = null;
      touch.current = null;
      return;
    }
    const start = touch.current;
    touch.current = null;
    // A drag across the comparison is the bar being moved, not a swipe.
    if (!start || item.video || showCompare) return;
    const end = event.changedTouches[0];
    const dx = end.clientX - start.x;
    const dy = end.clientY - start.y;
    if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
    else if (dy > SWIPE * 1.5 && dy > Math.abs(dx) * 1.5 && !full) onClose();
  };

  return createPortal(
    <div
      className={`studio-lightbox ${full ? 'is-full' : ''} ${walking ? 'is-walking' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={item.prompt || t('studio.view.open')}
      ref={dialog}
      tabIndex={-1}
    >
      <div className="studio-lightbox-bar">
        {items.length > 1 && <span className="studio-lightbox-count">{index + 1} / {items.length}</span>}
        {dims && <span className="studio-lightbox-size">{dims.w} × {dims.h}</span>}
        <div className="studio-lightbox-tools">
          {onFavorite && (
            <button type="button" className={`studio-lightbox-btn ${item.favorite ? 'is-fav' : ''}`}
              onClick={() => onFavorite(index)} aria-pressed={!!item.favorite}
              aria-label={item.favorite ? t('studio.unfavorite') : t('studio.favorite')}
              title={`${item.favorite ? t('studio.unfavorite') : t('studio.favorite')} (F)`}>
              <Star size={16} fill={item.favorite ? 'currentColor' : 'none'} />
            </button>
          )}
          {onReuse && (
            <button type="button" className="studio-lightbox-btn" onClick={() => onReuse(index)}
              aria-label={t('studio.reuse')} title={t('studio.reuse')}>
              <RefreshCcw size={16} />
            </button>
          )}
          {/* One frame of a film, taken from the element that is playing it.
              *
              * Off the player rather than by decoding the file again, because
              * the reader has already scrubbed to the frame they want and that
              * position is the request. A film was the one thing this app makes
              * that could be watched and nothing else; a frame is the way out
              * of it, and back in -- a picture the video workflow can start
              * from. See `frameFromVideo`. */}
          {onFrame && item.video && (
            <button type="button" className="studio-lightbox-btn" disabled={grabbing}
              onClick={async () => {
                const video = film.current;
                if (!video) return;
                setGrabbing(true);
                try {
                  const blob = await frameFromVideo(video);
                  await onFrame({
                    blob,
                    at: video.currentTime || 0,
                    name: frameName(item.filename || 'film', video.currentTime || 0),
                    prompt: item.prompt || '',
                  });
                } catch (e) { /* said by the caller, which knows where it went */ } finally {
                  setGrabbing(false);
                }
              }}
              aria-label={t('frame.take')} title={t('frame.take')}>
              {grabbing ? <RefreshCcw size={16} className="spin" /> : <Crop size={16} />}
            </button>
          )}
          {canCompare && (
            <button type="button" className={`studio-lightbox-btn ${showCompare ? 'is-on' : ''}`}
              disabled={veiled} onClick={() => setComparing(on => !on)} aria-pressed={showCompare}
              aria-label={t('compare.toggle')} title={`${t('compare.toggle')} (C)`}>
              <SquareSplitHorizontal size={16} />
            </button>
          )}
          {shownTools.map(tool => (
            <button key={tool.id} type="button" className="studio-lightbox-btn" disabled={!!tool.disabled}
              onClick={() => { onClose(); tool.run(index); }}
              aria-label={tool.label} title={tool.label}>
              {tool.icon}
            </button>
          ))}
          {hides && revealed && (
            <button type="button" className="studio-lightbox-btn" onClick={() => setRevealed(revealKey, false)}
              aria-label={t('safe.hide')} title={t('safe.hide')}>
              <EyeOff size={16} />
            </button>
          )}
          <button
            disabled={veiled}
            type="button"
            className="studio-lightbox-btn"
            onClick={() => {
              // Zoomed in, the button is the way back out -- and it is the
              // only way back out that does not need a second hand.
              if (isZoomed(view)) { setView(FIT); return; }
              if (full) setFull(false); else enlarge();
            }}
            aria-label={full || isZoomed(view) ? t('studio.view.zoomOut') : t('studio.view.zoomIn')}
            title={full || isZoomed(view) ? t('studio.view.zoomOut') : t('studio.view.zoomIn')}
          >
            {full || isZoomed(view) ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          {/* The place's own download when it has one: it names the file
              by what it is, where a link can only take the URL's word for it. */}
          {onDownload ? (
            <button type="button" className="studio-lightbox-btn" onClick={() => onDownload(index)}
              aria-label={t('studio.save')} title={t('studio.save')}>
              <Download size={16} />
            </button>
          ) : (
            <a
              className="studio-lightbox-btn"
              href={item.url}
              download={item.filename}
              aria-label={t('studio.save')}
              title={t('studio.save')}
            >
              <Download size={16} />
            </a>
          )}
          <button
            type="button"
            className="studio-lightbox-btn"
            onClick={onClose}
            aria-label={t('studio.view.close')}
            title={t('studio.view.close')}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div
        className={`studio-lightbox-stage ${veiled ? 'is-veiled' : ''} ${showCompare ? 'is-comparing' : ''}`}
        ref={stage}
        // The empty space around the picture is the backdrop: clicking it
        // closes, as it does in every other viewer.
        onClick={(event) => { if (event.target === stage.current) onClose(); }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        /* The browser's own pan and pinch are switched off only where this
           takes them over. On a film, and behind the veil, the page keeps
           them. */
        style={zoomable ? { touchAction: 'none' } : undefined}
        data-zoomed={isZoomed(view) ? 'true' : undefined}
      >
        {showCompare ? (
          <BeforeAfter
            key={item.url}
            before={item.before}
            after={item.url}
            t={t}
            // Never past the result's own pixels, as the picture itself is not.
            style={dims ? { '--natural-w': `${dims.w}px` } : undefined}
            onRatio={(ratio, size) => setNatural(prev => (prev[item.url] ? prev : { ...prev, [item.url]: size }))}
          />
        ) : item.video ? (
          <video
            ref={film}
            key={item.url}
            src={item.url}
            controls
            autoPlay={!veiled}
            loop
            playsInline
            aria-label={item.prompt || ''}
            style={dims ? { maxWidth: `min(100%, ${dims.w}px)`, maxHeight: `min(100%, ${dims.h}px)` } : undefined}
            onLoadedMetadata={(event) => {
              const { videoWidth: w, videoHeight: h } = event.currentTarget;
              if (w && h) setNatural(prev => (prev[item.url] ? prev : { ...prev, [item.url]: { w, h } }));
            }}
            // The player's own controls take clicks; the backdrop still closes.
            onClick={(event) => event.stopPropagation()}
          />
        ) : (
        <img
          ref={img}
          key={item.url}
          src={item.url}
          alt={item.prompt || ''}
          draggable={false}
          /* Never past its own pixels. Stretching a 512-pixel picture across a
             1440-pixel screen shows nothing that was not already there, and
             shows it softer. */
          style={{
            ...(dims ? { maxWidth: `min(100%, ${dims.w}px)`, maxHeight: `min(100%, ${dims.h}px)` } : null),
            transform: transformOf(view),
            /* Only while it is not being dragged. A transition on a value that
               follows the finger is a picture that arrives where the finger
               was a moment ago. */
            transition: gesture.current ? 'none' : undefined,
            cursor: isZoomed(view) ? 'grab' : undefined,
          }}
          onMouseDown={onMouseDown}
          onDoubleClick={(event) => {
            if (!zoomable) return;
            event.stopPropagation();
            const box = boxOf();
            setView(v => toggleZoom(v, pointIn(box, event.clientX, event.clientY), box));
          }}
          onLoad={(event) => {
            const { naturalWidth: w, naturalHeight: h } = event.currentTarget;
            setNatural(prev => (prev[item.url] ? prev : { ...prev, [item.url]: { w, h } }));
          }}
          /* A click does not resize any more -- the wheel and two fingers do
             that, continuously, and a click that jumps between two fixed sizes
             is a way to lose your place. It is still stopped from reaching the
             backdrop, because the backdrop closes the viewer and a press on
             the picture is not a press on the backdrop. */
          onClick={(event) => { event.stopPropagation(); moved.current = false; }}
        />
        )}
        {veiled && <VeilOverlay verdict={verdict} revealKey={revealKey} t={t} />}
      </div>

      {items.length > 1 && (
        <>
          <button type="button" className="studio-lightbox-nav is-prev" onClick={() => go(-1)}
            aria-label={t('studio.view.prev')} title={t('studio.view.prev')}>
            <ChevronLeft size={22} />
          </button>
          <button type="button" className="studio-lightbox-nav is-next" onClick={() => go(1)}
            aria-label={t('studio.view.next')} title={t('studio.view.next')}>
            <ChevronRight size={22} />
          </button>
        </>
      )}

      <div className="studio-lightbox-caption">
        <p>{item.prompt}</p>
        <div className="studio-lightbox-meta">
          {item.origin && <span className="studio-lightbox-origin">{item.origin}</span>}
          {item.model && <span>{item.model}</span>}
          {item.size && <span>{item.size}</span>}
          {item.seed !== undefined && <span>seed {item.seed}</span>}
        </div>
        <button
          type="button"
          className="studio-lightbox-btn"
          onClick={copy}
          aria-label={t('studio.copyPrompt')}
          title={t('studio.copyPrompt')}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
    </div>,
    document.body,
  );
};

export default StudioLightbox;
