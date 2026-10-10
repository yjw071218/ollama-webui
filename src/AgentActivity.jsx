import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import {
  Terminal, FilePen, FileText, Search, Globe, Wrench, ShieldQuestion, ListTodo,
  Check, X, Loader2, Clock, ChevronDown, Square, Activity, Download, ExternalLink, Radio, Braces,
} from 'lucide-react';
import { useI18n } from './i18n.jsx';
import { CliPromptCard } from './CliPrompt.jsx';
import { activityOf, activitySummary } from './agentActivity.js';
import { ansiSpans, outputLines, errorCount } from './terminalText.js';

/**
 * A coding CLI's work, drawn as it happens.
 *
 *   AgentActivity  the steps in a CLI's thinking (src/agentActivity.js) as a
 *                  timeline: what it read, edited and ran, how long each took,
 *                  its arguments and result on request, and an approval it is
 *                  waiting on answered right there
 *   LiveCommands   commands running right now for this answer
 *                  (server/liveCommands.js), as a small terminal
 *   CommandsDock   every running command, wherever the reader is in the app
 */

const ICONS = {
  command: Terminal, edit: FilePen, read: FileText, search: Search, web: Globe,
  fetch: Globe, task: ListTodo, approval: ShieldQuestion, tool: Wrench,
};

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json());

const shortPath = (target) => {
  const text = String(target || '');
  if (!/[\\/]/.test(text) || /\s/.test(text.trim())) return text;
  const parts = text.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : text;
};

export const duration = (ms) => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

const pretty = (json) => { try { return JSON.stringify(JSON.parse(json), null, 2); } catch { return json; } };

/* A clock that ticks while `on`, for the time a running step has taken. */
const useNow = (on) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
};

/* ------------------------------------------------------------ output */

/**
 * Output as a terminal shows it: colours, error lines marked, a filter, and
 * the whole log to download when there is one on the server.
 */
export const OutputView = ({ text, follow = false, logId = '', className = '' }) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const box = useRef(null);
  const pinned = useRef(true);
  const lines = useMemo(() => {
    const all = outputLines(text, { query, limit: 600 });
    return errorsOnly ? all.filter(l => l.tone === 'error') : all;
  }, [text, query, errorsOnly]);
  const errors = useMemo(() => errorCount(text), [text]);
  const long = String(text || '').split('\n').length > 12;

  useEffect(() => {
    // Follow new output unless the reader scrolled up to read something.
    if (follow && box.current && pinned.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text, follow]);

  return (
    <div className={`term ${className}`}>
      {(long || logId || errors > 0) && (
        <div className="term-bar">
          <Search size={11} aria-hidden="true" />
          <input
            className="term-search" value={query} onChange={e => setQuery(e.target.value)}
            placeholder={t('agent.searchOutput')} aria-label={t('agent.searchOutput')}
          />
          {errors > 0 && (
            <button type="button" className={`term-chip ${errorsOnly ? 'is-on' : ''}`} onClick={() => setErrorsOnly(!errorsOnly)} title={t('agent.errorsOnly')}>
              <X size={10} /> {errors}
            </button>
          )}
          {logId && (
            <a className="term-chip" href={`/cli/commands/log?id=${encodeURIComponent(logId)}`} download title={t('agent.downloadLog')}>
              <Download size={10} /> {t('agent.log')}
            </a>
          )}
        </div>
      )}
      <pre
        ref={box}
        className="term-body"
        onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
      >
        {!String(text || '').trim()
          ? <span className="term-empty">{t('agent.noOutputYet')}</span>
          : lines.length === 0
            ? <span className="term-empty">{t('agent.noMatch')}</span>
            : lines.map(line => (
              <span key={line.n} className={`term-line ${line.tone ? `tone-${line.tone}` : ''}`}>
                {ansiSpans(line.text).map((span, i) => (
                  <span key={i} className={`${span.fg ? `ansi-${span.fg}` : ''}${span.bold ? ' ansi-bold' : ''}`}>{span.text}</span>
                ))}
                {'\n'}
              </span>
            ))}
      </pre>
    </div>
  );
};

/* ---------------------------------------------------------- approvals */

/**
 * The question a step is waiting on, answered in the timeline. It is the same
 * queue the floating box (src/CliAgent.jsx) shows; answering either clears both.
 */
