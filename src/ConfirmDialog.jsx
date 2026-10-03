import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TriangleAlert } from 'lucide-react';
import { useI18n } from './i18n.jsx';

/**
 * The app's replacement for window.confirm() and alert().
 *
 *   if (!(await confirmDialog(t('models.deleteConfirm', { name }), { danger: true }))) return;
 *   await alertDialog(message);
 *
 * The native boxes ignore the theme, look foreign in an installed PWA, block the
 * page (a stream in flight stalls behind them on some browsers) and give a
 * destructive action the same grey "OK" as a harmless one. One host, mounted
 * once by the App, shows whichever request is first in the queue.
 */
let push = null;
const waiting = [];

const ask = (req) => new Promise((resolve) => {
  const item = { ...req, resolve };
  if (push) push(item); else waiting.push(item);
});

export const confirmDialog = (message, opts = {}) => ask({ kind: 'confirm', message, ...opts });
export const alertDialog = (message, opts = {}) => ask({ kind: 'alert', message, ...opts });
/* window.prompt(): resolves to the text, or null when cancelled. */
export const promptDialog = (message, opts = {}) => ask({ kind: 'prompt', message, ...opts });

export function ConfirmDialogHost() {
  const { t } = useI18n();
  const [queue, setQueue] = useState([]);
  const okRef = useRef(null);
  const cancelRef = useRef(null);
  const inputRef = useRef(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    push = (item) => setQueue(q => [...q, item]);
    if (waiting.length) setQueue(q => [...q, ...waiting.splice(0)]);
    return () => { push = null; };
  }, []);

  const current = queue[0];
  const done = (ok) => {
    current?.resolve(current?.kind === 'prompt' ? (ok ? value : null) : ok);
    setQueue(q => q.slice(1));
  };

  useEffect(() => {
    if (!current) return undefined;
    const back = document.activeElement;
    setValue(current.defaultValue || '');
    // A destructive question starts on "Cancel", so a stray Enter does nothing;
    // a question that wants text starts in its field.
    (current.kind === 'prompt' ? inputRef.current : current.danger ? cancelRef.current : okRef.current)?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); done(current.kind === 'alert'); }
      if (e.key === 'Tab') {
        const order = [inputRef.current, cancelRef.current, okRef.current].filter(Boolean);
        const i = order.indexOf(document.activeElement);
        e.preventDefault();
        order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length]?.focus();
      }
    };
    // window + capture: first in line, so Esc closes this and not the panel under it.
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      back?.focus?.({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  if (!current) return null;
  const [title, ...rest] = String(current.message ?? '').split(/\n\s*\n/);
  const body = current.title ? String(current.message ?? '') : rest.join('\n\n');
  const heading = current.title || title;

  return createPortal(
    <div className="confirm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) done(current.kind === 'alert'); }}>
      <div
        className={`confirm-dialog${current.danger ? ' is-danger' : ''}`}
        role={current.kind === 'alert' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={body ? 'confirm-dialog-body' : undefined}
      >
        <div className="confirm-dialog-head">
          {current.danger && <TriangleAlert size={18} aria-hidden="true" />}
          <h2 id="confirm-dialog-title">{heading}</h2>
        </div>
        {body && <p id="confirm-dialog-body">{body}</p>}
        {current.kind === 'prompt' && (
          <input
            ref={inputRef}
            className="settings-input confirm-dialog-input"
            value={value}
            placeholder={current.placeholder || ''}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); done(true); } }}
          />
        )}
        <div className="confirm-dialog-actions">
          {current.kind !== 'alert' && (
            <button ref={cancelRef} type="button" className="btn-secondary" onClick={() => done(false)}>
              {current.cancelLabel || t('common.cancel')}
            </button>
          )}
          <button
            ref={okRef}
            type="button"
            className={current.danger ? 'btn-danger' : 'btn-primary'}
            onClick={() => done(true)}
          >
            {current.confirmLabel || (current.danger ? t('common.delete') : t('common.confirm'))}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
