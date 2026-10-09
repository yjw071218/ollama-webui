import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square, FolderOpen, Folder, RefreshCcw, Trash2, Globe, ExternalLink, Terminal, X, PanelRightOpen, PanelRightClose, CornerDownLeft, Eraser } from 'lucide-react';
import { ansiSpans, lineTone } from './terminalText.js';

/**
 * Run a project on this PC and try it, the way Codex does -- across the whole
 * chat area, not in a small terminal at the side.
 *
 *   left     the project folder, what it can run (package.json scripts,
 *            Python entry points, ...), a command of your own, and every
 *            process started, running or finished
 *   middle   the selected process's output, with colours, and a line to
 *            type into it
 *   right    the page a dev server printed, live, beside its output
 *
 * Only in the Windows app: the commands run there, on the PC (native/desktop/
 * runner.mjs), through window.ollamaNative.runner.
 */

const RECENT_KEY = 'runner:recent';
const MAX_OUTPUT = 400_000;
const ko = /^ko\b/i.test(document.documentElement.lang || navigator.language || '');
const L = (k, e) => (ko ? k : e);

export const runnerAvailable = () => typeof window !== 'undefined' && !!window.ollamaNative?.runner;

const loadRecent = () => { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.slice(0, 8) : []; } catch { return []; } };
const saveRecent = (list) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8))); } catch { /* full */ } };
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
const since = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };

/* A terminal keeps only what fits; a carriage return redraws its line. */
const appendOutput = (prev, text) => {
  let next = prev + text;
  if (next.includes('\r')) next = next.replace(/[^\n]*\r(?!\n)/g, '');
  return next.length > MAX_OUTPUT ? next.slice(-MAX_OUTPUT) : next;
};

