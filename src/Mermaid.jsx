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
      fontSize: 14,
      // Muted, app-like colours instead of mermaid's neon defaults.
      themeVariables: theme === 'dark' ? {
        darkMode: true, background: 'transparent', fontSize: '14px',
        primaryColor: '#2a3140', primaryTextColor: '#e6e9ef', primaryBorderColor: '#5b6b8c',
        secondaryColor: '#24303a', secondaryTextColor: '#e6e9ef', secondaryBorderColor: '#4f7a6e',
        tertiaryColor: '#2e2a3a', tertiaryTextColor: '#e6e9ef', tertiaryBorderColor: '#7a6a9c',
        lineColor: '#8b95a7', textColor: '#d6dae2', mainBkg: '#2a3140', nodeBorder: '#5b6b8c',
        clusterBkg: '#1c222c', clusterBorder: '#3a4352', edgeLabelBackground: '#1c222c',
        actorBkg: '#2a3140', actorBorder: '#5b6b8c', actorTextColor: '#e6e9ef', noteBkgColor: '#3a3524', noteTextColor: '#efe6c8', noteBorderColor: '#8c7a4a',
      } : {
        background: 'transparent', fontSize: '14px',
        primaryColor: '#eef2fb', primaryTextColor: '#1f2633', primaryBorderColor: '#8fa3c8',
        secondaryColor: '#eaf5f1', secondaryBorderColor: '#7fb3a3', tertiaryColor: '#f3eefb', tertiaryBorderColor: '#a996cc',
        lineColor: '#7a8496', textColor: '#2a3140', clusterBkg: '#f7f8fb', clusterBorder: '#d5dbe6', edgeLabelBackground: '#ffffff',
      },
      flowchart: { htmlLabels: true, curve: 'basis', useMaxWidth: true, nodeSpacing: 36, rankSpacing: 40, padding: 10 },
      sequence: { mirrorActors: false, useMaxWidth: true },
    });
    configured = theme;
  }
  return mermaid;
};

const STEP = 60;

export default function Mermaid({ source, live = false }) {
  const id = 'mmd-' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fit, setFit] = useState(true);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
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
        const { svg: out } = await mermaid.render(`${id}-${n}`, text);
        if (!cancelled && n === seq.current) { setSvg(out); setError(''); }
      } catch (e) {
        document.getElementById(`d${id}-${n}`)?.remove();
        if (!cancelled && n === seq.current) setError(String(e?.message || e).split('\n')[0]);
      }
    }, live ? 350 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [source, live, id]);

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
    <figure className={`mermaid-block ${fit ? 'is-fit' : 'is-wide'}`}>
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
        <div className="mermaid-canvas" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
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
