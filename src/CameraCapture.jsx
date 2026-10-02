/* A live camera view with one button: take the picture.
 *
 * The screen has a system picker that frames the shot for you; a camera does
 * not, and a photo taken blind is of the ceiling. So this shows the view first.
 * The camera is released the moment the dialog closes, whichever way. */
import React, { useEffect, useRef, useState } from 'react';
import { Camera, RefreshCcw, X } from 'lucide-react';
import { frameToFile, cameraFileName } from './capture.js';

export default function CameraCapture({ open, onClose, onCapture, t }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [facing, setFacing] = useState('environment');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setReady(false);
    setError('');
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    }).then((stream) => {
      if (cancelled) { stream.getTracks().forEach(tr => tr.stop()); return; }
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.play().then(() => setReady(true)).catch(() => setReady(true));
      }
    }).catch((e) => setError(e?.message || String(e)));
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach(tr => tr.stop());
      streamRef.current = null;
    };
  }, [open, facing]);

  if (!open) return null;

  const take = async () => {
    try {
      onCapture(await frameToFile(videoRef.current, cameraFileName()));
      onClose();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="settings-overlay" data-state="open" onClick={onClose}>
      <div className="settings-modal" role="dialog" aria-modal="true" aria-label={t('capture.camera')}
        style={{ maxWidth: 720, width: '94vw' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ marginBottom: 0 }}>{t('capture.camera')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('capture.close')}><X size={18} /></button>
        </div>
        {error ? (
          <div className="setting-desc" style={{ padding: '1rem' }}>{t('capture.cameraFailed', { error })}</div>
        ) : (
          <video
            ref={videoRef}
            muted
            playsInline
            style={{ width: '100%', maxHeight: '65vh', background: '#000', borderRadius: 8, objectFit: 'contain' }}
          />
        )}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          <button className="btn" onClick={() => setFacing(f => (f === 'environment' ? 'user' : 'environment'))}
            title={t('capture.flip')}>
            <RefreshCcw size={14} />{' '}{t('capture.flip')}
          </button>
          <button className="btn pull-btn" disabled={!ready || !!error} onClick={take}>
            <Camera size={14} />{' '}{t('capture.take')}
          </button>
        </div>
      </div>
    </div>
  );
}
