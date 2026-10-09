import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square, FolderOpen, Folder, RefreshCcw, Trash2, Globe, ExternalLink, Terminal, X, PanelRightOpen, PanelRightClose, CornerDownLeft, Eraser, Maximize, Maximize2, Minimize2, AppWindow, LayoutGrid, SquareArrowOutUpRight, SquareArrowDownLeft, Columns3, Square as SquareIcon, Check, ChevronDown, EyeOff, Eye, Copy as CopyIcon } from 'lucide-react';
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
const SIZES_KEY = 'runner:sizes';
const loadSizes = () => { try { const v = JSON.parse(localStorage.getItem(SIZES_KEY) || 'null'); return { side: Number(v?.side) || 280, preview: Number(v?.preview) || 0 }; } catch { return { side: 280, preview: 0 }; } };
const saveSizes = (v) => { try { localStorage.setItem(SIZES_KEY, JSON.stringify(v)); } catch { /* full */ } };

/* Which of the addresses a process printed is the app itself. A server prints
   its own root ("To see the GUI go to: http://127.0.0.1:8188") but plugins
   print their sub-pages first (ComfyUI's /mtb), and the first one seen used
   to win. The shortest path on an origin is the one meant. */
const urlRank = (u) => { try { const x = new URL(u); return x.pathname.replace(/\/+$/, '').length + (x.search ? 50 : 0); } catch { return 999; } };
const sameOrigin = (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };
/* How the page under test is framed. `fit` fills the panel like a browser
   tab; a ratio letterboxes it (a game made for 16:9 sees 16:9 whatever the
   panel's shape); a resolution lays it out at exactly that many CSS pixels
   and scales the picture down to fit, so a 1920x1080 game runs at 1920x1080. */
const VIEWPORTS = [
  { id: 'fit', label: () => L('맞춤', 'Fit') },
  { id: 'stretch', label: () => L('창도 늘리기', 'Stretch windows') },
  { id: '16:9', ratio: 16 / 9 },
  { id: '4:3', ratio: 4 / 3 },
  { id: '21:9', ratio: 21 / 9 },
  { id: '1:1', ratio: 1 },
  { id: '9:16', ratio: 9 / 16 },
  { id: '1280×720', w: 1280, h: 720 },
  { id: '1920×1080', w: 1920, h: 1080 },
  { id: '390×844', w: 390, h: 844, label: () => L('390×844 (휴대폰)', '390×844 (phone)') },
];
const VIEWPORT_KEY = 'runner:viewport';

/* Where a program's own window (pygame, Tk, Qt...) is shown. The element is
   only a placeholder: the PC app moves the real window over it
   (native/desktop/winembed.mjs) and is told whenever the placeholder moves,
   changes size, or is covered -- a menu or a dialog opened over it would
   otherwise sit under a window that is not part of the page. */
function NativeSlot({ hwnd, active, fill, style, z = 0 }) {
  const ref = useRef(null);
  const api = window.ollamaNative?.runner;
  useEffect(() => {
    if (!api?.place) return undefined;
    let last = '', raf = 0, alive = true;
    const check = () => {
      if (!alive) return;
      const el = ref.current;
      let rect = null;
      if (el && active && document.visibilityState === 'visible') {
        const r = el.getBoundingClientRect();
        if (r.width > 4 && r.height > 4) {
          const frame = el.closest('.runner-win');
          const desk = el.closest('.runner-desk');
          const clip = (desk || el.closest('.runner-preview')).getBoundingClientRect();
          const cuts = frame && desk ? [...desk.querySelectorAll('.runner-win')]
            .filter(other => other !== frame && Number(other.style.zIndex) > Number(frame.style.zIndex))
            .map(other => { const b = other.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; }) : [];
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (desk || (top && (top === el || el.contains(top)))) rect = {
            x: r.left, y: r.top, width: r.width, height: r.height, fill,
            clip: { x: clip.left, y: clip.top, width: clip.width, height: clip.height }, cuts,
          };
        }
      }
      const key = rect ? JSON.stringify([rect, z]) : 'none';
      if (key !== last) { last = key; api.place(hwnd, rect).catch(() => {}); }
      raf = requestAnimationFrame(check);
    };
    check();
    return () => { alive = false; cancelAnimationFrame(raf); api.place(hwnd, null).catch(() => {}); };
  }, [api, hwnd, active, fill, z]);
  return (
    <div ref={ref} className="runner-native" style={style}>
      <AppWindow size={22} />
      <span>{L('프로그램 창을 불러오는 중…', 'Bringing the window in…')}</span>
    </div>
  );
}

