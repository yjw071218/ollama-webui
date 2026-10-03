import React, { useEffect, useState } from 'react';
import { Timer, Undo2, Check, RotateCcw, CornerDownRight, FolderGit2, Gauge, Globe, Plug, PencilRuler } from 'lucide-react';
import { useI18n } from './i18n.jsx';
import { cliLabel, cliOf } from './CliLimits.jsx';
import { runIdOf, clockText, clockState, nextEffort, nextOffState } from './cliTurn.js';
import './cliTurn.css';
import { confirmDialog } from './ConfirmDialog.jsx';

/**
 * What a CLI turn shows in the chat, beyond its text:
 *
 *   CliRunClock   how long it has been working, against its time limit
 *   CliRunCard    the files a project run changed, undone all at once or
 *                 file by file (server/cliProject.js revertRun)
 *   CliTurnExtras the clock, the card, "carry on" after a timeout and "ask the
 *                 model I picked again" after a fallback, under one answer
 *   CliChips      this chat's CLI choices, above the composer
 */

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json());

export const CliRunClock = ({ started }) => {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!started) return null;
  // The browser's own clock from when the frame arrived: the server's may differ.
  const elapsed = now - (started.clientAt || started.startedAt || now);
  const limit = Number(started.timeoutMs) || 0;
  const state = clockState(elapsed, limit);
  return (
    <div className={`cli-clock is-${state}`} role="timer" aria-live="off">
      <Timer size={12} aria-hidden="true" />
      <span>{cliLabel(started.provider)}</span>
      <span className="cli-clock-time">
        {clockText(elapsed)}{limit ? ` / ${clockText(limit)}` : ''}
      </span>
      {state === 'near' && <span>{t('cliTurn.nearLimit')}</span>}
      {started.continued && <span className="cli-clock-tag">{t('cliTurn.continued')}</span>}
    </div>
  );
};

export const CliRunCard = ({ runId }) => {
  const { t } = useI18n();
  const [run, setRun] = useState(null);
  const [picked, setPicked] = useState([]);
  const [state, setState] = useState('');   // '', 'busy', or an error

  useEffect(() => {
    let stopped = false;
    fetch(`/cli/project-run?id=${encodeURIComponent(runId)}`).then(r => r.json())
      .then((d) => { if (!stopped && d.success) setRun(d.run); }).catch(() => {});
    return () => { stopped = true; };
  }, [runId]);

  if (!run || !run.files.length) return null;
  const undone = new Set(run.revertedFiles || []);
  const left = run.files.filter(f => !undone.has(f.file));

  const revert = async (files) => {
    const count = files ? files.length : left.length;
    if (!(await confirmDialog(t('cliTurn.undoConfirm', { count }), { danger: true, confirmLabel: t('changes.undoShort') }))) return;
    setState('busy');
    try {
      const d = await post('/cli/project-revert', { id: run.id, ...(files ? { files } : {}) });
      if (!d.success) throw new Error(d.error || 'failed');
      setRun(d.run);
      setPicked([]);
      setState('');
    } catch (e) { setState(e.message); }
  };

  return (
    <div className="cli-run-card">
      <div className="cli-run-head">
        <FolderGit2 size={13} aria-hidden="true" />
        <span>{t('cliTurn.runTitle', { count: run.files.length })}</span>
        <span className="cli-run-root" title={run.root}>{run.root}</span>
      </div>
      {run.files.map(f => (
        <label key={f.file} className={`cli-run-file ${undone.has(f.file) ? 'is-undone' : ''}`}>
          <input
            type="checkbox"
            disabled={undone.has(f.file) || state === 'busy'}
            checked={picked.includes(f.file)}
            onChange={e => setPicked(p => (e.target.checked ? [...p, f.file] : p.filter(x => x !== f.file)))}
          />
          <span className="cli-run-name">{f.file}</span>
          {Number.isFinite(f.added) && <span className="file-change-add">+{f.added}</span>}
          {Number.isFinite(f.removed) && <span className="file-change-del">−{f.removed}</span>}
          {undone.has(f.file) && <span className="cli-run-undone"><Check size={11} /> {t('changes.undone')}</span>}
        </label>
      ))}
      {left.length > 0 ? (
        <div className="cli-run-actions">
          <button type="button" className="btn-ghost" disabled={state === 'busy' || !picked.length} onClick={() => revert(picked)}>
            <Undo2 size={13} /> {t('cliTurn.undoPicked', { count: picked.length })}
          </button>
          <button type="button" className="btn-ghost" disabled={state === 'busy'} onClick={() => revert(null)}>
            <Undo2 size={13} /> {t('cliTurn.undoAll')}
          </button>
        </div>
      ) : (
        <div className="cli-run-done"><Check size={12} /> {t('cliTurn.allUndone')}</div>
      )}
      {state && state !== 'busy' && <div className="cli-run-error" role="alert">{state}</div>}
    </div>
  );
};

