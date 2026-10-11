import React, { useEffect, useRef, useState } from 'react';
import { loadPdfjs, PDF_ASSETS } from './rag.js';

// Render one page at a time: mobile WebViews need no built-in PDF plugin,
// and a long document never allocates hundreds of canvases.
export default function PdfReader({ src, title }) {
  const canvas = useRef(null);
  const container = useRef(null);
  const [width, setWidth] = useState(0);
  const [doc, setDoc] = useState(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    const element = container.current;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let stopped = false, task;
    setDoc(null); setPage(1); setError(''); setBusy(true);
    loadPdfjs().then(pdf => {
      if (stopped) return;
      task = pdf.getDocument({ url: src, ...PDF_ASSETS });
      return task.promise.then(value => { if (!stopped) setDoc(value); });
    }).catch(e => { if (!stopped) { setError(e.message); setBusy(false); } });
    return () => { stopped = true; task?.destroy()?.catch(() => {}); };
  }, [src]);
  useEffect(() => {
    if (!doc || !width) return;
    let stopped = false, render;
    setBusy(true); setError('');
    doc.getPage(page).then(async value => {
      if (stopped || !canvas.current) return;
      const element = canvas.current;
      const base = value.getViewport({ scale: 1 });
      const scale = Math.min(Math.max(1, width - 24) / base.width, 2) * Math.min(window.devicePixelRatio || 1, 2);
      const viewport = value.getViewport({ scale });
      element.width = Math.floor(viewport.width); element.height = Math.floor(viewport.height);
      element.style.width = `${viewport.width / Math.min(window.devicePixelRatio || 1, 2)}px`;
      render = value.render({ canvasContext: element.getContext('2d'), viewport });
      await render.promise;
      if (!stopped) setBusy(false);
    }).catch(e => { if (!stopped) { setError(e.message); setBusy(false); } });
    return () => { stopped = true; render?.cancel(); };
  }, [doc, page, width]);
  return <section ref={container} className="pdf-reader" aria-label={title}>
    <nav>
      <button disabled={!doc || page <= 1} onClick={() => setPage(p => p - 1)}>이전</button>
      <span>{page} / {doc?.numPages || '…'}</span>
      <button disabled={!doc || page >= doc.numPages} onClick={() => setPage(p => p + 1)}>다음</button>
      <a href={src} target="_blank" rel="noreferrer">원본 열기</a>
    </nav>
    {busy && <p role="status">PDF를 불러오는 중…</p>}
    {error && <p role="alert">PDF를 표시하지 못했습니다: {error}</p>}
    <canvas ref={canvas} aria-label={`${title} ${page}페이지`} />
  </section>;
}
