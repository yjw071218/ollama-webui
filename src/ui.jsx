import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * A number persisted in localStorage. Used for panel sizes so the layout
 * survives a reload.
 */
export const usePersistedNumber = (key, fallback) => {
  const [value, setValue] = useState(() => {
    const raw = localStorage.getItem(key);
    const parsed = raw === null ? NaN : parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  });

  useEffect(() => {
    localStorage.setItem(key, String(value));
  }, [key, value]);

  return [value, setValue];
};

export const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * Draggable splitter.
 *
 * `direction` is +1 when dragging towards larger client coordinates should
 * grow the panel (a handle on the panel's right edge) and -1 when it should
 * shrink it (a handle on the panel's left edge).
 *
 * Pointer capture keeps the drag alive over the preview iframe, and the
 * full-screen overlay stops the iframe from swallowing the move events in
 * browsers where capture alone is not enough.
 */
export const ResizeHandle = ({
  axis = 'x',
  direction = 1,
  getSize,
  setSize,
  min = 160,
  max = () => Infinity,
  onReset,
  label = 'Resize panel',
  /* The CSS variable the size is drawn from (e.g. '--sidebar-width') and the
     element it is set on. With both, a drag writes the variable straight onto
     that element once per frame and tells React only when the finger lifts:
     re-rendering the whole app on every move is what made it stutter on a
     phone or tablet. */
  cssVar = '',
  varTarget = '.claude-app',
}) => {
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const originRef = useRef(0);
  const startRef = useRef(0);
  const pendingRef = useRef(null);   // the size waiting for the next frame
  const latestRef = useRef(null);    // the size last drawn
  const frameRef = useRef(0);
  const targetRef = useRef(null);

  const limits = useCallback(() => [min, typeof max === 'function' ? max() : max], [min, max]);
  const fit = useCallback((next) => {
    const [lo, hi] = limits();
    return Math.round(clamp(next, lo, Math.max(lo, hi)));
  }, [limits]);

  const apply = useCallback((next) => { setSize(fit(next)); }, [fit, setSize]);

  const draw = () => {
    frameRef.current = 0;
    const size = pendingRef.current;
    if (size === null || size === latestRef.current) return;
    latestRef.current = size;
    if (targetRef.current) targetRef.current.style.setProperty(cssVar, `${size}px`);
    else setSize(size);
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    startRef.current = axis === 'x' ? e.clientX : e.clientY;
    originRef.current = getSize();
    latestRef.current = originRef.current;
    pendingRef.current = null;
    targetRef.current = cssVar ? (e.currentTarget.closest(varTarget) || document.querySelector(varTarget)) : null;
    draggingRef.current = true;
    setDragging(true);
  };

  const onPointerMove = (e) => {
    if (!draggingRef.current) return;
    // Every coalesced point is one move; only the newest matters for a frame.
    const current = axis === 'x' ? e.clientX : e.clientY;
    pendingRef.current = fit(originRef.current + (current - startRef.current) * direction);
    if (!frameRef.current) frameRef.current = requestAnimationFrame(draw);
  };

  const endDrag = (e) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (frameRef.current) { cancelAnimationFrame(frameRef.current); frameRef.current = 0; }
    draw();
    // React (and localStorage) hear the size once, at the end.
    if (targetRef.current && latestRef.current !== null) setSize(latestRef.current);
    targetRef.current = null;
    setDragging(false);
  };

  useEffect(() => () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); }, []);

  const onKeyDown = (e) => {
    const step = e.shiftKey ? 48 : 16;
    const grow = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    const shrink = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    if (e.key === grow) { e.preventDefault(); apply(getSize() + step * direction); }
    if (e.key === shrink) { e.preventDefault(); apply(getSize() - step * direction); }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onReset?.(); }
  };

  // Keep text from being selected across the whole app mid-drag.
  useEffect(() => {
    if (!dragging) return undefined;
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    // Transitions off while dragging, so the panel follows the finger, not an animation.
    document.documentElement.classList.add('is-panel-resizing');
    return () => {
      document.body.style.userSelect = previous;
      document.documentElement.classList.remove('is-panel-resizing');
    };
  }, [dragging]);

  return (
    <>
      <div
        className={`resize-handle resize-${axis} ${dragging ? 'dragging' : ''}`}
        role="separator"
        aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
        aria-label={label}
        title={`${label} — drag, double-click to reset, arrow keys to nudge`}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => onReset?.()}
        onKeyDown={onKeyDown}
      >
        <span className="resize-grip" aria-hidden="true" />
      </div>
      {dragging && <div className={`resize-overlay resize-overlay-${axis}`} />}
    </>
  );
};

/**
 * Keeps children mounted for the length of their exit animation.
 *
 * Conditional rendering alone can only animate the way in — the element is
 * gone before an exit can play. This holds it in the tree with
 * `data-state="closed"` until `duration` has elapsed.
 */