/** Everything under one CLI answer. `isLast`: only the newest answer offers
 *  to carry on or to be asked again. */
export const CliTurnExtras = ({ message, live = false, isLast = false, busy = false, onContinue, onRetryWith }) => {
  const { t } = useI18n();
  if (!message || message.role !== 'assistant') return null;
  const runId = runIdOf(message);
  const fb = message.fallback;
  const showFallback = isLast && !busy && fb && cliOf(fb.from);
  const showContinue = isLast && !busy && message.cliContinue;
  if (!(live && message.cliStarted) && !runId && !showFallback && !showContinue && !(isLast && !busy && message.cliTimedOut)) return null;
  return (
    <div className="cli-turn-extras">
      {/* Only against a real limit: with none, a clock is just noise. */}
      {live && message.cliStarted && Number(message.cliStarted.timeoutMs) > 0 && <CliRunClock started={message.cliStarted} />}
      {!live && runId && <CliRunCard runId={runId} />}
      {showContinue && (
        <button type="button" className="continue-btn" onClick={() => onContinue?.(message.cliContinue.model)}>
          <CornerDownRight size={14} />
          <span>{t('cliTurn.continue')}</span>
          <span className="continue-hint">{t('cliTurn.continueHint')}</span>
        </button>
      )}
      {!showContinue && isLast && !busy && message.cliTimedOut && (
        <div className="cli-turn-note">{t('cliTurn.timedOutNoSession')}</div>
      )}
      {showFallback && (
        <div className="cli-fallback-row">
          {fb.backAt && fb.backAt > Date.now() && (
            <span>{t('cliTurn.backAt', { name: cliLabel(cliOf(fb.from)), time: new Date(fb.backAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}</span>
          )}
          <button type="button" className="btn-ghost" onClick={() => onRetryWith?.(fb.from)}>
            <RotateCcw size={13} /> {t('cliTurn.retryWith', { model: fb.from })}
          </button>
        </div>
      )}
    </div>
  );
};

/** This chat's CLI choices, in reach of the box being typed into. Shown only
 *  for a CLI model. `options` lives on the session as `cliOptions`. */
export const CliChips = ({ model, session, onChange }) => {
  const { t } = useI18n();
  const cli = cliOf(model);
  if (!cli || !session) return null;
  const o = session.cliOptions || {};
  const set = (patch) => onChange({ cliOptions: { ...o, ...patch } });
  const tri = (v) => (v === 'off' ? t('cli.offShort') : t('cliTurn.default'));
  return (
    <div className="cli-chips" role="toolbar" aria-label={t('cliTurn.chipsLabel', { name: cliLabel(cli) })}>
      {session.cliProject && (
        <button
          type="button"
          className={`cli-chip ${session.cliProjectMode === 'edit' ? 'is-on' : ''}`}
          title={session.cliProject}
          onClick={() => onChange({ cliProjectMode: session.cliProjectMode === 'edit' ? 'plan' : 'edit' })}
        >
          <PencilRuler size={12} aria-hidden="true" />
          {t(`cliAgent.mode.${session.cliProjectMode === 'edit' ? 'edit' : 'plan'}`)}
        </button>
      )}
      <button type="button" className={`cli-chip ${o.effort ? 'is-on' : ''}`} title={t('cli.effortSetting')} onClick={() => set({ effort: nextEffort(o.effort) })}>
        <Gauge size={12} aria-hidden="true" />
        {t('cliTurn.effort')}: {o.effort ? t(`cliTurn.effort.${o.effort}`) : t('cliTurn.default')}
      </button>
      {cli === 'claude-code' && (
        <button type="button" className={`cli-chip ${o.web ? 'is-on' : ''}`} onClick={() => set({ web: nextOffState(o.web) })}>
          <Globe size={12} aria-hidden="true" />
          {t('cliTurn.web')}: {tri(o.web)}
        </button>
      )}
      <button type="button" className={`cli-chip ${o.mcp ? 'is-on' : ''}`} onClick={() => set({ mcp: nextOffState(o.mcp) })}>
        <Plug size={12} aria-hidden="true" />
        MCP: {tri(o.mcp)}
      </button>
    </div>
  );
};

export default CliTurnExtras;