function PreviewStage({ screen, frameKey, viewport, active, onPopIn, z = 0 }) {
  const stageRef = useRef(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const native = screen.kind === 'app';
  const v = VIEWPORTS.find(x => x.id === viewport) || VIEWPORTS[0];
  let style = { width: '100%', height: '100%' };
  let note = '';
  const boxed = !['fit', 'stretch'].includes(v.id);
  if (box.w > 0 && box.h > 0 && boxed) {
    const ratio = v.ratio || v.w / v.h;
    if (v.ratio || native) {
      // A program window cannot be scaled as a picture, so a resolution is its shape.
      const w = Math.min(box.w, box.h * ratio);
      const h = w / ratio;
      style = { width: Math.floor(w), height: Math.floor(h) };
      note = `${Math.floor(w)}×${Math.floor(h)}`;
    } else {
      const scale = Math.min(1, box.w / v.w, box.h / v.h);
      style = { width: v.w, height: v.h, transform: `scale(${scale})`, transformOrigin: 'center center', flex: '0 0 auto' };
      note = scale < 1 ? `${Math.round(scale * 100)}%` : '';
    }
  }
  if (native && !boxed && screen.w && screen.h) note = `${screen.w}×${screen.h}`;
  const goFull = () => {
    const el = stageRef.current?.querySelector('iframe');
    el?.requestFullscreen?.().catch(() => {});
  };
  return (
    <div ref={stageRef} className={`runner-stage ${boxed || native ? 'is-boxed' : 'is-fit'}`}>
      {native
        ? (screen.popped
          ? (
            <div className="runner-native is-out">
              <SquareArrowOutUpRight size={22} />
              <span>{L('따로 띄운 창이에요.', 'This window is out on its own.')}</span>
              <button type="button" className="runner-chip is-on" onClick={onPopIn}><SquareArrowDownLeft size={12} /> {L('다시 넣기', 'Bring it back in')}</button>
            </div>
          )
          : <NativeSlot hwnd={screen.hwnd} active={active} fill={v.id === 'stretch' || boxed} style={style} z={z} />)
        : (
          <iframe key={frameKey} className="runner-frame" src={screen.url} title="preview" style={style}
            allow="fullscreen; autoplay; gamepad; pointer-lock; clipboard-read; clipboard-write; accelerometer; gyroscope; xr-spatial-tracking"
            allowFullScreen />
        )}
      {note && <span className="runner-stage-note">{note}</span>}
      {!native && <button type="button" className="runner-icon runner-stage-full" title={L('전체 화면 (Esc로 나가기)', 'Full screen (Esc to leave)')} onClick={goFull}><Maximize size={14} /></button>}
    </div>
  );
}

/* ---- several screens at once ----

   Side by side: columns whose widths are dragged at the handles between them.
   Free: the panel is a little desktop -- every screen is a window with a
   title bar to drag it by, edges and a corner to size it, and a click brings
   it to the front. Positions are fractions of the panel, so a resized panel
   keeps the arrangement. */
const LAYOUT_KEY = 'runner:layout';
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function TileRow({ screens, focused, onFocus, render }) {
  const rowRef = useRef(null);
  const [weights, setWeights] = useState({});
  const weightOf = (k) => weights[k] || 1;
  const drag = (i) => (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const row = rowRef.current;
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);
    row.classList.add('is-resizing');
    const a = screens[i].key, b = screens[i + 1].key;
    const total = screens.reduce((n, x) => n + weightOf(x.key), 0);
    const pair = weightOf(a) + weightOf(b);
    const width = row.getBoundingClientRect().width;
    const startX = e.clientX, startA = weightOf(a);
    const move = (ev) => {
      const delta = ((ev.clientX - startX) / width) * total;
      const na = clamp(startA + delta, pair * 0.12, pair * 0.88);
      setWeights(w => ({ ...w, [a]: na, [b]: pair - na }));
    };
    const up = () => {
      row.classList.remove('is-resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
  return (
    <div ref={rowRef} className="runner-tiles-row">
      {screens.map((x, i) => (
        <React.Fragment key={x.key}>
          <div className={`runner-tile ${focused === x.key ? 'is-on' : ''}`} style={{ flexGrow: weightOf(x.key) }} onPointerDown={() => onFocus(x.key)}>
            {render(x, 'tile')}
          </div>
          {i < screens.length - 1 && (
            <div className="runner-split runner-tile-split" role="separator" aria-orientation="vertical"
              title={L('끌어서 폭 조절 · 더블클릭하면 같은 폭으로', 'Drag to resize · double-click for equal widths')}
              onPointerDown={drag(i)} onDoubleClick={() => setWeights({})} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function FreeDesk({ screens, focused, onFocus, render }) {
  const deskRef = useRef(null);
  const [frames, setFrames] = useState({}); // key -> { x, y, w, h, z, max } as fractions of the desk
  const zTop = useRef(1);
  // A screen that has no place yet gets one: cascaded from the top-left.
  useEffect(() => {
    setFrames(prev => {
      let changed = false;
      const next = { ...prev };
      let n = Object.keys(prev).length;
      for (const x of screens) {
        if (next[x.key]) continue;
        const k = n % 6; n += 1; changed = true;
        next[x.key] = { x: 0.03 + k * 0.05, y: 0.03 + k * 0.06, w: 0.6, h: 0.62, z: ++zTop.current, max: false };
      }
      return changed ? next : prev;
    });
  }, [screens]);
  const raise = (key) => {
    onFocus(key);
    setFrames(prev => (prev[key] && prev[key].z === zTop.current ? prev : { ...prev, [key]: { ...prev[key], z: ++zTop.current } }));
  };
  const begin = (key, mode) => (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    raise(key);
    const desk = deskRef.current;
    const box = desk.getBoundingClientRect();
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);
    desk.classList.add('is-moving');
    const start = { ...frames[key], px: e.clientX, py: e.clientY };
    if (start.max) { start.x = 0; start.y = 0; start.w = 1; start.h = 1; }
    const minW = 200 / box.width, minH = 120 / box.height;
    const move = (ev) => {
      const dx = (ev.clientX - start.px) / box.width, dy = (ev.clientY - start.py) / box.height;
      let { x, y, w, h } = start;
      if (mode === 'move') { x = clamp(x + dx, -w + 0.08, 0.92); y = clamp(y + dy, 0, 0.94); }
      if (mode !== 'move' && mode.includes('e')) w = clamp(w + dx, minW, 1.2 - x);
      if (mode !== 'move' && mode.includes('s')) h = clamp(h + dy, minH, 1.2 - y);
      if (mode !== 'move' && mode.includes('w')) { const nx = clamp(x + dx, -0.2, x + w - minW); w += x - nx; x = nx; }
      if (mode !== 'move' && mode.includes('n')) { const ny = clamp(y + dy, 0, y + h - minH); h += y - ny; y = ny; }
      setFrames(prev => ({ ...prev, [key]: { ...prev[key], x, y, w, h, max: false } }));
    };
    const up = () => {
      desk.classList.remove('is-moving');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
  const toggleMax = (key) => setFrames(prev => ({ ...prev, [key]: { ...prev[key], max: !prev[key]?.max, z: ++zTop.current } }));
  // Side by side once, as a starting point to drag from.
  const arrange = () => setFrames(prev => {
    const next = { ...prev };
    const cols = Math.ceil(Math.sqrt(screens.length)), rows = Math.ceil(screens.length / cols);
    screens.forEach((x, i) => {
      next[x.key] = { x: (i % cols) / cols, y: Math.floor(i / cols) / rows, w: 1 / cols, h: 1 / rows, z: next[x.key]?.z || ++zTop.current, max: false };
    });
    return next;
  });
  return (
    <div ref={deskRef} className="runner-desk">
      {screens.map(x => {
        const f = frames[x.key];
        if (!f) return null;
        const st = f.max
          ? { left: 0, top: 0, width: '100%', height: '100%', zIndex: f.z }
          : { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`, zIndex: f.z };
        return (
          <div key={x.key} className={`runner-win ${focused === x.key ? 'is-on' : ''} ${f.max ? 'is-max' : ''}`} style={st} onPointerDownCapture={() => raise(x.key)}>
            <div className="runner-win-title" onPointerDown={begin(x.key, 'move')} onDoubleClick={() => toggleMax(x.key)}>
              {x.kind === 'app' ? <AppWindow size={12} /> : <Globe size={12} />}
              <span title={x.label}>{x.label}</span>
              <button type="button" className="runner-icon" title={f.max ? L('원래 크기로', 'Restore') : L('패널에 꽉 차게', 'Fill the panel')} onClick={() => toggleMax(x.key)}>
                {f.max ? <CopyIcon size={11} /> : <SquareIcon size={11} />}
              </button>
              {render(x, 'chrome')}
            </div>
            <div className="runner-win-body">{render(x, 'free', f.z)}</div>
            {!f.max && ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(m => (
              <div key={m} className={`runner-win-edge edge-${m}`} onPointerDown={begin(x.key, m)} />
            ))}
          </div>
        );
      })}
      {screens.length > 1 && (
        <button type="button" className="runner-chip runner-desk-arrange" onClick={arrange} title={L('모두 겹치지 않게 나란히 배치', 'Lay them all out without overlapping')}>
          <LayoutGrid size={12} /> {L('정렬', 'Arrange')}
        </button>
      )}
    </div>
  );
}

const sortUrls = (list) => [...list].sort((a, b) => urlRank(a) - urlRank(b));
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
  const [viewport, setViewport] = useState(() => { try { return localStorage.getItem(VIEWPORT_KEY) || 'fit'; } catch { return 'fit'; } });
  const [wide, setWide] = useState(false); // the preview alone, across the whole workspace
  // One screen, several side by side, or a desktop of free windows.
  const [layout, setLayoutState] = useState(() => { try { return localStorage.getItem(LAYOUT_KEY) || 'single'; } catch { return 'single'; } });
  const setLayout = (v) => { setLayoutState(v); try { localStorage.setItem(LAYOUT_KEY, v); } catch { /* full */ } };
  const [hiddenScreens, setHiddenScreens] = useState(() => new Set()); // left out of side-by-side and free
  const [pickerOpen, setPickerOpen] = useState(false);
  const seenWindows = useRef(new Set());
  const pickViewport = (id) => { setViewport(id); try { localStorage.setItem(VIEWPORT_KEY, id); } catch { /* full */ } };
  const [, tick] = useState(0);
  const pending = useRef({});
  /* Panel widths, dragged by the handles between them and kept for next time.
     `preview` 0 means "not chosen yet": the preview then takes 45%. */
  const [sizes, setSizes] = useState(loadSizes);
  const rootRef = useRef(null);
  const chosePreview = useRef(false); // the reader picked the page; addresses printed later do not replace it
  const startDrag = (which) => (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);
    root.classList.add('is-resizing');
    let last = null;
    const move = (ev) => {
      setSizes(prev => {
        const next = which === 'side'
          ? { ...prev, side: Math.round(Math.min(Math.max(ev.clientX - box.left, 200), box.width * 0.45)) }
          : { ...prev, preview: Math.round(Math.min(Math.max(box.right - ev.clientX, 260), box.width - prev.side - 280)) };
        last = next;
        return next;
      });
    };
    const up = () => {
      root.classList.remove('is-resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      if (last) saveSizes(last);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
  const resetSize = (which) => setSizes(prev => { const n = { ...prev, [which]: which === 'side' ? 280 : 0 }; saveSizes(n); return n; });
  const handleKeys = (which) => (e) => {
    const step = e.key === 'ArrowLeft' ? -24 : e.key === 'ArrowRight' ? 24 : 0;
    if (step) {
      e.preventDefault();
      setSizes(prev => {
        const n = which === 'side'
          ? { ...prev, side: Math.min(Math.max(prev.side + step, 200), 600) }
          : { ...prev, preview: Math.min(Math.max((prev.preview || 480) - step, 260), 1400) };
        saveSizes(n);
        return n;
      });
    } else if (e.key === 'Home') { e.preventDefault(); resetSize(which); }
  };

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
        setProcs(prev => prev.map(p => (p.id === id ? { ...p, urls: sortUrls(new Set([...(p.urls || []), url])) } : p)));
        // The app's own root replaces a plugin's sub-page shown on its own.
        setPreview(cur => (!cur || (!chosePreview.current && sameOrigin(cur, url) && urlRank(url) < urlRank(cur)) ? url : cur));
      }),
      api.on('windows', ({ id, windows }) => {
        setProcs(prev => prev.map(p => (p.id === id ? { ...p, windows: windows || [] } : p)));
        /* A window that just opened is what the reader wants to see -- the
           game started. Unless they picked a screen themselves. */
        const fresh = (windows || []).filter(w => !seenWindows.current.has(w.hwnd));
        for (const w of windows || []) seenWindows.current.add(w.hwnd);
        if (fresh.length && !chosePreview.current) setPreview(`win:${fresh[fresh.length - 1].hwnd}`);
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

  const restart = async (p) => { try { if (!p.exited) await api.stop(p.id); await start(p.command); } catch (e) { setError(String(e?.message || e)); } };
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
  /* Everything the projects show: the pages their servers printed and the
     windows their programs opened, running ones first. One project can open
     several -- a game and its editor, a server and its admin page. */
  const screens = [];
  for (const p of [...procs].sort((a, b) => Number(a.exited) - Number(b.exited))) {
    for (const w of p.windows || []) screens.push({ key: `win:${w.hwnd}`, kind: 'app', hwnd: w.hwnd, w: w.w, h: w.h, popped: w.popped, label: w.title || L('프로그램 창', 'Window'), proc: p });
    for (const u of p.urls || []) if (!screens.some(x => x.key === u)) screens.push({ key: u, kind: 'web', url: u, label: u.replace(/^https?:\/\//, ''), proc: p });
  }
  const screenOf = (key) => screens.find(x => x.key === key)
    || (key && !key.startsWith('win:') ? { key, kind: 'web', url: key, label: key.replace(/^https?:\/\//, '') } : null);
  const shown = screenOf(preview);
  const running = procs.filter(p => !p.exited).length;
  useEffect(() => {
    if (preview && preview.startsWith('win:') && !screens.some(x => x.key === preview)) {
      chosePreview.current = false;
      setPreview(screens[0]?.key || null);
    }
  }); // every render: cheap, and windows come and go between them

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
    <div ref={rootRef} className={`runner ${preview ? 'has-preview' : ''} ${preview && wide ? 'preview-wide' : ''}`}
      style={{ '--runner-side': `${sizes.side}px`, '--runner-preview': sizes.preview ? `${sizes.preview}px` : '45%' }}>
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
                ? <button type="button" className="runner-icon danger" title={L('중지', 'Stop')} onClick={(e) => { e.stopPropagation(); api.stop(p.id).catch(e => setError(String(e?.message || e))); }}><Square size={12} /></button>
                : <button type="button" className="runner-icon" title={L('목록에서 지우기', 'Remove')} onClick={(e) => { e.stopPropagation(); remove(p); }}><Trash2 size={13} /></button>}
            </div>
          ))}
        </div>
      </aside>
      <div className="runner-split" role="separator" aria-orientation="vertical" tabIndex={0}
        title={L('끌어서 크기 조절 · 더블클릭하면 원래대로', 'Drag to resize · double-click to reset')}
        onPointerDown={startDrag('side')} onKeyDown={handleKeys('side')} onDoubleClick={() => resetSize('side')} />

      <section className="runner-main">
        <header className="runner-bar">
          <Terminal size={14} />
          <code className="runner-title">{current ? current.command : L('터미널', 'Terminal')}</code>
          <span className="runner-space" />
          {screens.filter(x => x.proc === current).map(x => (
            <button key={x.key} type="button" className={`runner-chip ${preview === x.key ? 'is-on' : ''}`} onClick={() => { chosePreview.current = true; setPreview(x.key); setPreviewKey(k => k + 1); }} title={L('옆에서 미리보기', 'Preview beside')}>
              {x.kind === 'app' ? <AppWindow size={12} /> : <Globe size={12} />} <span className="runner-chip-text">{x.label}</span>
            </button>
          ))}
          {current && <button type="button" className="runner-icon" title={L('출력 지우기', 'Clear output')} onClick={() => setOutputs(prev => ({ ...prev, [current.id]: '' }))}><Eraser size={14} /></button>}
          <button type="button" className="runner-icon" title={preview ? L('미리보기 닫기', 'Close preview') : L('미리보기 열기', 'Open preview')}
            onClick={() => setPreview(p => (p ? null : (screens[0]?.key || urls[0] || 'http://localhost:5173')))}>
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

      {preview && <div className="runner-split" role="separator" aria-orientation="vertical" tabIndex={0}
        title={L('끌어서 크기 조절 · 더블클릭하면 원래대로', 'Drag to resize · double-click to reset')}
        onPointerDown={startDrag('preview')} onKeyDown={handleKeys('preview')} onDoubleClick={() => resetSize('preview')} />}
      {preview && shown && (
        <section className="runner-preview">
          <header className="runner-bar">
            {shown.kind === 'app' ? <AppWindow size={14} /> : <Globe size={14} />}
            {shown.kind === 'app'
              ? <span className="runner-url runner-url-label" title={shown.label}>{shown.label}</span>
              : <input className="runner-url" defaultValue={shown.url} key={shown.url}
                onKeyDown={(e) => { if (e.key === 'Enter') { let v = e.currentTarget.value.trim(); if (v && !/^https?:\/\//i.test(v)) v = `http://${v}`; chosePreview.current = true; setPreview(v); setPreviewKey(k => k + 1); } }} spellCheck={false} />}
            <select className="runner-viewport" value={viewport} onChange={e => pickViewport(e.target.value)} title={L('화면 비율·해상도', 'Aspect ratio / resolution')}>
              {VIEWPORTS.map(v => <option key={v.id} value={v.id}>{v.label ? v.label() : v.id}</option>)}
            </select>
            {shown.kind !== 'app' && <button type="button" className="runner-icon" title={L('새로고침', 'Reload')} onClick={() => setPreviewKey(k => k + 1)}><RefreshCcw size={14} /></button>}
            {screens.length > 1 && (
              <div className="runner-seg" role="radiogroup" aria-label={L('화면 배치', 'Screen layout')}>
                {[['single', <SquareIcon size={13} key="i" />, L('하나씩', 'One')], ['tiles', <Columns3 size={13} key="i" />, L('나란히 (폭 조절)', 'Side by side')], ['free', <LayoutGrid size={13} key="i" />, L('자유 배치 (창처럼 이동·크기 조절)', 'Free windows')]].map(([id, icon, label]) => (
                  <button key={id} type="button" role="radio" aria-checked={layout === id} className={layout === id ? 'is-on' : ''} title={label} onClick={() => setLayout(id)}>{icon}</button>
                ))}
              </div>
            )}
            {screens.length > 1 && (layout !== 'single' || hiddenScreens.size > 0) && (
              <div className="runner-picker">
                <button type="button" className={`runner-icon runner-picker-btn ${pickerOpen ? 'is-on' : ''}`} title={L('띄울 화면 고르기', 'Choose which screens to show')} onClick={() => setPickerOpen(o => !o)}>
                  <AppWindow size={13} /><span>{screens.filter(x => !hiddenScreens.has(x.key)).length}/{screens.length}</span><ChevronDown size={11} />
                </button>
                {pickerOpen && (
                  <>
                    <div className="runner-picker-scrim" onClick={() => setPickerOpen(false)} />
                    <div className="runner-picker-menu" role="menu">
                      {screens.map(x => {
                        const on = !hiddenScreens.has(x.key);
                        return (
                          <button key={x.key} type="button" role="menuitemcheckbox" aria-checked={on} className={on ? 'is-on' : ''}
                            onClick={() => setHiddenScreens(prev => { const n = new Set(prev); if (on) n.add(x.key); else n.delete(x.key); return n; })}>
                            <span className="runner-check">{on && <Check size={11} />}</span>
                            {x.kind === 'app' ? <AppWindow size={12} /> : <Globe size={12} />}
                            <span className="runner-picker-label" title={x.label}>{x.label}</span>
                            {x.proc?.exited && <em>{L('종료', 'ended')}</em>}
                          </button>
                        );
                      })}
                      <div className="runner-picker-foot">
                        <button type="button" onClick={() => setHiddenScreens(new Set())}>{L('모두 보기', 'Show all')}</button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
            <button type="button" className={`runner-icon ${wide ? 'is-on' : ''}`} title={wide ? L('터미널 다시 보기', 'Show the terminal again') : L('미리보기만 크게', 'Preview only, full width')} onClick={() => setWide(w => !w)}>
              {wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            {shown.kind === 'app'
              ? <button type="button" className="runner-icon" title={shown.popped ? L('다시 넣기', 'Bring it back in') : L('따로 창으로 띄우기', 'Pop out into its own window')}
                  onClick={() => api.popout(shown.hwnd, !shown.popped)}>{shown.popped ? <SquareArrowDownLeft size={14} /> : <SquareArrowOutUpRight size={14} />}</button>
              : <button type="button" className="runner-icon" title={L('앱 브라우저로 열기', 'Open in the app browser')} onClick={() => api.browse(shown.url)}><ExternalLink size={14} /></button>}
            <button type="button" className="runner-icon" title={L('닫기', 'Close')} onClick={() => setPreview(null)}><X size={14} /></button>
          </header>
          {(() => {
            const visible = screens.filter(x => !hiddenScreens.has(x.key));
            const many = screens.length > 1 && layout !== 'single' && visible.length > 0;
            /* What each screen shows, and the buttons its own title bar carries
               in the free layout. */
            const render = (x, where, z = 0) => {
              if (where === 'chrome') {
                return (
                  <>
                    {x.kind === 'app'
                      ? <button type="button" className="runner-icon" title={x.popped ? L('다시 넣기', 'Bring it back in') : L('따로 창으로 띄우기', 'Pop out')} onClick={() => api.popout(x.hwnd, !x.popped)}>{x.popped ? <SquareArrowDownLeft size={11} /> : <SquareArrowOutUpRight size={11} />}</button>
                      : <button type="button" className="runner-icon" title={L('앱 브라우저로 열기', 'Open in the app browser')} onClick={() => api.browse(x.url)}><ExternalLink size={11} /></button>}
                    <button type="button" className="runner-icon" title={L('이 화면 숨기기', 'Hide this screen')} onClick={() => setHiddenScreens(prev => new Set(prev).add(x.key))}><EyeOff size={11} /></button>
                  </>
                );
              }
              const stage = <PreviewStage screen={x} frameKey={previewKey} viewport={where === 'free' ? 'stretch' : viewport} active={open && !pickerOpen} z={z} onPopIn={() => api.popout(x.hwnd, false)} />;
              if (where === 'free') return stage;
              return (
                <>
                  <div className="runner-tile-head">
                    {x.kind === 'app' ? <AppWindow size={12} /> : <Globe size={12} />} <span title={x.label}>{x.label}</span>
                    <span className="runner-space" />
                    {render(x, 'chrome')}
                  </div>
                  {stage}
                </>
              );
            };
            const focus = (key) => { chosePreview.current = true; setPreview(key); };
            /* Hidden is not gone: what was hidden waits here, one click from
               coming back (and in the picker above). */
            const hiddenList = screens.filter(x => hiddenScreens.has(x.key));
            const tray = hiddenList.length > 0 && (
              <div className="runner-tray" role="toolbar" aria-label={L('숨긴 화면', 'Hidden screens')}>
                <EyeOff size={12} />
                <span className="runner-tray-label">{L('숨김', 'Hidden')}</span>
                {hiddenList.map(x => (
                  <button key={x.key} type="button" className="runner-chip" title={L('다시 보기', 'Show again')}
                    onClick={() => { setHiddenScreens(prev => { const n = new Set(prev); n.delete(x.key); return n; }); focus(x.key); }}>
                    <Eye size={12} /> <span className="runner-chip-text">{x.label}</span>
                  </button>
                ))}
                {hiddenList.length > 1 && <button type="button" className="runner-tray-all" onClick={() => setHiddenScreens(new Set())}>{L('모두 보기', 'Show all')}</button>}
              </div>
            );
            if (many && layout === 'tiles') return <>{<TileRow screens={visible} focused={preview} onFocus={focus} render={render} />}{tray}</>;
            if (many && layout === 'free') return <>{<FreeDesk screens={visible} focused={preview} onFocus={focus} render={render} />}{tray}</>;
            return (
              <>
                {screens.length > 1 && (
                  <nav className="runner-tabs" aria-label={L('화면', 'Screens')}>
                    {screens.map(x => (
                      <button key={x.key} type="button" className={`runner-tab ${preview === x.key ? 'is-on' : ''} ${hiddenScreens.has(x.key) ? 'is-hidden' : ''}`} title={x.label}
                        onClick={() => { setHiddenScreens(prev => { if (!prev.has(x.key)) return prev; const n = new Set(prev); n.delete(x.key); return n; }); chosePreview.current = true; setPreview(x.key); }}>
                        {x.kind === 'app' ? <AppWindow size={12} /> : <Globe size={12} />}
                        <span>{x.label}</span>
                        {x.proc?.exited && <em>{L('종료', 'ended')}</em>}
                      </button>
                    ))}
                  </nav>
                )}
                <PreviewStage key={shown.key} screen={shown} frameKey={previewKey} viewport={viewport} active={open && !pickerOpen} onPopIn={() => api.popout(shown.hwnd, false)} />
                {tray}
              </>
            );
          })()}
        </section>
      )}
    </div>
  );
}
