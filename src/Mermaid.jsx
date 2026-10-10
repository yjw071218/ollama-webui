import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, RotateCcw, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Copy, Check, MoveHorizontal, Code, Maximize2, Minimize2 } from 'lucide-react';
import { copyText } from './clipboard.js';
import { repairMermaid } from './mermaidRepair.js';
// Self-hosted Korean UI font, loaded only with diagrams (split by glyph range).
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';

/* A fenced ```mermaid block drawn as a diagram: flowcharts, sequence
 * diagrams, timelines, mind maps, state and ER diagrams, pie and quadrant
 * charts. The library is large (~1 MB), so it is loaded the first time a
 * diagram appears and never for a chat that has none.
 *
 * While an answer streams the block is half written and does not parse; the
 * source is shown until it does, and a failed parse never replaces a diagram
 * that already rendered -- it keeps the last good one. */

const FONT = '"Pretendard Variable", Pretendard, "Noto Sans KR", "Apple SD Gothic Neo", "Segoe UI", system-ui, sans-serif';
let loading = null;
/* Mermaid measures text when it draws; with the font still loading every box
   was sized for the fallback and the label then overflowed it. */
const fontsReady = (text) => {
  try {
    return Promise.race([
      Promise.all(['400', '600'].map(w => document.fonts.load(`${w} 14px "Pretendard Variable"`, text.slice(0, 2000)))),
      new Promise(r => setTimeout(r, 1500)),
    ]);
  } catch { return Promise.resolve(); }
};
const themeOf = () => {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim() || '#0d1117';
  const m = /^#?([0-9a-f]{6})$/i.exec(bg.replace('#', '')) ? bg : '#0d1117';
  const n = parseInt(m.replace('#', ''), 16);
  const light = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 140;
  return light ? 'default' : 'dark';
};
const loadMermaid = () => {
  loading ||= import('mermaid').then(m => m.default);
  return loading;
};
let configured = '';
const ready = async () => {
  const mermaid = await loadMermaid();
  const theme = themeOf();
  if (configured !== theme) {
    mermaid.initialize({
      startOnLoad: false, theme: 'base', securityLevel: 'strict',
      fontFamily: FONT,
      fontSize: 15,
      // Warm, app-matching colours (the UI is a warm charcoal with a clay accent).
      themeVariables: theme === 'dark' ? {
        darkMode: true, background: 'transparent', fontSize: '15px',
        primaryColor: '#2f2b26', primaryTextColor: '#f1ece4', primaryBorderColor: '#7a6a58',
        secondaryColor: '#283029', secondaryTextColor: '#e9efe6', secondaryBorderColor: '#5f8a6c',
        tertiaryColor: '#2c2833', tertiaryTextColor: '#ece8f3', tertiaryBorderColor: '#8a7aa8',
        lineColor: '#9c8f80', textColor: '#e3ddd3', mainBkg: '#2f2b26', nodeBorder: '#7a6a58',
        clusterBkg: '#24211d', clusterBorder: '#4a433b', edgeLabelBackground: '#24211d',
        actorBkg: '#2f2b26', actorBorder: '#7a6a58', actorTextColor: '#f1ece4', actorLineColor: '#6b6157',
        signalColor: '#c9bfb2', signalTextColor: '#e3ddd3', labelBoxBkgColor: '#2f2b26', labelBoxBorderColor: '#7a6a58',
        noteBkgColor: '#3a3122', noteTextColor: '#f3e7cc', noteBorderColor: '#a0855a',
        pie1: '#d97757', pie2: '#6f9c7f', pie3: '#8a7aa8', pie4: '#c9a45c', pie5: '#5f8fb0', pie6: '#b0706f',
        git0: '#d97757', git1: '#6f9c7f', git2: '#8a7aa8', git3: '#c9a45c',
      } : {
        background: 'transparent', fontSize: '15px',
        primaryColor: '#fbf6ef', primaryTextColor: '#2a241e', primaryBorderColor: '#c7a98c',
        secondaryColor: '#eef6f0', secondaryBorderColor: '#8fb79c', tertiaryColor: '#f4f0fa', tertiaryBorderColor: '#ad9ccc',
        lineColor: '#8d8174', textColor: '#2f2923', clusterBkg: '#faf8f5', clusterBorder: '#e2d9cd', edgeLabelBackground: '#ffffff',
        actorBkg: '#fbf6ef', actorBorder: '#c7a98c', noteBkgColor: '#fff6e0', noteBorderColor: '#d8b878',
        pie1: '#d97757', pie2: '#6f9c7f', pie3: '#8a7aa8', pie4: '#c9a45c', pie5: '#5f8fb0', pie6: '#b0706f',
      },
      /* Sized by this component (see `natural` below), not squeezed to the
         column: useMaxWidth shrank a wide tree until its text was unreadable. */
      flowchart: { htmlLabels: true, curve: 'basis', useMaxWidth: false, nodeSpacing: 46, rankSpacing: 58, padding: 14, wrappingWidth: 220 },
      sequence: { mirrorActors: false, useMaxWidth: false, actorMargin: 60, boxMargin: 12, messageFontSize: 14, noteFontSize: 14, actorFontSize: 15 },
      class: { useMaxWidth: false }, state: { useMaxWidth: false }, er: { useMaxWidth: false },
      gantt: { useMaxWidth: false }, journey: { useMaxWidth: false }, timeline: { useMaxWidth: false },
      mindmap: { useMaxWidth: false, padding: 14 }, pie: { useMaxWidth: false }, quadrantChart: { useMaxWidth: false },
    });
    configured = theme;
  }
  return mermaid;
};

