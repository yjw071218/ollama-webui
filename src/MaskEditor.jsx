/**
 * Paint over the part of a picture to change, and say what it should become.
 *
 * The region edit behind this is the one the model uses with `region="hair"`
 * -- only the marked area is redrawn and everything else is laid back exactly
 * -- but here the reader draws the area instead of naming it. That is the
 * difference between "the hair" and "this strand, and the ribbon beside it".
 *
 * The mask is built at the picture's own resolution, so it lines up with the
 * original pixel for pixel whatever size the picture is shown at. Two canvases
 * are painted together: the one on screen, in translucent red so the picture
 * stays visible under it, and a hidden one in white on black, which is the mask
 * that is sent.
 *
 * What to paint it into is written in the reader's own words and goes to the
 * chat, where the model turns it into a prompt the way it does for any edit --
 * a Korean sentence is not something a diffusion model reads.
 */
import { useEffect, useRef, useState } from 'react';
import { Brush, Eraser, Undo2, Trash2, X, Send } from 'lucide-react';

const HISTORY = 20;

export const MaskEditor = ({ picture, t, onCancel, onSubmit }) => {
  const shown = useRef(null);
  const mask = useRef(null);
  const [ready, setReady] = useState(false);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [brush, setBrush] = useState(6);          // percent of the picture's width
  const [erasing, setErasing] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [painted, setPainted] = useState(false);
  const history = useRef([]);
  const drawing = useRef(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      setSize({ width, height });
      for (const canvas of [shown.current, mask.current]) {
        canvas.width = width;
        canvas.height = height;
      }
      const m = mask.current.getContext('2d');
      m.fillStyle = '#000';
      m.fillRect(0, 0, width, height);
      setReady(true);
    };
    img.src = picture.dataUrl;
  }, [picture.dataUrl]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  /** Where a pointer is, in the picture's own pixels. */
  const at = (e) => {
    const box = shown.current.getBoundingClientRect();
    return {
      x: ((e.clientX - box.left) / box.width) * size.width,
      y: ((e.clientY - box.top) / box.height) * size.height,
    };
  };

  const snapshot = () => {
    const m = mask.current.getContext('2d');
    const s = shown.current.getContext('2d');
    history.current.push({
      mask: m.getImageData(0, 0, size.width, size.height),
      shown: s.getImageData(0, 0, size.width, size.height),
    });
    if (history.current.length > HISTORY) history.current.shift();
  };

  const stroke = (from, to) => {
    const radius = (brush / 100) * size.width / 2;
    const paint = (ctx, colour, erase) => {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = radius * 2;
      ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
      ctx.strokeStyle = colour;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x + 0.01, to.y);
      ctx.stroke();
      ctx.restore();
    };
    paint(shown.current.getContext('2d'), 'rgba(239, 68, 68, 1)', erasing);
    // The mask never erases to transparency: it is black where nothing changes.
    paint(mask.current.getContext('2d'), erasing ? '#000' : '#fff', false);
  };

  const down = (e) => {
    if (!ready) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    snapshot();
    const point = at(e);
    drawing.current = point;
    stroke(point, point);
    if (!erasing) setPainted(true);
  };
  const move = (e) => {
    if (!drawing.current) return;
    const point = at(e);
    stroke(drawing.current, point);
    drawing.current = point;
  };
  const up = () => { drawing.current = null; };

  const undo = () => {
    const last = history.current.pop();
    if (!last) return;
    mask.current.getContext('2d').putImageData(last.mask, 0, 0);
    shown.current.getContext('2d').putImageData(last.shown, 0, 0);
  };

  const clear = () => {
    snapshot();
    const m = mask.current.getContext('2d');
    m.fillStyle = '#000';
    m.fillRect(0, 0, size.width, size.height);
    shown.current.getContext('2d').clearRect(0, 0, size.width, size.height);
    setPainted(false);
  };

  const submit = () => {
    if (!painted || !instruction.trim()) return;
    onSubmit({ mask: mask.current.toDataURL('image/png'), instruction: instruction.trim() });
  };

  return (
    <div className="mask-editor-backdrop" role="dialog" aria-modal="true" aria-label={t('picture.paintTitle')}>
      <div className="mask-editor">
        <div className="mask-editor-head">
          <span className="mask-editor-title"><Brush size={15} /> {t('picture.paintTitle')}</span>
          <button type="button" className="icon-btn" onClick={onCancel} title={t('picture.cancel')}><X size={16} /></button>
        </div>
        <p className="mask-editor-hint">{t('picture.paintHint')}</p>

        <div className="mask-editor-stage">
          <div className="mask-editor-frame" style={{ aspectRatio: `${size.width} / ${size.height}` }}>
            <img src={picture.dataUrl} alt="" draggable={false} />
            <canvas
              ref={shown}
              className={`mask-editor-paint ${erasing ? 'is-erasing' : ''}`}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              onPointerLeave={up}
            />
            <canvas ref={mask} hidden />
          </div>
        </div>

        <div className="mask-editor-tools">
          <button type="button" className={`mask-tool ${!erasing ? 'is-on' : ''}`} onClick={() => setErasing(false)}>
            <Brush size={14} /> {t('picture.brush')}
          </button>
          <button type="button" className={`mask-tool ${erasing ? 'is-on' : ''}`} onClick={() => setErasing(true)}>
            <Eraser size={14} /> {t('picture.eraser')}
          </button>
          <label className="mask-size">
            <span>{t('picture.brushSize')}</span>
            <input type="range" min="1" max="20" value={brush} onChange={e => setBrush(Number(e.target.value))} />
          </label>
          <button type="button" className="mask-tool" onClick={undo} title={t('picture.undo')}><Undo2 size={14} /></button>
          <button type="button" className="mask-tool" onClick={clear} title={t('picture.clear')}><Trash2 size={14} /></button>
        </div>

        <div className="mask-editor-ask">
          <textarea
            value={instruction}
            onChange={e => setInstruction(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
            placeholder={t('picture.paintPlaceholder')}
            rows={2}
          />
          <button type="button" className="mask-send" onClick={submit} disabled={!painted || !instruction.trim()}>
            <Send size={15} /> {t('picture.paintSend')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default MaskEditor;
