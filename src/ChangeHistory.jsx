import React, { useEffect, useMemo, useState } from 'react';
import { Undo2, Code2, Check, RefreshCcw, FilePlus2, FilePen, Search } from 'lucide-react';
import { useI18n } from './i18n.jsx';

/**
 * Every file the workbench changed recently (server/workbenchState.js keeps
 * the copy from before), in one list: search it, open one in VS Code, or put
 * it back -- without hunting for the chat the change was made in.
 */
const vscodeUrl = (file) => `vscode://file/${String(file).replace(/\\/g, '/').replace(/^\/+/, '')}`;

const ago = (at, t) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return t('history.justNow');
  if (s < 3600) return t('history.minutes', { n: Math.floor(s / 60) });
  if (s < 86400) return t('history.hours', { n: Math.floor(s / 3600) });
  return new Date(at).toLocaleDateString();
};

export const ChangeHistory = () => {
  const { t } = useI18n();
  const [items, setItems] = useState(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = () => fetch('/cli/workbench/revert').then(r => r.json())
    .then(d => setItems(d.success ? d.backups : [])).catch(() => setItems([]));
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items || []).filter(i => !q || i.file.toLowerCase().includes(q));
  }, [items, query]);

  const undo = async (file) => {
    if (!window.confirm(t('changes.undoConfirm', { file }))) return;
    setBusy(file); setError('');
    try {
      const d = await fetch('/cli/workbench/revert', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }),
      }).then(r => r.json());
      if (!d.success) setError(d.error || 'failed');
    } catch (e) { setError(e.message); }
    setBusy('');
    load();
  };

  return (
    <div className="chg-panel">
      <div className="chg-head">
        <div className="chg-search">
          <Search size={13} aria-hidden="true" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('history.search')} aria-label={t('history.search')} />
        </div>
        <button type="button" className="btn-ghost chg-refresh" onClick={load} title={t('history.refresh')}><RefreshCcw size={13} /></button>
      </div>
      <div className="chg-help">{t('history.help')}</div>
      {error && <div className="chg-error">{error}</div>}
      {items === null && <div className="chg-empty">…</div>}
      {items && !shown.length && <div className="chg-empty">{t('history.none')}</div>}
      <ul className="chg-list">
        {shown.map((item) => {
          const parts = item.file.split(/[\\/]/);
          const name = parts.pop();
          return (
            <li key={item.file} className={`chg-item ${item.restored ? 'is-restored' : ''}`}>
              <span className="chg-icon">{item.created ? <FilePlus2 size={14} /> : <FilePen size={14} />}</span>
              <div className="chg-main">
                <div className="chg-name">{name}</div>
                <div className="chg-path" title={item.file}>{parts.join('\\')}</div>
              </div>
              <span className="chg-when">{item.restored ? t('changes.undone') : ago(item.at, t)}</span>
              <a className="btn-ghost chg-btn" href={vscodeUrl(item.file)} title={t('changes.openEditor')} aria-label={t('changes.openEditor')}><Code2 size={14} /></a>
              {item.restored
                ? <span className="chg-done"><Check size={14} /></span>
                : (
                  <button type="button" className="chg-undo" disabled={busy === item.file} onClick={() => undo(item.file)}>
                    <Undo2 size={13} /> {t('changes.undoShort')}
                  </button>
                )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default ChangeHistory;