const InlineApproval = ({ target }) => {
  const { t } = useI18n();
  const [question, setQuestion] = useState(null);
  const [done, setDone] = useState('');
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let stopped = false, timer = null;
    const tick = async () => {
      try {
        const d = await fetch('/cli/approvals').then(r => r.json());
        const key = String(target || '').slice(0, 120);
        const found = (d.approvals || []).find(a => String(a.title).startsWith(key) || key.startsWith(String(a.title).slice(0, 120)));
        if (!stopped) setQuestion(found || null);
      } catch { /* asked again */ }
      if (!stopped) timer = setTimeout(tick, 1500);
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [target]);

  if (done) return <div className="agent-approval is-done">{t(done === 'answer' ? 'cliPrompt.answered' : `agent.decided.${done}`)}</div>;
  if (!question) return null;
  /* Folded: the box in the corner (CliApprovals) is where it is answered.
     Opened here only on request, for reading the details beside the step. */
  return (
    <div className={`agent-approval is-folded${expanded ? ' is-open' : ''}`}>
      <button type="button" className="agent-approval-toggle" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
        <ShieldQuestion size={12} aria-hidden="true" />
        <span>{t('agent.waitingCorner')}</span>
        <ChevronDown size={12} className={`agent-step-chevron ${expanded ? 'is-open' : ''}`} aria-hidden="true" />
      </button>
      {expanded && <CliPromptCard item={question} compact onDone={setDone} />}
    </div>
  );
};

/* ------------------------------------------------------------- steps */

const StatusBadge = ({ step }) => {
  const { t } = useI18n();
  if (step.status === 'running') return <span className="agent-badge is-running"><Loader2 size={11} className="spin" />{t('agent.running')}</span>;
  if (step.status === 'waiting') return <span className="agent-badge is-waiting"><ShieldQuestion size={11} />{t('agent.waiting')}</span>;
  if (step.status === 'timedOut') return <span className="agent-badge is-failed"><Clock size={11} />{t('agent.timedOut')}</span>;
  if (step.status === 'declined') return <span className="agent-badge is-failed"><X size={11} />{t('agent.declined')}</span>;
  if (step.status === 'failed') {
    return <span className="agent-badge is-failed"><X size={11} />{step.code !== undefined && step.code !== null ? `exit ${step.code}` : t('agent.failed')}</span>;
  }
  if (step.kind === 'command' && Number.isInteger(step.code)) return <span className="agent-badge is-ok"><Check size={11} />exit {step.code}</span>;
  return <span className="agent-badge is-ok"><Check size={11} /></span>;
};

