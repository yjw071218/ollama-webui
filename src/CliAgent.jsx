import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldQuestion, Undo2, Flag, Puzzle, History, Check, X, GitMerge, Trash2 } from 'lucide-react';
import { useI18n } from './i18n.jsx';
import { cliLabel } from './CliLimits.jsx';
import { groupSessions } from './cliTurn.js';
import { confirmDialog } from './ConfirmDialog.jsx';

/**
 * The CLIs as coding agents (server/cliProject.js), in the browser:
 *
 *   CliApprovals   questions a CLI working in a folder is waiting on, over
 *                  everything, wherever the reader is in the app
 *   CliAgentPanel  in settings: folders, budget, runs to undo, worktree races,
 *                  skills/agents/prompts, and terminal sessions to carry on
 */

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json());

const muted = { fontSize: '0.75rem', color: 'var(--text-muted)' };
const mono = { fontFamily: 'var(--font-mono, monospace)' };

/* ------------------------------------------------------------ approvals */

export const CliApprovals = () => {
  const { t } = useI18n();
  const [list, setList] = useState([]);
  const busy = useRef(false);

  useEffect(() => {
    let stopped = false;
    let timer = null;
    const tick = async () => {
      if (stopped) return;
      if (!document.hidden && !busy.current) {
        try {
          const d = await fetch('/cli/approvals').then(r => r.json());
          if (!stopped && d.success) setList(d.approvals || []);
        } catch { /* the server is away; asked again next time */ }
      }
      // Quicker while something is waiting: a CLI is paused on it.
      timer = setTimeout(tick, list.length ? 1500 : 4000);
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [list.length]);

  const decide = async (id, decision) => {
    busy.current = true;
    setList(l => l.filter(a => a.id !== id));
    try { await post('/cli/approvals', { id, decision }); } finally { busy.current = false; }
  };

  if (!list.length) return null;
  return (
    <div className="cli-approvals" role="alertdialog" aria-label={t('cliAgent.approvalTitle')}
      style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 'var(--z-dock)', width: 'min(440px, calc(100vw - 32px))', display: 'grid', gap: 8 }}>
      {list.map(a => (
        <div key={a.id} style={{ background: 'var(--bg-secondary, #1e1e1e)', border: '1px solid var(--warning, #d97706)', borderRadius: 10, padding: 12, boxShadow: '0 6px 24px rgba(0,0,0,.35)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: '0.85rem' }}>
            <ShieldQuestion size={15} style={{ color: 'var(--warning, #d97706)' }} />
            {t('cliAgent.approvalAsks', { cli: cliLabel(a.provider) })}
          </div>
          <div style={{ ...mono, fontSize: '0.8rem', marginTop: 6, wordBreak: 'break-all' }}>{a.title}</div>
          {a.detail && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ ...muted, cursor: 'pointer' }}>{t('cliAgent.details')}</summary>
              <pre style={{ ...mono, fontSize: '0.72rem', maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{a.detail}</pre>
            </details>
          )}
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <button className="btn-primary" onClick={() => decide(a.id, 'accept')}><Check size={13} /> {t('cliAgent.allowOnce')}</button>
            <button className="btn-ghost" onClick={() => decide(a.id, 'acceptForSession')}>{t('cliAgent.allowSession')}</button>
            <button className="btn-ghost" style={{ color: 'var(--danger)' }} onClick={() => decide(a.id, 'decline')}><X size={13} /> {t('cliAgent.decline')}</button>
          </div>
          <div style={{ ...muted, marginTop: 4 }}>{t('cliAgent.approvalTimeout')}</div>
        </div>
      ))}
    </div>
  );
};

/* ---------------------------------------------------------------- races */

const RaceBox = ({ roots, models }) => {
  const { t } = useI18n();
  const [dir, setDir] = useState(roots[0] || '');
  const [prompt, setPrompt] = useState('');
  const [picked, setPicked] = useState([]);
  const [race, setRace] = useState(null);
  const [error, setError] = useState('');
  // One request at a time: a second tap used to start a second race.
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!race || race.entries.every(e => e.status !== 'running')) return undefined;
    const timer = setTimeout(async () => {
      const d = await fetch(`/cli/race?id=${encodeURIComponent(race.id)}`).then(r => r.json()).catch(() => null);
      if (d?.success) setRace(d.race);
    }, 3000);
    return () => clearTimeout(timer);
  }, [race]);

  const start = async () => {
    if (busy) return;
    setError('');
    setBusy(true);
    const d = await post('/cli/race', { dir, prompt, models: picked }).catch(e => ({ error: e.message }));
    setBusy(false);
    if (d.success) setRace(d.race); else setError(d.error || 'failed');
  };
  const finish = async (winner) => {
    if (busy) return;
    setError('');
    setBusy(true);
    const d = await post('/cli/race-finish', { id: race.id, winner }).catch(e => ({ error: e.message }));
    setBusy(false);
    if (d.success) setRace(null); else setError(d.error || 'failed');
  };

  if (race) {
    const running = race.entries.some(e => e.status === 'running');
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        <div style={muted}>{t('cliAgent.raceOn', { task: race.prompt.slice(0, 80) })}</div>
        {race.entries.map((e, i) => (
          <div key={e.branch} style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'center' }}>
              <strong style={{ fontSize: '0.8rem', ...mono }}>{e.model}</strong>
              <span style={{ ...muted, color: e.status === 'failed' ? 'var(--danger)' : muted.color }}>
                {t(`cliAgent.race.${e.status}`)}{e.files?.length ? ` · ${e.files.map(f => `${f.file} +${f.added}/−${f.removed}`).join(', ')}` : ''}
              </span>
            </div>
            {e.error && <div style={{ ...muted, color: 'var(--danger)' }}>{e.error}</div>}
            {e.text && <details><summary style={{ ...muted, cursor: 'pointer' }}>{t('cliAgent.answer')}</summary><div style={{ fontSize: '0.78rem', whiteSpace: 'pre-wrap' }}>{e.text}</div></details>}
            {e.diff && <details><summary style={{ ...muted, cursor: 'pointer' }}>diff</summary><pre style={{ ...mono, fontSize: '0.7rem', maxHeight: 300, overflow: 'auto' }}>{e.diff}</pre></details>}
            {e.status === 'done' && !running && (
              <button className="btn-ghost" disabled={busy} onClick={() => finish(i)}><GitMerge size={13} /> {t('cliAgent.merge')}</button>
            )}
          </div>
        ))}
        {!running && <button className="btn-ghost" disabled={busy} onClick={() => finish(null)}><Trash2 size={13} /> {t('cliAgent.discard')}</button>}
        {error && <div style={{ ...muted, color: 'var(--danger)' }}>{error}</div>}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <input value={dir} onChange={e => setDir(e.target.value)} placeholder={roots[0] || 'C:\\path\\to\\repo'} list="cli-project-roots" style={mono} />
      <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} placeholder={t('cliAgent.racePrompt')} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {models.map(m => (
          <label key={m} style={{ ...muted, display: 'flex', gap: 4, alignItems: 'center' }}>
            <input type="checkbox" checked={picked.includes(m)} onChange={e => setPicked(p => (e.target.checked ? [...p, m] : p.filter(x => x !== m)))} />
            <span style={mono}>{m}</span>
          </label>
        ))}
      </div>
      <button className="btn-primary" disabled={busy || !dir || !prompt.trim() || !picked.length} onClick={start}><Flag size={13} /> {t('cliAgent.raceStart')}</button>
      <div style={muted}>{t('cliAgent.raceHelp')}</div>
      {error && <div style={{ ...muted, color: 'var(--danger)' }}>{error}</div>}
    </div>
  );
};