export const useTransitionState = (open, duration = 200) => {
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState(open ? 'open' : 'closed');

  useEffect(() => {
    if (open) {
      setMounted(true);
      // A frame between mount and the open state, so the enter keyframes run.
      const raf = requestAnimationFrame(() => setState('open'));
      return () => cancelAnimationFrame(raf);
    }

    setState('closed');
    const timer = setTimeout(() => setMounted(false), duration);
    return () => clearTimeout(timer);
  }, [open, duration]);

  return { mounted, state };
};

/** Small popover that closes on outside click and Escape, and animates both ways. */
export const Popover = ({ open, onClose, children, className = '' }) => {
  const ref = useRef(null);
  const { mounted, state } = useTransitionState(open, 150);

  /* How much room there actually is, in the direction this one opens.
   *
   * Measured on a 390x844 phone: the model menu opens *upward* from the
   * composer, the composer sat 394px down the screen, the menu stood 395px
   * tall, and its heading came out at -9px -- above the top of the window,
   * where nothing can scroll it back. The cap was `55dvh`, a fraction of the
   * viewport, and the viewport is not the gap: a menu that fits the cap can
   * still not fit the space above the button that opened it.
   *
   * So the gap is measured and handed to the stylesheet, which clamps against
   * it -- see `--room-above` and `--room-below` in extras.css. The element is
   * absolutely positioned inside the wrapper that holds it and its trigger, so
   * that wrapper's box is the anchor, whichever edge the menu is pinned to.
   *
   * Against the *visual* viewport, not the layout one. They are the same thing
   * on a desktop and they are not on a phone with the keyboard up: the layout
   * viewport does not shrink for it, so a menu sized against it is sized
   * against space that is underneath the keyboard.
   */
  useEffect(() => {
    if (!mounted) return undefined;
    const fit = () => {
      const node = ref.current;
      const anchor = node?.parentElement;
      if (!node || !anchor) return;
      const box = anchor.getBoundingClientRect();
      const view = window.visualViewport;
      const top = view?.offsetTop || 0;
      const height = view?.height || window.innerHeight;
      // A floor, because a menu clamped to nothing is a menu that cannot be
      // used at all; below it the menu scrolls and overlaps its trigger, which
      // is the better of two bad afternoons.
      const room = (space) => `${Math.round(Math.max(140, space))}px`;
      /* And the header, which sits over the top of the page. The room above a
         menu that opens upward ends at the header's bottom edge, not at the
         window's: measured once the model menu grew a character field, its
         heading was under the header, hit-tested as `header-tools`, with
         nothing to scroll it back. The header measures itself into
         `--header-h`; a page without one has nothing to subtract. */
      /* Measured where it is, not read from `--header-h`: that is written by a
         layout effect after a resize, and a menu fitted in the same frame read
         the old height -- intermittently, under the header's icons. */
      const bar = document.querySelector('.main-header');
      const measured = bar ? bar.getBoundingClientRect().bottom : NaN;
      const header = Number.isFinite(measured) && measured > 0
        ? measured
        : parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 0;
      const headerBottom = box.top > header ? header : 0;
      node.style.setProperty('--room-above', room(box.top - top - headerBottom - 12));
      node.style.setProperty('--room-below', room((top + height) - box.bottom - 12));
    };
    fit();
    window.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('scroll', fit);
    return () => {
      window.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('scroll', fit);
    };
  }, [mounted]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      const node = ref.current;
      if (!node) return;
      if (node.contains(e.target)) return;
      /* The button that opened it is not "outside".
       *
       * A popover is absolutely positioned inside a small wrapper that holds
       * nothing but it and its trigger. Counting that trigger as outside meant
       * pressing it while the menu was open ran both handlers in order --
       * mousedown closed the menu, then the click toggled it straight back --
       * so the button that opened the menu could not close it again. */
      if (node.parentElement?.contains(e.target)) return;
      onClose?.();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!mounted) return null;
  return <div ref={ref} data-state={state} className={`popover ${className}`}>{children}</div>;
};

/**
 * Height-animated disclosure.
 *
 * `<details>` cannot be transitioned in most browsers, so the content sits in
 * a grid row that animates between 0fr and 1fr — smooth at any content height
 * and with no JavaScript measurement.
 */
export const Collapsible = ({ open, children, className = '' }) => (
  <div className={`collapsible ${open ? 'is-open' : ''} ${className}`}>
    {/* React 19 takes `inert` as a boolean; it keeps collapsed content out of
        the tab order without needing display:none, which would kill the animation. */}
    <div className="collapsible-inner" inert={!open}>
      {children}
    </div>
  </div>
);

/** Wrapper form of useTransitionState for plain markup. */
export const Transition = ({ open, duration = 200, as: Tag = 'div', children, ...rest }) => {
  const { mounted, state } = useTransitionState(open, duration);
  if (!mounted) return null;
  return <Tag data-state={state} {...rest}>{children}</Tag>;
};

