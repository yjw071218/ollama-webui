import React, { useState, useEffect, useRef, useCallback } from 'react';

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
}) => {
  const [dragging, setDragging] = useState(false);
  const originRef = useRef(0);
  const startRef = useRef(0);

  const limits = useCallback(() => [min, typeof max === 'function' ? max() : max], [min, max]);

  const apply = useCallback((next) => {
    const [lo, hi] = limits();
    setSize(clamp(next, lo, Math.max(lo, hi)));
  }, [limits, setSize]);

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    startRef.current = axis === 'x' ? e.clientX : e.clientY;
    originRef.current = getSize();
    setDragging(true);
  };

  const onPointerMove = (e) => {
    if (!dragging) return;
    const current = axis === 'x' ? e.clientX : e.clientY;
    apply(originRef.current + (current - startRef.current) * direction);
  };

  const endDrag = (e) => {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDragging(false);
  };

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
    return () => { document.body.style.userSelect = previous; };
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

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose?.();
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
