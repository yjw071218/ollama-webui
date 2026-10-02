/**
 * Two versions of a picture in one frame, split by a bar that can be dragged.
 *
 * An upscale or an edit is judged against what it started from, and the two
 * used to be in different places -- the original a message or a card further
 * up, so "what did it change" meant scrolling back and forth and remembering.
 * Here they are laid on top of each other, the original on the left of the bar
 * and the result on the right, and moving the bar is moving the line between
 * them. Anywhere on the picture drags it, not only the handle; the handle is
 * what the keyboard moves (arrows, Home, End).
 *
 * Both are fitted into the same box, so an upscale -- the same picture at twice
 * the pixels -- lines up with its original, detail against detail.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronsLeftRight } from 'lucide-react';
import { splitAt, splitByKey } from './studioTools.js';
import './studio.css';

export { splitAt, splitByKey };

export const BeforeAfter = ({ before, after, t, className = '', style = undefined, onRatio, ratio: givenRatio = null }) => {
  const [position, setPosition] = useState(50);
  const [ratio, setRatio] = useState(givenRatio);
  const [broken, setBroken] = useState(false);
  const frame = useRef(null);
  const dragging = useRef(false);

  // Another pair starts in the middle again.
  useEffect(() => { setPosition(50); setBroken(false); }, [before, after]);

  const moveTo = useCallback((clientX) => {
    setPosition(splitAt(clientX, frame.current?.getBoundingClientRect()));
  }, []);

  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    dragging.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    moveTo(event.clientX);
    // Not a click on the viewer behind: that would enlarge or close it.
    event.stopPropagation();
  };
  const onPointerMove = (event) => { if (dragging.current) moveTo(event.clientX); };
  const onPointerUp = (event) => {
    dragging.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const onKeyDown = (event) => {
    const next = splitByKey(position, event.key, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    // The viewer's own arrows go to the next picture; here they move the bar.
    event.stopPropagation();
    setPosition(next);
  };

  return (
    <div
      ref={frame}
      className={`before-after ${className}`}
      style={{ ...(ratio ? { '--ar': ratio, aspectRatio: ratio } : {}), ...(style || {}) }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={(event) => event.stopPropagation()}
    >
      <img
        className="before-after-after"
        src={after}
        alt={t('compare.after')}
        draggable={false}
        onLoad={(event) => {
          const { naturalWidth: w, naturalHeight: h } = event.currentTarget;
          if (w && h) { setRatio(w / h); onRatio?.(w / h, { w, h }); }
        }}
      />
      {!broken && (
        <img
          className="before-after-before"
          src={before}
          alt={t('compare.before')}
          draggable={false}
          style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
          // An original that is gone -- a ComfyUI that emptied its input folder
          // -- leaves the result whole rather than a broken half.
          onError={() => setBroken(true)}
        />
      )}
      {!broken && (
        <>
          <span className="before-after-tag is-before" style={{ opacity: position > 12 ? 1 : 0 }}>{t('compare.before')}</span>
          <span className="before-after-tag is-after" style={{ opacity: position < 88 ? 1 : 0 }}>{t('compare.after')}</span>
          <div className="before-after-bar" style={{ left: `${position}%` }}>
            <span
              className="before-after-handle"
              role="slider"
              tabIndex={0}
              aria-label={t('compare.handle')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(position)}
              aria-orientation="horizontal"
              onKeyDown={onKeyDown}
            >
              <ChevronsLeftRight size={16} />
            </span>
          </div>
        </>
      )}
      {broken && <span className="before-after-missing">{t('compare.missing')}</span>}
    </div>
  );
};

export default BeforeAfter;
