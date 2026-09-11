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
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, Maximize2, Minimize2, Download, Copy, Check, EyeOff } from 'lucide-react';
import { useSafeguardLevel, useRevealed, VeilOverlay } from './SafeImage.jsx';
import { shouldVeil, setRevealed } from './safeguard.js';

export const StudioLightbox = ({ items, index, onIndex, onClose, onCopy, t }) => {
  const item = items[index];
  // Whether the picture has the whole screen, chrome and padding included.
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  // Natural sizes by URL, so a cached image that loads before an effect runs
  // is not forgotten by a reset that follows it.
  const [natural, setNatural] = useState({});
  const dims = natural[item?.url];

  /* A veiled picture is veiled here too, and cannot be enlarged until it is
     shown: a bigger blur is not a picture, it is a bigger blur. */
  const level = useSafeguardLevel();
  const revealed = useRevealed(item?.url);
  const hides = !!item && shouldVeil(item.verdict, level);
  const veiled = hides && !revealed;
  const veiledNow = useRef(veiled);
  veiledNow.current = veiled;

  const dialog = useRef(null);
  const stage = useRef(null);
  const img = useRef(null);

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
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (full) setFull(false); else onClose();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault(); event.stopPropagation(); go(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault(); event.stopPropagation(); go(-1);
      } else if ((event.key === 'z' || event.key === 'Z' || (event.key === ' ' && !onButton))) {
        event.preventDefault(); event.stopPropagation();
        if (full) setFull(false); else enlarge();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [full, go, onClose]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!item) return null;

  const copy = async () => {
    if (await onCopy(item.prompt)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return createPortal(
    <div
      className={`studio-lightbox ${full ? 'is-full' : ''}`}
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
          {hides && revealed && (
            <button type="button" className="studio-lightbox-btn" onClick={() => setRevealed(item.url, false)}
              aria-label={t('safe.hide')} title={t('safe.hide')}>
              <EyeOff size={16} />
            </button>
          )}
          <button
            disabled={veiled}
            type="button"
            className="studio-lightbox-btn"
            onClick={() => (full ? setFull(false) : enlarge())}
            aria-label={full ? t('studio.view.zoomOut') : t('studio.view.zoomIn')}
            title={full ? t('studio.view.zoomOut') : t('studio.view.zoomIn')}
          >
            {full ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <a
            className="studio-lightbox-btn"
            href={item.url}
            download={item.filename}
            aria-label={t('studio.save')}
            title={t('studio.save')}
          >
            <Download size={16} />
          </a>
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
        className={`studio-lightbox-stage ${veiled ? 'is-veiled' : ''}`}
        ref={stage}
        // The empty space around the picture is the backdrop: clicking it
        // closes, as it does in every other viewer.
        onClick={(event) => { if (event.target === stage.current) onClose(); }}
      >
        <img
          ref={img}
          key={item.url}
          src={item.url}
          alt={item.prompt || ''}
          draggable={false}
          /* Never past its own pixels. Stretching a 512-pixel picture across a
             1440-pixel screen shows nothing that was not already there, and
             shows it softer. */
          style={dims ? { maxWidth: `min(100%, ${dims.w}px)`, maxHeight: `min(100%, ${dims.h}px)` } : undefined}
          onLoad={(event) => {
            const { naturalWidth: w, naturalHeight: h } = event.currentTarget;
            setNatural(prev => (prev[item.url] ? prev : { ...prev, [item.url]: { w, h } }));
          }}
          onClick={(event) => {
            event.stopPropagation();
            if (full) setFull(false); else enlarge();
          }}
        />
        {veiled && <VeilOverlay verdict={item.verdict} revealKey={item.url} t={t} />}
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
