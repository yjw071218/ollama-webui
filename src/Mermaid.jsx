import React, { useEffect, useId, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, RotateCcw, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Copy, Check, MoveHorizontal, Code } from 'lucide-react';
import { copyText } from './clipboard.js';

/* A fenced ```mermaid block drawn as a diagram: flowcharts, sequence
 * diagrams, timelines, mind maps, state and ER diagrams, pie and quadrant
 * charts. The library is large (~1 MB), so it is loaded the first time a
 * diagram appears and never for a chat that has none.
 *
 * While an answer streams the block is half written and does not parse; the
 * source is shown until it does, and a failed parse never replaces a diagram
 * that already rendered -- it keeps the last good one. */

let loading = null;
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
      startOnLoad: false, theme, securityLevel: 'strict',
      fontFamily: 'Pretendard, "Noto Sans KR", system-ui, sans-serif',
      flowchart: { htmlLabels: true, curve: 'basis' },
      sequence: { mirrorActors: true },
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

  useEffect(() => {
    let cancelled = false;
    const n = ++seq.current;
    const text = String(source || '').trim();
    if (!text) return undefined;
    // Streaming: wait for a pause so a growing block is not parsed per token.
    const timer = setTimeout(async () => {
      try {
        const mermaid = await ready();
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
  const zoom = (f) => setView(v => ({ ...v, scale: Math.min(6, Math.max(0.25, v.scale * f)) }));
  const reset = () => setView({ scale: 1, x: 0, y: 0 });
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
        className="mermaid-stage"
        onWheel={(e) => { if (!e.ctrlKey) return; e.preventDefault(); zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1); }}
        onPointerDown={(e) => { if (e.button !== 0 || e.target.closest('button')) return; drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { if (!drag.current) return; move(e.clientX - drag.current.x, e.clientY - drag.current.y); drag.current = { x: e.clientX, y: e.clientY }; }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onDoubleClick={reset}
      >
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
