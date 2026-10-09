import React, { useEffect, useId, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, RotateCcw, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Copy, Check, MoveHorizontal, Code } from 'lucide-react';
import { copyText } from './clipboard.js';
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
    const wheel = (e) => { if (!e.ctrlKey) return; e.preventDefault(); zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1); };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  useEffect(() => {
    let cancelled = false;
    const n = ++seq.current;
    const text = String(source || '').trim();
    if (!text) return undefined;
    // Streaming: wait for a pause so a growing block is not parsed per token.
    const timer = setTimeout(async () => {
      try {
        const mermaid = await ready();
        await fontsReady(text);
        await mermaid.parse(text);
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

  /* The size it is drawn at: fitted to the column, but never below the
     readable scale (then it scrolls) and never blown up past a little over
     natural size. "원래 크기" shows it at 100%. */
  const room = Math.max(0, stageWidth - 40);
  const fitScale = natural && room ? Math.min(MAX_GROW, room / natural.w) : 1;
  const drawScale = fit ? Math.max(MIN_READABLE, fitScale) : 1;
  const overflows = natural && room ? natural.w * drawScale > room + 1 : false;
  const svgStyle = natural ? { '--mmd-w': `${Math.round(natural.w * drawScale)}px`, '--mmd-h': `${Math.round(natural.h * drawScale)}px` } : undefined;

  const move = (dx, dy) => setView(v => ({ ...v, x: v.x + dx, y: v.y + dy }));
  const zoom = (f) => { setView(v => ({ ...v, scale: Math.min(6, Math.max(0.25, Math.round(v.scale * f * 100) / 100)) })); flash(); };
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
    <figure className={`mermaid-block ${fit ? 'is-fit' : 'is-wide'}${natural ? ' is-sized' : ''}${overflows ? ' is-overflow' : ''}`}>
      <div className="mermaid-tools">
        <button type="button" className="mermaid-btn" title={fit ? '원래 크기' : '폭에 맞추기'} aria-label={fit ? '원래 크기' : '폭에 맞추기'} onClick={() => setFit(f => !f)}><MoveHorizontal size={15} /></button>
        <button type="button" className="mermaid-btn" title="코드 보기" aria-label="코드 보기" aria-pressed={showCode} onClick={() => setShowCode(s => !s)}><Code size={15} /></button>
        <button type="button" className="mermaid-btn" title="코드 복사" aria-label="코드 복사" onClick={copy}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
      </div>
      <div
        ref={stage}
        className="mermaid-stage"
        onPointerDown={(e) => { if (e.button !== 0 || e.target.closest('button')) return; drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { if (!drag.current) return; move(e.clientX - drag.current.x, e.clientY - drag.current.y); drag.current = { x: e.clientX, y: e.clientY }; }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onDoubleClick={reset}
      >
        <div className={`mermaid-zoom${badge || view.scale !== 1 ? ' is-on' : ''}${badge ? ' is-flash' : ''}`} role="status" aria-live="polite">{Math.round(view.scale * 100)}%</div>
        {overflows && <div className="mermaid-hint">← 끌거나 가로로 스크롤해서 보기 →</div>}
        <div className="mermaid-canvas" style={{ ...svgStyle, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
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