const STEP = 60;
/* Below this the labels are too small to read; a diagram that would need to
   shrink further scrolls sideways instead. */
const MIN_READABLE = 0.78;
const MAX_GROW = 1.15;

/* The drawn size, from the viewBox mermaid writes. */
const naturalSize = (svg) => {
  const m = /viewBox="\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)\s*"/.exec(svg);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
};

/* A top-down tree with many leaves is a long, flat strip: drawn left-to-right
   the same tree is a readable column. Only plain TD/TB flowcharts are turned. */
const TD_HEADER = /^(\s*(?:%%[^\n]*\n\s*)*)(flowchart|graph)\s+(TD|TB)\b/i;
const turnSideways = (text) => (TD_HEADER.test(text) ? text.replace(TD_HEADER, (_, lead, kw) => `${lead}${kw} LR`) : null);

export default function Mermaid({ source, live = false }) {
  const id = 'mmd-' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fit, setFit] = useState(true);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [natural, setNatural] = useState(null);
  const [stageWidth, setStageWidth] = useState(0);
  const drag = useRef(null);
  const touches = useRef(new Map());
  const lastPointer = useRef('mouse');
  const canvas = useRef(null);
  const [full, setFull] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const seq = useRef(0);
  const stage = useRef(null);
  const [badge, setBadge] = useState(false);
  const badgeTimer = useRef(null);
  const flash = () => { setBadge(true); clearTimeout(badgeTimer.current); badgeTimer.current = setTimeout(() => setBadge(false), 1200); };
  useEffect(() => () => clearTimeout(badgeTimer.current), []);
  // Ctrl+wheel needs a non-passive listener, or the page zooms/scrolls too.
  useEffect(() => {
    const el = stage.current;
    if (!el) return undefined;
    const wheel = (e) => { if (!e.ctrlKey) return; e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY); flash(); };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  useEffect(() => {
    let cancelled = false;
    const n = ++seq.current;
    const original = String(source || '').trim();
    if (!original) return undefined;
    // Streaming: wait for a pause so a growing block is not parsed per token.
    const timer = setTimeout(async () => {
      try {
        const mermaid = await ready();
        await fontsReady(original);
        /* A label with unquoted brackets is the usual parse error; the same
           diagram with its labels quoted is tried before saying it failed. */
        let text = original;
        try { await mermaid.parse(text); } catch (first) {
          const fixed = repairMermaid(text);
          if (!fixed) throw first;
          try { await mermaid.parse(fixed); text = fixed; } catch { throw first; }
        }
        let { svg: out } = await mermaid.render(`${id}-${n}`, text);
        let size = naturalSize(out);
        // Too wide to read once fitted? Try the same tree drawn sideways.
        const room = Math.max(320, (stage.current?.clientWidth || document.querySelector('.messages-container, main')?.clientWidth || 760) - 40);
        const sideways = !live && size && size.w / size.h > 2.4 && room / size.w < MIN_READABLE ? turnSideways(text) : null;
        if (sideways && !cancelled && n === seq.current) {
          try {
            const turned = await mermaid.render(`${id}-${n}s`, sideways);
            const tsize = naturalSize(turned.svg);
            if (tsize && Math.min(1, room / tsize.w) > Math.min(1, room / size.w) * 1.2) { out = turned.svg; size = tsize; }
          } catch { document.getElementById(`d${id}-${n}s`)?.remove(); }
        }
        if (!cancelled && n === seq.current) { setSvg(out); setNatural(size); setError(''); }
      } catch (e) {
        document.getElementById(`d${id}-${n}`)?.remove();
        if (!cancelled && n === seq.current) setError(String(e?.message || e).split('\n')[0]);
      }
    }, live ? 350 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [source, live, id]);

  useEffect(() => {
    const el = stage.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setStageWidth(el.clientWidth));
    ro.observe(el);
    setStageWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [svg]);

  /* Readable labels on any fill. A diagram that sets its own colours
     (classDef / style, usually light pastels) kept the theme's light text in
     dark mode: white on pale pink. Each node's text now follows its fill. */
  useLayoutEffect(() => {
    const root = canvas.current;
    if (!root || !svg) return;
    const lum = (c) => {
      const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?/.exec(c || '');
      if (!m || (m[4] !== undefined && Number(m[4]) < 0.25)) return null;
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(+m[1]) + 0.7152 * f(+m[2]) + 0.0722 * f(+m[3]);
    };
    for (const node of root.querySelectorAll('g.node, g.cluster, g.actor, rect.actor, g.note')) {
      const shape = node.matches('rect') ? node : node.querySelector('rect, polygon, circle, ellipse, path.label-container, path.basic');
      if (!shape) continue;
      const L = lum(getComputedStyle(shape).fill);
      if (L == null) continue;
      const ink = L > 0.42 ? '#1d1915' : L < 0.18 ? '#f3eee6' : null;
      if (!ink) continue;
      const scope = node.matches('rect') ? node.parentElement : node;
      for (const el of scope.querySelectorAll('.nodeLabel, .label, span, p, div, foreignObject *, text, tspan')) {
        el.style.setProperty('color', ink, 'important');
        if (el instanceof SVGElement) el.style.setProperty('fill', ink, 'important');
      }
      // A light card gets a soft outline instead of the glow meant for dark ones.
      if (L > 0.42) shape.style.setProperty('filter', 'drop-shadow(0 1px 1.5px rgba(0,0,0,.35))');
    }
  }, [svg]);

  /* The size it is drawn at: fitted to the column, but never below the
     readable scale (then it scrolls) and never blown up past a little over
     natural size. "원래 크기" shows it at 100%. */
  const room = Math.max(0, stageWidth - 40);
  const fitScale = natural && room ? Math.min(MAX_GROW, room / natural.w) : 1;
  const drawScale = fit ? Math.max(MIN_READABLE, fitScale) : 1;
  const overflows = natural && room ? natural.w * drawScale > room + 1 : false;
  const svgStyle = natural ? { '--mmd-w': `${Math.round(natural.w * drawScale)}px`, '--mmd-h': `${Math.round(natural.h * drawScale)}px` } : undefined;

  const move = (dx, dy) => setView(v => ({ ...v, x: v.x + dx, y: v.y + dy }));
  /* Zoom keeping the point under (cx, cy) -- a finger, the pointer, or the
     middle of the stage for the buttons -- where it is. The canvas scales from
     its top-left corner, so its untransformed corner is rect.left - x. */
  const zoomAt = (f, cx, cy) => {
    setView(v => {
      const scale = Math.min(6, Math.max(0.25, Math.round(v.scale * f * 1000) / 1000));
      const el = canvas.current;
      if (!el || cx == null) return { ...v, scale };
      const r = el.getBoundingClientRect();
      const px = cx - (r.left - v.x), py = cy - (r.top - v.y);
      const k = scale / v.scale;
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  };
  const zoom = (f) => {
    const r = stage.current?.getBoundingClientRect();
    zoomAt(f, r ? r.left + r.width / 2 : null, r ? r.top + r.height / 2 : null);
    flash();
  };

  /* Gestures, all measured from where they began (not frame to frame), so
     nothing drifts:
       - one finger: in the answer, sideways pans the diagram and up/down is
         left to the page; zoomed in or full screen, it pans every way.
       - two fingers: pinch-zoom about the fingers, and pan.
       - double tap: 2x at that point, or back. Only two real taps count --
         short, still, close together -- so quick repeated swipes while
         panning are no longer read as a double tap (which zoomed in/out). */
  const gesture = useRef(null);
  const lastTapAt = useRef({ t: 0, x: 0, y: 0 });
  const originOf = () => {
    const r = canvas.current?.getBoundingClientRect();
    const v = viewRef.current;
    return r ? { ox: r.left - v.x, oy: r.top - v.y } : { ox: 0, oy: 0 };
  };
  const startPan = (p) => {
    gesture.current = { kind: 'pan', sx: p.x, sy: p.y, v: { ...viewRef.current }, axis: null, moved: 0, t: Date.now() };
  };
  const startPinch = () => {
    const [a, b] = [...touches.current.values()];
    const v = { ...viewRef.current };
    const { ox, oy } = originOf();
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    // The diagram point under the fingers, in unscaled canvas units.
    gesture.current = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, v, ox, oy, px: (mx - ox - v.x) / v.scale, py: (my - oy - v.y) / v.scale };
  };
  const zoomedNow = () => viewRef.current.scale > 1.05;
  const onDown = (e) => {
    lastPointer.current = e.pointerType;
    if (e.target.closest('button')) return;
    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return;
      drag.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: Date.now() });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* gone */ }
    if (touches.current.size === 2) startPinch();
    else if (touches.current.size === 1) startPan({ x: e.clientX, y: e.clientY });
  };
  const onMove = (e) => {
    if (e.pointerType === 'mouse') {
      if (!drag.current) return;
      move(e.clientX - drag.current.x, e.clientY - drag.current.y);
      drag.current = { x: e.clientX, y: e.clientY };
      return;
    }
    const tp = touches.current.get(e.pointerId);
    if (!tp) return;
    tp.x = e.clientX; tp.y = e.clientY;
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch' && touches.current.size >= 2) {
      const [a, b] = [...touches.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const scale = Math.min(6, Math.max(0.25, g.v.scale * (d / g.d0)));
      setView({ scale, x: mx - g.ox - g.px * scale, y: my - g.oy - g.py * scale });
      setBadge(true);
      return;
    }
    if (g.kind !== 'pan' || touches.current.size !== 1) return;
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    g.moved = Math.max(g.moved, Math.hypot(dx, dy));
    const free = full || zoomedNow();
    if (!free) {
      // Decide once, after a few pixels: sideways is ours, up/down the page's.
      if (!g.axis && g.moved > 8) g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (g.axis !== 'x') return;
      setView({ ...g.v, x: g.v.x + dx });
      return;
    }
    setView({ ...g.v, x: g.v.x + dx, y: g.v.y + dy });
  };
  const onUp = (e) => {
    if (e.pointerType === 'mouse') { drag.current = null; return; }
    const tp = touches.current.get(e.pointerId);
    touches.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.kind === 'pinch') {
      flash();
      // One finger still down: it carries on panning from here, no jump.
      const rest = [...touches.current.values()][0];
      if (rest) startPan(rest); else gesture.current = null;
      if (rest) gesture.current.fromPinch = true;
      return;
    }
    gesture.current = null;
    if (!tp || e.type === 'pointercancel' || g?.fromPinch) return;
    const still = Math.hypot(tp.x - tp.x0, tp.y - tp.y0) < 10 && Date.now() - tp.t0 < 260;
    if (!still) { lastTapAt.current = { t: 0, x: 0, y: 0 }; return; }
    const prev = lastTapAt.current, now = Date.now();
    if (now - prev.t < 320 && Math.hypot(tp.x - prev.x, tp.y - prev.y) < 36) {
      lastTapAt.current = { t: 0, x: 0, y: 0 };
      if (zoomedNow()) reset(); else { zoomAt(2, tp.x, tp.y); flash(); }
    } else lastTapAt.current = { t: now, x: tp.x, y: tp.y };
  };

  useEffect(() => {
    if (!full) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [full]);
  const reset = () => { setView({ scale: 1, x: 0, y: 0 }); flash(); };
  const copy = async () => { if (await copyText(source)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } };

  if (!svg) {
    return (
      <div className="mermaid-block is-pending">
        <div className="mermaid-status">{error && !live ? `다이어그램을 그릴 수 없습니다: ${error}` : '다이어그램을 그리는 중…'}</div>
        <pre className="mermaid-source"><code>{source}</code></pre>
      </div>
    );
  }
  return (
    <figure className={`mermaid-block ${fit ? 'is-fit' : 'is-wide'}${natural ? ' is-sized' : ''}${overflows ? ' is-overflow' : ''}${full ? ' is-full' : ''}${view.scale > 1.05 ? ' is-zoomed' : ''}`}>
      <div className="mermaid-tools">
        <button type="button" className="mermaid-btn" title={fit ? '원래 크기' : '폭에 맞추기'} aria-label={fit ? '원래 크기' : '폭에 맞추기'} onClick={() => setFit(f => !f)}><MoveHorizontal size={15} /></button>
        <button type="button" className="mermaid-btn" title="코드 보기" aria-label="코드 보기" aria-pressed={showCode} onClick={() => setShowCode(s => !s)}><Code size={15} /></button>
        <button type="button" className="mermaid-btn" title={full ? '닫기 (Esc)' : '전체 화면'} aria-label={full ? '전체 화면 닫기' : '전체 화면'} aria-pressed={full} onClick={() => { setFull(f => !f); setView({ scale: 1, x: 0, y: 0 }); }}>{full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
        <button type="button" className="mermaid-btn" title="코드 복사" aria-label="코드 복사" onClick={copy}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
      </div>
      <div
        ref={stage}
        className="mermaid-stage"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={(e) => { if (lastPointer.current !== 'mouse' || e.target.closest('button')) return; reset(); }}
      >
        <div className={`mermaid-zoom${badge || view.scale !== 1 ? ' is-on' : ''}${badge ? ' is-flash' : ''}`} role="status" aria-live="polite">{Math.round(view.scale * 100)}%</div>
        {overflows && !full && <div className="mermaid-hint">← 밀어서 보기 · 두 손가락으로 확대 →</div>}
        <div ref={canvas} className="mermaid-canvas" style={{ ...svgStyle, transformOrigin: '0 0', transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
          // Rendered by mermaid with securityLevel "strict" (sanitised, no scripts or click handlers).
          dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="mermaid-pad" role="group" aria-label="다이어그램 이동·확대">
          <span />
          <button type="button" className="mermaid-btn" aria-label="위로" onClick={() => move(0, STEP)}><ChevronUp size={15} /></button>
          <button type="button" className="mermaid-btn" aria-label="확대" onClick={() => zoom(1.25)}><ZoomIn size={15} /></button>
          <button type="button" className="mermaid-btn" aria-label="왼쪽으로" onClick={() => move(STEP, 0)}><ChevronLeft size={15} /></button>
          <button type="button" className="mermaid-btn" aria-label="초기화" onClick={reset}><RotateCcw size={15} /></button>
          <button type="button" className="mermaid-btn" aria-label="오른쪽으로" onClick={() => move(-STEP, 0)}><ChevronRight size={15} /></button>
          <span />
          <button type="button" className="mermaid-btn" aria-label="아래로" onClick={() => move(0, -STEP)}><ChevronDown size={15} /></button>
          <button type="button" className="mermaid-btn" aria-label="축소" onClick={() => zoom(0.8)}><ZoomOut size={15} /></button>
        </div>
      </div>
      {showCode && <pre className="mermaid-source"><code>{source}</code></pre>}
    </figure>
  );
}