/* ------------------------------------------------- terminal sessions */

/* Searchable, grouped by the folder each ran in, and looked into before being
   brought over: a title alone ("fix the build") rarely says which one. */
const PREVIEW_MESSAGES = 6;
const TerminalSessions = ({ sessions, when, onImport, onError }) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState('');        // the key being previewed
  const [preview, setPreview] = useState({});  // key -> session
  const groups = groupSessions(sessions, query);

  const toggle = async (key) => {
    if (open === key) { setOpen(''); return; }
    setOpen(key);
    if (preview[key]) return;
    const d = await fetch(`/cli/terminal-sessions?key=${encodeURIComponent(key)}`).then(r => r.json()).catch(e => ({ error: e.message }));
    if (!d.success) { onError?.(d.error || 'failed'); setOpen(''); return; }
    setPreview(p => ({ ...p, [key]: d.session }));
  };

  return (
    <>
      <input
        type="search"
        className="cli-terminal-search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={t('cliAgent.terminalSearch')}
        aria-label={t('cliAgent.terminalSearch')}
      />
      {!groups.length && <div style={muted}>{t('cliAgent.terminalNoMatch')}</div>}
      {groups.map(g => (
        <div key={g.cwd || '-'} className="cli-terminal-group">
          <div className="cli-terminal-folder" title={g.cwd}>{g.cwd || t('cliAgent.terminalNoFolder')} · {g.sessions.length}</div>
          {g.sessions.map(s => (
            <div key={s.key}>
              <div style={{ ...muted, display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'center', marginTop: 3 }}>
                <span>{cliLabel(s.provider)} · {when(s.at)} · <span style={{ color: 'var(--text-primary)' }}>{s.title}</span></span>
                <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button className="btn-ghost" aria-expanded={open === s.key} onClick={() => toggle(s.key)}>{t('cliAgent.preview')}</button>
                  <button className="btn-ghost" onClick={() => onImport(s.key)}>{t('cliAgent.import')}</button>
                </span>
              </div>
              {open === s.key && (
                <div className="cli-terminal-preview">
                  {!preview[s.key] && <div style={muted}>…</div>}
                  {preview[s.key]?.messages.slice(0, PREVIEW_MESSAGES).map((m, i) => (
                    <div key={i} className="cli-terminal-preview-msg">
                      <span className="cli-terminal-preview-role">{m.role === 'user' ? t('cliAgent.you') : cliLabel(s.provider)}</span>
                      {String(m.content || '').slice(0, 600)}{String(m.content || '').length > 600 ? '…' : ''}
                    </div>
                  ))}
                  {preview[s.key]?.messages.length > PREVIEW_MESSAGES && (
                    <div style={muted}>{t('cliAgent.previewMore', { n: preview[s.key].messages.length - PREVIEW_MESSAGES })}</div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </>
  );
};

/* ----------------------------------------------------------- the panel */

export const CliAgentPanel = ({ providers = [], onImportChat, refreshKey = 0 }) => {
  const { t, lang } = useI18n();
  const [project, setProject] = useState(null);
  const [extensions, setExtensions] = useState(null);
  const [terminal, setTerminal] = useState(null);
  /* { text, error }: a failure is shown as one, and either goes after a while
     instead of staying under the heading for good. */
  const [message, setMessageState] = useState(null);
  const setMessage = useCallback((text, error = false) => setMessageState(text ? { text, error } : null), []);
  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(() => setMessageState(null), message.error ? 12000 : 5000);
    return () => clearTimeout(timer);
  }, [message]);

  // The three lists at once, not one after another.
  const load = useCallback(async () => {
    const json = (url) => fetch(url).then(r => r.json()).catch(() => null);
    const [p, x] = await Promise.all([json('/cli/project'), json('/cli/extensions')]);
    if (p?.success) setProject(p);
    if (x?.success) setExtensions(x);
    if (p?.terminalImport) {
      const s = await json('/cli/terminal-sessions?limit=200');
      if (s?.success) setTerminal(s.sessions);
    }
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  if (!project) return null;
  const models = providers.filter(p => p.offered).flatMap(p => p.models.map(m => `${p.id}:${m}`));
  const when = (ms) => new Date(ms).toLocaleString(lang);

  const undo = async (id) => {
    if (!(await confirmDialog(t('cliAgent.undoConfirm'), { danger: true, confirmLabel: t('cliAgent.undo') }))) return;
    const d = await post('/cli/project-revert', { id }).catch(e => ({ error: e.message }));
    setMessage(d.success ? t('cliAgent.undone') : (d.error || 'failed'), !d.success);
    load();
  };
  const toggle = async (file, enabled) => {
    const d = await post('/cli/extensions', { file, enabled }).catch(e => ({ error: e.message }));
    if (!d.success) setMessage(d.error || 'failed', true);
    load();
  };
  const importSession = async (key) => {
    const d = await fetch(`/cli/terminal-sessions?key=${encodeURIComponent(key)}`).then(r => r.json()).catch(e => ({ error: e.message }));
    if (!d.success) { setMessage(d.error || 'failed', true); return; }
    onImportChat?.(d.session);
    setMessage(t('cliAgent.imported', { n: d.session.messages.length }));
  };

  const section = { marginTop: '0.9rem' };
  const heading = { fontWeight: 600, fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: 6 };

  return (
    <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
      <div style={heading}>{t('cliAgent.title')}</div>
      <datalist id="cli-project-roots">{project.roots.map(r => <option key={r} value={r} />)}</datalist>
      <div style={{ ...muted, display: 'grid', gap: 2, marginTop: 4 }}>
        <div>{t('cliAgent.roots')}: {project.roots.length ? <span style={mono}>{project.roots.join(', ')}</span> : t('cliAgent.rootsNone')}</div>
        <div>{t('cliAgent.maxTurns')}: {project.maxTurns || '—'}</div>
        <div>
          {t('cliAgent.budget')}: ${project.budget.spent.toFixed(2)}
          {project.budget.cap ? ` / $${project.budget.cap}` : ` (${t('cliAgent.budgetNone')})`}
          {project.budget.over && <strong style={{ color: 'var(--danger)' }}> · {t('cliAgent.budgetOver')}</strong>}
        </div>
        <div>{t('cliAgent.agyEdit')}: {t(project.agyEdit ? 'cli.on' : 'cli.offShort')}</div>
      </div>
      {message && (
        <div role={message.error ? 'alert' : 'status'} style={{ ...muted, marginTop: 4, color: message.error ? 'var(--danger)' : muted.color }}>
          {message.text}
        </div>
      )}

      {project.roots.length > 0 && (
        <>
          <div style={section}>
            <div style={heading}><History size={13} /> {t('cliAgent.runs')}</div>
            {!project.runs.length && <div style={muted}>{t('cliAgent.runsNone')}</div>}
            {project.runs.slice(0, 15).map(r => (
              <div key={r.id} style={{ ...muted, display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'center', marginTop: 3 }}>
                <span>
                  {when(r.at)} · <span style={mono}>{r.root.split(/[\\/]/).pop()}</span> · {r.files.map(f => f.file).slice(0, 4).join(', ')}{r.files.length > 4 ? ` +${r.files.length - 4}` : ''}
                </span>
                {r.reverted
                  ? <span>{t('cliAgent.undone')}</span>
                  : <button className="btn-ghost" onClick={() => undo(r.id)}><Undo2 size={12} /> {t('cliAgent.undo')}</button>}
              </div>
            ))}
          </div>
          <div style={section}>
            <div style={heading}><Flag size={13} /> {t('cliAgent.race')}</div>
            <RaceBox roots={project.roots} models={models} />
          </div>
        </>
      )}

      <div style={section}>
        <div style={heading}><Puzzle size={13} /> {t('cliAgent.extensions')}</div>
        {!extensions?.extensions?.length && <div style={muted}>{t('cliAgent.extensionsNone')}</div>}
        {(extensions?.extensions || []).map(x => (
          <label key={x.file} style={{ ...muted, display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 3 }} title={x.file}>
            <input type="checkbox" checked={x.enabled} disabled={!extensions.editable} onChange={e => toggle(x.file, e.target.checked)} />
            <span>
              <strong style={{ color: 'var(--text-primary)' }}>{x.name}</strong>
              {' '}<span>({cliLabel(x.provider)} · {t(`cliAgent.kind.${x.kind}`)})</span>
              {x.description && <div>{x.description}</div>}
            </span>
          </label>
        ))}
        {extensions && !extensions.editable && extensions.extensions?.length > 0 && <div style={muted}>{t('cliAgent.extensionsReadOnly')}</div>}
      </div>

      <div style={section}>
        <div style={heading}><History size={13} /> {t('cliAgent.terminal')}</div>
        {!project.terminalImport && <div style={muted}>{t('cliAgent.terminalOff')}</div>}
        {terminal && !terminal.length && <div style={muted}>{t('cliAgent.terminalNone')}</div>}
        {terminal && terminal.length > 0 && (
          <TerminalSessions sessions={terminal} when={when} onImport={importSession} onError={(e) => setMessage(e, true)} />
        )}
      </div>
    </div>
  );
};

export default CliAgentPanel;
