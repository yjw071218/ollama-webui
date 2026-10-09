import React, { useEffect, useState } from 'react';
import { FilePen, ChevronDown, Undo2, Code2, Check, PanelRight } from 'lucide-react';
import { useI18n } from './i18n.jsx';
import { diffLines } from './fileChanges.js';
import { confirmDialog } from './ConfirmDialog.jsx';

/**
 * What the tools changed on disk this turn, shown with the answer.
 *
 * The tool steps fold away once an answer is written, and the diff a tool
 * returned went with them -- so "I updated App.jsx" arrived with nothing to
 * check it against. Each changed file is a row here: its name and counts, and
 * the diff one click away (open already when there are only a few lines).
 *
 * A file the workbench changed can be put back as it was before the agent
 * started on it (server/workbenchState.js keeps that copy), and any file with
 * a full path opens in VS Code.
 */
const isAbsolute = (file) => /^([a-zA-Z]:[\\/]|\/)/.test(String(file || ''));
const vscodeUrl = (file) => `vscode://file/${String(file).replace(/\\/g, '/').replace(/^\/+/, '')}`;
/* The PC app does not follow vscode:// links from the page (only web links
   pass), so there the app opens the file itself: VS Code if it is installed,
   otherwise the file's default program. */
const openEditor = (file) => (e) => {
  const native = typeof window !== 'undefined' && (window.ollamaNative?.openInEditor || window.ollamaNative?.openLocalPath); // an older app has only the second: the file opens in its own program
  if (!native) return;
  e.preventDefault();
  native(String(file)).catch(err => alert(String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
};


export const FileChanges = ({ changes = [], inline = false }) => {
  const { t } = useI18n();
  const [undoable, setUndoable] = useState({});
  const files = changes.map(c => c.file).filter(isAbsolute);
  const key = files.join('\n');

  useEffect(() => {
    if (!files.length) return undefined;
    let stopped = false;
    fetch('/cli/workbench/revert', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }),
    }).then(r => r.json()).then((d) => { if (!stopped && d.success) setUndoable(d.files || {}); }).catch(() => {});
    return () => { stopped = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!changes.length) return null;
  return (
    <div className={`file-changes ${inline ? 'is-inline' : ''}`} aria-label={t('changes.title')}>
      {/* Inline, under the sentence that announced it: the row is its own title. */}
      {!inline && <div className="file-changes-head">
        <FilePen size={13} aria-hidden="true" />
        <span>{t('changes.title')}</span>
        <span className="file-changes-count">{t('changes.count', { count: changes.length })}</span>
      </div>}
      {changes.map((change, i) => (
        <FileChange key={`${change.file}-${i}`} change={change} canUndo={!!undoable[change.file]} />
      ))}
    </div>
  );
};

const FileChange = ({ change, canUndo }) => {
  const { t } = useI18n();
  const small = change.added + change.removed <= 12;
  const [open, setOpen] = useState(small);
  const [state, setState] = useState('');     // '', 'busy', 'done', or an error
  const name = String(change.file).split(/[\\/]/).pop();

  const undo = async () => {
    if (!(await confirmDialog(t('changes.undoConfirm', { file: change.file }), { danger: true, confirmLabel: t('changes.undoShort') }))) return;
    setState('busy');
    try {
      const d = await fetch('/cli/workbench/revert', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: change.file }),
      }).then(r => r.json());
      setState(d.success ? 'done' : (d.error || 'failed'));
    } catch (e) { setState(e.message); }
  };

  return (
    <div className={`file-change ${open ? 'is-open' : ''} ${state === 'done' ? 'is-reverted' : ''}`}>
      <div className="file-change-line">
        <button type="button" className="file-change-row" onClick={() => setOpen(!open)} aria-expanded={open} title={change.file}>
          <ChevronDown size={12} className="file-change-chevron" aria-hidden="true" />
          <span className="file-change-name">{name}</span>
          <span className="file-change-path">{change.file}</span>
          <span className="file-change-add">+{change.added}</span>
          <span className="file-change-del">−{change.removed}</span>
        </button>
        <span className="file-change-actions">
          {change.diff && (
            <button type="button" className="file-change-action" title="코드 패널에서 보기/닫기" aria-label="코드 패널에서 보기/닫기"
              onClick={() => window.dispatchEvent(new CustomEvent('open-file-diff', { detail: { file: String(change.file), diff: String(change.diff) } }))}>
              <PanelRight size={14} />
            </button>
          )}
          {isAbsolute(change.file) && (
            <a className="file-change-action" href={vscodeUrl(change.file)} onClick={openEditor(change.file)} title={t('changes.openEditor')} aria-label={t('changes.openEditor')}>
              <Code2 size={14} />
            </a>
          )}
          {state === 'done'
            ? <span className="file-change-undone"><Check size={12} /> {t('changes.undone')}</span>
            : canUndo && (
              <button type="button" className="file-change-action file-change-undo" onClick={undo} disabled={state === 'busy'} title={t('changes.undo')} aria-label={t('changes.undo')}>
                <Undo2 size={14} />
              </button>
            )}
        </span>
      </div>
      {state && !['busy', 'done'].includes(state) && <div className="file-change-error">{state}</div>}
      {open && (
        <pre className="file-change-diff">
          {diffLines(change.diff).map((line, n) => (
            <span key={n} className={`diff-line diff-${line.kind}`}>{line.text || ' '}{'\n'}</span>
          ))}
        </pre>
      )}
    </div>
  );
};

export default FileChanges;
