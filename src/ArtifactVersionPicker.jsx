import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';

/* The artifact panel's version picker.
 *
 * It was a native <select>, which on Windows opens a white system list that
 * ignores the app's theme. This is the same choice drawn by the app: a pill
 * that says which version is shown, and a themed list of every version with
 * its language and length, the newest at the bottom like the old one and the
 * shown one scrolled into view. The list is portalled to <body>, because the
 * title row clips overflow so a long picker can shorten instead of pushing
 * the buttons off. Keyboard: arrows, Home/End, Enter, Escape. */
export default function ArtifactVersionPicker({ items, value, onChange, linesLabel = 'lines' }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const [pos, setPos] = useState(null);
  const button = useRef(null);
  const list = useRef(null);
  const current = items.find(a => a.id === value) || items[items.length - 1];
  const newest = items.reduce((m, a) => Math.max(m, a.version || 0), 0);

  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(240, r.width);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 220 && above > below;
    setPos({ left, width, top: up ? undefined : r.bottom + 6, bottom: up ? window.innerHeight - r.top + 6 : undefined, max: Math.min(380, up ? above : below) });
  };

  const show = () => {
    place();
    setAt(Math.max(0, items.findIndex(a => a.id === value)));
    setOpen(true);
  };
  const choose = (a) => { setOpen(false); button.current?.focus(); if (a && a.id !== value) onChange(a.id); };

  useLayoutEffect(() => {
    if (!open) return;
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
    list.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    list.current?.children[at]?.scrollIntoView({ block: 'nearest' });
    return undefined;
  }, [at, open]);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!list.current?.contains(e.target) && !button.current?.contains(e.target)) setOpen(false); };
    const moved = () => place();
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('resize', moved);
    window.addEventListener('scroll', moved, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('resize', moved);
      window.removeEventListener('scroll', moved, true);
    };
  }, [open]);

  const keys = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt(i => Math.min(items.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt(i => Math.max(0, i - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setAt(0); }
    else if (e.key === 'End') { e.preventDefault(); setAt(items.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(items[at]); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); setOpen(false); button.current?.focus(); }
  };

  if (!current) return null;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`artifact-version-picker${open ? ' is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); show(); } }}
      >
        <span className="avp-ver">v{current.version}</span>
        <span className="avp-meta">{current.language || 'code'} · {current.lineCount} {linesLabel}</span>
        <ChevronDown size={14} className="avp-chevron" />
      </button>
      {open && pos && createPortal(
        <ul
          ref={list}
          className={`artifact-version-menu${pos.bottom != null ? ' is-up' : ''}`}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={`avp-${items[at]?.id}`}
          onKeyDown={keys}
          style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.max }}
        >
          {items.map((a, i) => {
            const selected = a.id === value;
            return (
              <li
                key={a.id}
                id={`avp-${a.id}`}
                role="option"
                aria-selected={selected}
                className={`avp-item${selected ? ' is-selected' : ''}${i === at ? ' is-active' : ''}`}
                onPointerMove={() => setAt(i)}
                onClick={() => choose(a)}
              >
                <span className="avp-ver">v{a.version}</span>
                <span className="avp-meta">{a.language || 'code'}</span>
                <span className="avp-lines">{a.lineCount} {linesLabel}</span>
                {a.version === newest && <span className="avp-tag">최신</span>}
                <span className="avp-check">{selected && <Check size={14} />}</span>
              </li>
            );
          })}
        </ul>,
        document.body,
      )}
    </>
  );
}