const Step = ({ step }) => {
  const { t } = useI18n();
  const hasBody = !!(step.output || step.error || step.input || step.result);
  const [open, setOpen] = useState(step.status === 'failed' && !!(step.output || step.error));
  const running = step.status === 'running';
  const now = useNow(running && !!step.at);
  const Icon = ICONS[step.kind] || Wrench;
  const verb = t(`agent.kind.${step.kind}`);
  const tool = step.kind === 'tool' || step.kind === 'task' ? step.label : '';
  const took = step.ms ?? (running && step.at ? now - step.at : null);
  return (
    <li className={`agent-step kind-${step.kind} status-${step.status}`}>
      <span className="agent-step-dot"><Icon size={12} aria-hidden="true" /></span>
      <div className="agent-step-main">
        <button type="button" className="agent-step-row" disabled={!hasBody} aria-expanded={hasBody ? open : undefined} onClick={() => setOpen(!open)}>
          <span className="agent-step-verb">{verb}</span>
          {tool && <span className="agent-step-tool">{tool}</span>}
          {step.target && <code className="agent-step-target" title={step.target}>{step.kind === 'command' || step.kind === 'approval' ? step.target : shortPath(step.target)}</code>}
          {step.input && <Braces size={11} className="agent-step-has" aria-label={t('agent.input')} />}
          {took !== null && took >= 0 && <span className={`agent-step-time ${took > 30000 ? 'is-slow' : ''}`}><Clock size={10} />{duration(took)}</span>}
          <StatusBadge step={step} />
          {hasBody && <ChevronDown size={12} className={`agent-step-chevron ${open ? 'is-open' : ''}`} aria-hidden="true" />}
        </button>
        {step.status === 'waiting' && <InlineApproval target={step.target} />}
        {open && hasBody && (
          <div className="agent-step-body">
            {step.error && <div className="agent-step-error">{step.error}</div>}
            {step.input && (
              <div className="agent-step-section">
                <div className="agent-step-label">{t('agent.input')}</div>
                <pre className="agent-step-json">{pretty(step.input)}</pre>
              </div>
            )}
            {step.result && (
              <div className="agent-step-section">
                <div className="agent-step-label">{t('agent.result')}</div>
                <OutputView text={step.result} />
              </div>
            )}
            {step.output && (
              <div className="agent-step-section">
                {(step.input || step.result) && <div className="agent-step-label">{t('agent.output')}</div>}
                <OutputView text={step.output} />
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
};

/* `stepsOnly`: the steps alone, folded under their summary line. The chat
   shows the reasoning in the "생각하는 중" fold and the steps here, below it;
   with both in the one fold, every 실행/수정 appeared inside the thinking.
   Running commands are followed by the pill in the corner (CommandsDock), so
   the fold stays shut -- an approval it waits on pops up in the corner and
   is only marked on the summary line. */
export const AgentActivity = ({ text, live = false, markdownProps = {}, stepsOnly = false }) => {
  const { t } = useI18n();
  const all = useMemo(() => activityOf(text, { live }), [text, live]);
  const segments = useMemo(() => (stepsOnly ? all.filter(s => s.type === 'step') : all), [all, stepsOnly]);
  const summary = activitySummary(segments);
  const waiting = segments.some(s => s.status === 'waiting');
  const [opened, setOpened] = useState(null);
  // Stays folded while waiting too: the approval pops up in the corner.
  const open = !stepsOnly || (opened ?? false);
  const stepsTimed = segments.filter(s => s.type === 'step' && s.at);
  const total = stepsTimed.length > 1 ? (stepsTimed[stepsTimed.length - 1].endAt || stepsTimed[stepsTimed.length - 1].at) - stepsTimed[0].at : 0;

  // Consecutive steps are one list, so the timeline line runs through them.
  const groups = [];
  for (const segment of segments) {
    const last = groups[groups.length - 1];
    if (segment.type === 'step' && last?.type === 'steps') last.steps.push(segment);
    else groups.push(segment.type === 'step' ? { type: 'steps', steps: [segment] } : segment);
  }

  return (
    <div className={`agent-activity${stepsOnly ? ' is-steps-only' : ''}`}>
      <div
        className={`agent-summary${stepsOnly ? ' is-toggle' : ''}`}
        {...(stepsOnly ? {
          role: 'button', tabIndex: 0, 'aria-expanded': open,
          onClick: () => setOpened(!open),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpened(!open); } },
        } : {})}
      >
        {stepsOnly && <ChevronDown size={12} className={`agent-step-chevron ${open ? 'is-open' : ''}`} aria-hidden="true" />}
        <Activity size={12} aria-hidden="true" />
        <span>{t('agent.summary', { steps: summary.steps })}</span>
        {total > 0 && <span className="agent-chip"><Clock size={11} />{duration(total)}</span>}
        {summary.commands > 0 && <span className="agent-chip"><Terminal size={11} />{summary.commands}</span>}
        {summary.edits > 0 && <span className="agent-chip"><FilePen size={11} />{summary.edits}</span>}
        {summary.failed > 0 && <span className="agent-chip is-failed"><X size={11} />{summary.failed}</span>}
        {waiting && <span className="agent-chip is-waiting"><ShieldQuestion size={11} />{t('agent.waiting')}</span>}
        {summary.running && <span className="agent-chip is-running"><Loader2 size={11} className="spin" />{t('agent.working')}</span>}
      </div>
      {open && groups.map((group, n) => (group.type === 'steps'
        ? (
          <ol key={n} className="agent-steps">
            {group.steps.map((step, k) => <Step key={k} step={step} />)}
          </ol>
        )
        : (
          <div key={n} className="agent-prose">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]} {...markdownProps}>{group.text}</ReactMarkdown>
          </div>
        )))}
    </div>
  );
};

/* ------------------------------------------------------- live commands */

const stopCommand = (id) => post('/cli/commands/stop', { id }).catch(() => null);

export const LiveCommand = ({ command, defaultOpen = true }) => {
  const { t } = useI18n();
  const running = command.status === 'running';
  const [open, setOpen] = useState(defaultOpen);
  const [stopping, setStopping] = useState(false);
  const status = running ? 'running' : command.status === 'done' ? 'done' : command.status === 'timedOut' ? 'timedOut' : 'failed';
  const serving = running && (command.background || (command.urls || []).length > 0);
  return (
    <div className={`live-command status-${status}`}>
      <div className="live-command-head">
        <button type="button" className="live-command-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <ChevronDown size={12} className={`agent-step-chevron ${open ? 'is-open' : ''}`} aria-hidden="true" />
          {serving ? <Radio size={13} className="live-command-serving" /> : running ? <Loader2 size={13} className="spin" /> : <Terminal size={13} />}
          <code className="live-command-line" title={command.command}>{command.command}</code>
        </button>
        {serving && <span className="agent-badge is-running">{t('agent.background')}</span>}
        <span className="live-command-meta">
          {command.source === 'codex' ? 'Codex' : command.source === 'claude' ? 'Claude Code' : 'workbench'} · {duration(command.elapsed || 0)}
          {!running && (command.status === 'lost' ? ` · ${t('agent.lost')}` : command.code !== null && command.code !== undefined ? ` · exit ${command.code}` : '')}
        </span>
        {(command.urls || []).slice(0, 2).map(url => (
          <a key={url} className="btn-ghost live-command-open" href={url} target="_blank" rel="noreferrer" title={url}>
            <ExternalLink size={11} /> {t('agent.open')} <span className="live-command-port">{url.replace(/^https?:\/\//, '')}</span>
          </a>
        ))}
        {running && command.pid && (
          <button type="button" className="btn-ghost live-command-stop" disabled={stopping} onClick={() => { setStopping(true); stopCommand(command.id); }} title={t('agent.stop')}>
            <Square size={11} /> {t('agent.stop')}
          </button>
        )}
      </div>
      {open && <OutputView text={command.output} follow logId={command.id} className="live-command-output" />}
      {command.cwd && <div className="live-command-cwd">{command.cwd}</div>}
    </div>
  );
};

/**
 * The commands started since this answer began, polled once a second while it
 * is live, and once more after it ends so the last result is shown whole.
 */
export const LiveCommands = ({ live = false }) => {
  const [commands, setCommands] = useState([]);
  const since = useRef(0);
  if (live && !since.current) since.current = Date.now() - 2000;

  useEffect(() => {
    if (!since.current) return undefined;
    let stopped = false;
    let timer = null;
    const tick = async () => {
      try {
        const d = await fetch('/cli/commands').then(r => r.json());
        if (!stopped && d.success) setCommands((d.commands || []).filter(c => c.started >= since.current));
      } catch { /* the server is away for a moment */ }
      if (!stopped && live) timer = setTimeout(tick, document.hidden ? 4000 : 1000);
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [live]);

  if (!commands.length) return null;
  // While the answer runs: what is running, and the last few that ended.
  const shown = live
    ? [...commands.filter(c => c.status === 'running'), ...commands.filter(c => c.status !== 'running').slice(0, 2)]
    : commands.filter(c => c.status !== 'done').slice(0, 3);
  if (!shown.length) return null;
  return (
    <div className="live-commands" aria-live="polite">
      {shown.map(c => <LiveCommand key={c.id} command={c} />)}
    </div>
  );
};

/**
 * Every command a CLI is running, from anywhere in the app: a pill in the
 * corner with how many, opening onto the whole list. A dev server started in
 * one chat is still watched (and stopped) from another.
 */
export const CommandsDock = () => {
  const { t } = useI18n();
  const [commands, setCommands] = useState([]);
  const [open, setOpen] = useState(false);
  const running = commands.filter(c => c.status === 'running');

  useEffect(() => {
    let stopped = false, timer = null;
    const tick = async () => {
      try {
        const d = await fetch('/cli/commands').then(r => r.json());
        if (!stopped && d.success) setCommands(d.commands || []);
      } catch { /* away for a moment */ }
      if (stopped) return;
      const busy = open || running.length > 0;
      timer = setTimeout(tick, document.hidden ? 10000 : busy ? 1500 : 5000);
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [open, running.length]);

  /* The pill floats over whatever page is open. Fixed offsets per place kept
     landing on something -- the composer when the chat column was narrow, the
     code panel's neighbour, Studio's footer. So it looks: if a bottom bar is
     under its column, it rides just above that bar. */
  const dock = useRef(null);
  const [lift, setLift] = useState(null);
  const [inset, setInset] = useState(null);
  const shown = running.length > 0 || open;
  useEffect(() => {
    if (!shown) return undefined;
    const measure = () => {
      const el = dock.current;
      if (!el) return;
      const pill = el.querySelector('.commands-dock-pill');
      const box = (pill || el).getBoundingClientRect();
      /* Above the message box, at its left edge, when the composer is at the
         bottom of the window. */
      const composer = [...document.querySelectorAll('.input-container')].find(c => {
        const r = c.getBoundingClientRect();
        return r.width && r.height && r.top < window.innerHeight && r.bottom >= window.innerHeight - 200;
      });
      if (composer) {
        const r = composer.getBoundingClientRect();
        const nextLift = Math.max(16, Math.round(window.innerHeight - r.top + 8));
        const nextLeft = Math.max(8, Math.round(r.left));
        setLift(prev => (prev === nextLift ? prev : nextLift));
        setInset(prev => (prev === nextLeft ? prev : nextLeft));
        return;
      }
      setInset(prev => (prev === null ? prev : null));
      let top = Infinity;
      for (const bar of document.querySelectorAll('.input-container, .input-footer, .studio-place:not([hidden]) .studio-footer')) {
        const r = bar.getBoundingClientRect();
        if (!r.width || !r.height || r.top >= window.innerHeight) continue;
        /* Only a bar that sits at the bottom of the window. An empty chat
           centres its composer, and lifting over that put the pill in the
           middle of a phone screen (bottom: 513px). */
        if (r.bottom < window.innerHeight - 200) continue;
        if (r.left < box.right && box.left < r.right) top = Math.min(top, r.top);
      }
      const next = top === Infinity ? null : Math.max(16, Math.round(window.innerHeight - top + 8));
      setLift(prev => (prev === next ? prev : next));
    };
    measure();
    const timer = setInterval(measure, 600);
    window.addEventListener('resize', measure);
    return () => { clearInterval(timer); window.removeEventListener('resize', measure); };
  }, [shown]);

  /* The panel is what is running now and nothing else. It used to list every
     command of the last three minutes -- finished, failed, from other chats --
     under a heading that says "running". When the last one ends, it closes. */
  const hadRunning = useRef(false);
  useEffect(() => {
    if (running.length) hadRunning.current = true;
    else if (open && hadRunning.current) { hadRunning.current = false; setOpen(false); }
  }, [running.length, open]);

  // Escape (and the Android back button, which sends one) closes the panel.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!shown) return null;
  return (
    <div ref={dock} className={`commands-dock ${open ? 'is-open' : ''}`} style={lift ? { bottom: `${lift}px`, '--dock-bottom': `${lift}px`, ...(inset != null ? { left: `${inset}px` } : null) } : undefined}>
      {open && (
        <div className="commands-dock-panel" role="dialog" aria-label={t('agent.dockTitle')}>
          <div className="commands-dock-head">
            <Terminal size={13} /> <strong>{t('agent.dockTitle')}</strong>
            <span className="commands-dock-count">{t('agent.dockRunning', { n: running.length })}</span>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)} aria-label={t('common.close')}><X size={13} /></button>
          </div>
          <div className="commands-dock-list">
            {!running.length && <div className="term-empty">{t('agent.dockNone')}</div>}
            {running.map(c => <LiveCommand key={c.id} command={c} defaultOpen={running.length <= 2} />)}
          </div>
        </div>
      )}
      <button type="button" className="commands-dock-pill" onClick={() => setOpen(!open)} aria-expanded={open}>
        {running.length ? <Loader2 size={13} className="spin" /> : <Terminal size={13} />}
        {t('agent.dockRunning', { n: running.length })}
      </button>
    </div>
  );
};

export default AgentActivity;