const OutputView = React.memo(function OutputView({ text }) {
  const ref = useRef(null);
  const stick = useRef(true);
  const lines = useMemo(() => text.split('\n').slice(-3000), [text]);
  useEffect(() => { const el = ref.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [lines]);
  return (
    <pre
      ref={ref}
      className="runner-output"
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
    >
      {lines.map((line, i) => (
        <span key={i} className={`runner-line tone-${lineTone(line) || 'plain'}`}>
          {ansiSpans(line).map((s, j) => (
            <span key={j} className={`${s.fg ? `ansi-${s.fg}` : ''}${s.bold ? ' ansi-bold' : ''}`}>{s.text}</span>
          ))}
          {'\n'}
        </span>
      ))}
    </pre>
  );
});

export default function RunnerWorkspace({ open, initialFolder = '' }) {
  const api = window.ollamaNative?.runner;
  const [folder, setFolder] = useState(() => initialFolder || loadRecent()[0] || '');
  const [project, setProject] = useState(null);
  const [error, setError] = useState('');
  const [recent, setRecent] = useState(loadRecent);
  const [custom, setCustom] = useState('');
  const [procs, setProcs] = useState([]);          // [{ id, cwd, command, startedAt, exited, code, urls }]
  const [outputs, setOutputs] = useState({});      // id -> text
  const [selected, setSelected] = useState(null);
  const [stdin, setStdin] = useState('');
  const [preview, setPreview] = useState(null);    // url shown on the right
  const [previewKey, setPreviewKey] = useState(0);
  const [, tick] = useState(0);
  const pending = useRef({});

  /* Output arrives in many small pieces; it is folded in once a frame. */
  const flush = useRef(null);
  const queueOutput = useCallback((id, text) => {
    pending.current[id] = (pending.current[id] || '') + text;
    if (flush.current) return;
    flush.current = requestAnimationFrame(() => {
      flush.current = null;
      const batch = pending.current; pending.current = {};
      setOutputs(prev => { const next = { ...prev }; for (const [k, v] of Object.entries(batch)) next[k] = appendOutput(next[k] || '', v); return next; });
    });
  }, []);

  useEffect(() => {
    if (!api) return undefined;
    const offs = [
      api.on('output', ({ id, text }) => queueOutput(id, text)),
      api.on('exit', ({ id, code }) => {
        setProcs(prev => prev.map(p => (p.id === id ? { ...p, exited: true, code } : p)));
        queueOutput(id, `\n\u001b[${code === 0 ? '32' : '31'}m[${L('종료', 'exited')}: ${code}]\u001b[0m\n`);
      }),
      api.on('url', ({ id, url }) => {
        setProcs(prev => prev.map(p => (p.id === id ? { ...p, urls: [...new Set([...(p.urls || []), url])] } : p)));
        setPreview(cur => cur || url);
      }),
    ];
    api.list().then(list => setProcs(prev => (prev.length ? prev : (list || []).map(p => ({ ...p, urls: [] }))))).catch(() => {});
    return () => offs.forEach(off => off());
  }, [api, queueOutput]);

  // Elapsed times move while something runs and the workspace is on screen.
  useEffect(() => {
    if (!open || !procs.some(p => !p.exited)) return undefined;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [open, procs]);

  const inspect = useCallback(async (dir) => {
    if (!api || !dir) return;
    setError('');
    try {
      const info = await api.inspect(dir);
      setProject(info);
      setFolder(info.dir);
      const list = [info.dir, ...loadRecent().filter(d => d.toLowerCase() !== info.dir.toLowerCase())];
      saveRecent(list); setRecent(list.slice(0, 8));
    } catch (e) { setProject(null); setError(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  }, [api]);

  useEffect(() => { if (open && folder && !project) inspect(folder); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (initialFolder) inspect(initialFolder); }, [initialFolder, inspect]);

  const pick = async () => { const dir = await api.pick(); if (dir) inspect(dir); };

  const start = async (command) => {
    const cmd = String(command || '').trim();
    if (!cmd || !project) return;
    setError('');
    try {
      const run = await api.start(project.dir, cmd);
      if (!run) return; // the user said no to the folder
      setProcs(prev => [{ ...run, exited: false, code: null, urls: [] }, ...prev]);
      setOutputs(prev => ({ ...prev, [run.id]: `\u001b[2m${project.dir}>\u001b[0m \u001b[1m${cmd}\u001b[0m\n` }));
      setSelected(run.id);
    } catch (e) { setError(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  };

  const restart = async (p) => { if (!p.exited) await api.stop(p.id); setTimeout(() => start(p.command), p.exited ? 0 : 400); };
  const remove = async (p) => {
    await api.forget(p.id);
    setProcs(prev => prev.filter(x => x.id !== p.id));
    setOutputs(prev => { const n = { ...prev }; delete n[p.id]; return n; });
    if (selected === p.id) setSelected(null);
  };
  const send = async (e) => {
    e.preventDefault();
    if (!current || current.exited) return;
    const text = stdin;
    setStdin('');
    queueOutput(current.id, `${text}\n`);
    await api.input(current.id, `${text}\n`);
  };

  const current = procs.find(p => p.id === selected) || procs[0] || null;
  const urls = current?.urls || [];
  const running = procs.filter(p => !p.exited).length;

  if (!api) {
    return (
      <div className="runner runner-unavailable">
        <Terminal size={28} />
        <p>{L('프로젝트 실행은 Windows 앱에서만 쓸 수 있어요.', 'Running projects is available in the Windows app.')}</p>
      </div>
    );
  }

  const groups = project ? [
    ['setup', L('준비', 'Setup')],
    ['script', L('실행', 'Run')],
  ].map(([g, label]) => [label, project.commands.filter(c => c.group === g)]).filter(([, list]) => list.length) : [];

  return (
    <div className={`runner ${preview ? 'has-preview' : ''}`}>
      <aside className="runner-side">
        <div className="runner-section">
          <div className="runner-label">{L('프로젝트', 'Project')}</div>
          <form className="runner-folder" onSubmit={(e) => { e.preventDefault(); inspect(folder); }}>
            <input value={folder} onChange={e => setFolder(e.target.value)} placeholder="C:\\path\\to\\project" spellCheck={false} />
            <button type="button" className="runner-icon" title={L('폴더 고르기', 'Choose folder')} onClick={pick}><FolderOpen size={15} /></button>
          </form>
          {recent.length > 1 && (
            <div className="runner-recent">
              {recent.filter(d => d !== project?.dir).slice(0, 5).map(d => (
                <button key={d} type="button" title={d} onClick={() => inspect(d)}><Folder size={12} /> {baseName(d)}</button>
              ))}
            </div>
          )}
          {project && (
            <div className="runner-project">
              <strong title={project.dir}>{project.name}</strong>
              <span>{project.kind.join(' · ') || L('알 수 없음', 'unknown')}</span>
              <button type="button" className="runner-icon" title={L('다시 읽기', 'Rescan')} onClick={() => inspect(project.dir)}><RefreshCcw size={13} /></button>
              <button type="button" className="runner-icon" title={L('탐색기에서 열기', 'Open in Explorer')} onClick={() => api.openFolder(project.dir)}><ExternalLink size={13} /></button>
            </div>
          )}
          {error && <div className="runner-error">{error}</div>}
        </div>

        {project && (
          <div className="runner-section">
            {groups.map(([label, list]) => (
              <React.Fragment key={label}>
                <div className="runner-label">{label}</div>
                <div className="runner-commands">
                  {list.map(c => (
                    <button key={c.command} type="button" className="runner-command" title={c.command} onClick={() => start(c.command)}>
                      <Play size={12} /> <span>{c.label}</span><code>{c.command}</code>
                    </button>
                  ))}
                </div>
              </React.Fragment>
            ))}
            <form className="runner-custom" onSubmit={(e) => { e.preventDefault(); start(custom); }}>
              <input value={custom} onChange={e => setCustom(e.target.value)} placeholder={L('명령 직접 입력 (예: npm test)', 'Your own command (e.g. npm test)')} spellCheck={false} />
              <button type="submit" className="runner-icon" disabled={!custom.trim()} title={L('실행', 'Run')}><Play size={14} /></button>
            </form>
          </div>
        )}

        <div className="runner-section runner-procs">
          <div className="runner-label">{L('프로세스', 'Processes')} {running > 0 && <span className="runner-badge">{running}</span>}</div>
          {procs.length === 0 && <div className="runner-empty">{L('아직 실행한 명령이 없어요.', 'Nothing has been run yet.')}</div>}
          {procs.map(p => (
            <div key={p.id} className={`runner-proc ${current?.id === p.id ? 'is-on' : ''}`} onClick={() => setSelected(p.id)} role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') setSelected(p.id); }}>
              <span className={`runner-dot ${p.exited ? (p.code === 0 ? 'ok' : 'fail') : 'live'}`} />
              <div className="runner-proc-text">
                <code>{p.command}</code>
                <span>{baseName(p.cwd)} · {p.exited ? `${L('종료', 'exit')} ${p.code}` : since(p.startedAt)}</span>
              </div>
              <button type="button" className="runner-icon" title={L('다시 실행', 'Restart')} onClick={(e) => { e.stopPropagation(); restart(p); }}><RefreshCcw size={13} /></button>
              {!p.exited
                ? <button type="button" className="runner-icon danger" title={L('중지', 'Stop')} onClick={(e) => { e.stopPropagation(); api.stop(p.id); }}><Square size={12} /></button>
                : <button type="button" className="runner-icon" title={L('목록에서 지우기', 'Remove')} onClick={(e) => { e.stopPropagation(); remove(p); }}><Trash2 size={13} /></button>}
            </div>
          ))}
        </div>
      </aside>

      <section className="runner-main">
        <header className="runner-bar">
          <Terminal size={14} />
          <code className="runner-title">{current ? current.command : L('터미널', 'Terminal')}</code>
          <span className="runner-space" />
          {urls.map(u => (
            <button key={u} type="button" className={`runner-chip ${preview === u ? 'is-on' : ''}`} onClick={() => { setPreview(u); setPreviewKey(k => k + 1); }} title={L('옆에서 미리보기', 'Preview beside')}>
              <Globe size={12} /> {u.replace(/^https?:\/\//, '')}
            </button>
          ))}
          {current && <button type="button" className="runner-icon" title={L('출력 지우기', 'Clear output')} onClick={() => setOutputs(prev => ({ ...prev, [current.id]: '' }))}><Eraser size={14} /></button>}
          <button type="button" className="runner-icon" title={preview ? L('미리보기 닫기', 'Close preview') : L('미리보기 열기', 'Open preview')}
            onClick={() => setPreview(p => (p ? null : (urls[0] || 'http://localhost:5173')))}>
            {preview ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
          </button>
        </header>
        {current
          ? <OutputView text={outputs[current.id] || ''} />
          : (
            <div className="runner-welcome">
              <Terminal size={30} />
              <p>{project
                ? L('왼쪽에서 실행할 명령을 고르세요. dev 서버 주소가 나오면 오른쪽에 바로 미리보기가 열립니다.', 'Pick a command on the left. When a dev server prints its address, the preview opens on the right.')
                : L('프로젝트 폴더를 고르면 실행할 수 있는 명령을 찾아 드려요.', 'Choose a project folder and the commands it can run will be listed.')}</p>
            </div>
          )}
        <form className="runner-stdin" onSubmit={send}>
          <CornerDownLeft size={13} />
          <input value={stdin} onChange={e => setStdin(e.target.value)} disabled={!current || current.exited}
            placeholder={current && !current.exited ? L('프로세스에 입력 보내기 (Enter)', 'Send input to the process (Enter)') : L('실행 중인 프로세스가 없어요', 'No running process')} spellCheck={false} />
        </form>
      </section>

      {preview && (
        <section className="runner-preview">
          <header className="runner-bar">
            <Globe size={14} />
            <input className="runner-url" defaultValue={preview} key={preview}
              onKeyDown={(e) => { if (e.key === 'Enter') { let v = e.currentTarget.value.trim(); if (v && !/^https?:\/\//i.test(v)) v = `http://${v}`; setPreview(v); setPreviewKey(k => k + 1); } }} spellCheck={false} />
            <button type="button" className="runner-icon" title={L('새로고침', 'Reload')} onClick={() => setPreviewKey(k => k + 1)}><RefreshCcw size={14} /></button>
            <button type="button" className="runner-icon" title={L('앱 브라우저 창으로 열기', 'Open in the app browser')} onClick={() => api.browse(preview)}><ExternalLink size={14} /></button>
            <button type="button" className="runner-icon" title={L('닫기', 'Close')} onClick={() => setPreview(null)}><X size={14} /></button>
          </header>
          <iframe key={previewKey} className="runner-frame" src={preview} title="preview" />
        </section>
      )}
    </div>
  );
}