/**
 * Keep the keyboard inside an open dialog, and give it back afterwards.
 *
 * Every dialog in this app was a `<div>`. Nothing said it was a dialog, so a
 * screen reader carried on announcing the conversation behind it; nothing held
 * the keyboard, so Tab walked straight out into the chat list underneath while
 * the overlay covered it; and nothing gave focus back on close, so after
 * shutting Settings the next Tab started from the top of the document.
 *
 * All three are the same omission, and all three matter to the same people.
 *
 * Returns a ref to put on the dialog element. Used with `role="dialog"` and
 * `aria-modal="true"`, which is what tells assistive technology to treat the
 * rest of the page as inert.
 */
export const useDialog = (open) => {
  const ref = useRef(null);
  const restoreTo = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    // Whoever opened it, so it can be handed back. Captured before focus
    // moves, which is why this is here rather than in the cleanup.
    restoreTo.current = document.activeElement;

    const node = ref.current;
    // The first thing worth landing on. Not the close button where there is
    // anything else: opening a dialog focused on "cancel" is a small hostility.
    const focusables = () => [...(node?.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]),'
      + ' select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) || [])].filter(el => el.offsetParent !== null || el === document.activeElement);

    const first = focusables();
    // A dialog with nothing focusable still needs the keyboard *somewhere*
    // inside it, or Tab starts from the document again.
    if (first.length > 0) first[0].focus();
    else node?.focus?.();

    const onKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) { e.preventDefault(); return; }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      // Wrapping is the whole of a focus trap: off the end goes to the start,
      // and off the start goes to the end.
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };

    node?.addEventListener('keydown', onKeyDown);
    return () => {
      node?.removeEventListener('keydown', onKeyDown);
      // Back where it came from. `focus()` on a removed element throws in no
      // browser, but the element may have gone with the dialog that opened it.
      const target = restoreTo.current;
      if (target && document.contains(target) && typeof target.focus === 'function') {
        target.focus();
      }
    };
  }, [open]);

  return ref;
};

/**
 * Accessible on/off switch.
 *
 * The previous markup hid a zero-size checkbox behind a decorative div, so the
 * visible control was not clickable unless something happened to wrap it in a
 * <label>. A button with role="switch" is clickable across its whole area,
 * focusable, and responds to Space and Enter for free.
 */
export const Switch = ({ checked, onChange, label, disabled = false }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    className={`switch ${checked ? 'is-on' : ''}`}
    onClick={() => onChange(!checked)}
  >
    <span className="switch-knob" aria-hidden="true" />
  </button>
);

/** Label + description on the left, switch on the right. */
export const SettingToggle = ({ checked, onChange, label, description, disabled = false }) => (
  <div className="setting-toggle-row">
    <div className="setting-toggle-text">
      <span className="setting-toggle-label">{label}</span>
      {description && <span className="setting-desc">{description}</span>}
    </div>
    <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
  </div>
);

/**
 * A menu anchored to a button but rendered at the document root.
 *
 * The sidebar list scrolls (`overflow-y: auto`), and each row is a positioned
 * element, so a menu positioned inside a row is both clipped by the list and
 * painted underneath every row that follows it in the DOM. Neither is fixable
 * with z-index alone — an ancestor's overflow always wins. Portalling to the
 * body and positioning fixed sidesteps both.
 */
export const AnchoredMenu = ({ open, onClose, anchorRef, children, className = '', width = 210 }) => {
  const ref = useRef(null);
  const { mounted, state } = useTransitionState(open, 150);
  const [pos, setPos] = useState(null);

  // Layout effect, not a plain one: measuring after paint makes the menu
  // visibly jump from the corner to its place.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return undefined; }

    const place = () => {
      const anchor = anchorRef?.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const height = ref.current?.offsetHeight || 260;
      const margin = 8;

      // Flip above the button when there is not enough room below it.
      const below = window.innerHeight - rect.bottom;
      const top = below >= height + margin
        ? rect.bottom + 4
        : Math.max(margin, rect.top - height - 4);

      // Right-align to the button, then keep the whole menu on screen.
      const left = Math.min(
        Math.max(margin, rect.right - width),
        window.innerWidth - width - margin,
      );

      setPos({ top, left });
    };

    place();
    // The anchor moves when the list scrolls; `true` catches scrolls on any
    // ancestor, which is where the movement actually happens.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, anchorRef, width]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (ref.current?.contains(e.target)) return;
      if (anchorRef?.current?.contains(e.target)) return;   // the toggle handles itself
      onClose?.();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!mounted) return null;

  return createPortal(
    <div
      ref={ref}
      data-state={state}
      className={`popover anchored-menu ${className}`}
      style={{
        position: 'fixed',
        width: `${width}px`,
        top: pos ? `${pos.top}px` : 0,
        left: pos ? `${pos.left}px` : 0,
        // Measured on the first pass; showing it at 0,0 first would flash.
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
};
