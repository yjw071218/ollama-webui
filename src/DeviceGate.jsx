/**
 * New-device confirmation, on both ends.
 *
 *   DeviceWait       -- on the new device: approve this on a device that is
 *                       already signed in, re-checking until it is.
 *   DeviceApprovals  -- on every signed-in device: "was this you?".
 *
 * Both sit outside the i18n provider, so they translate for themselves.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { translate, detectLanguage } from './i18n.jsx';
import { Logo } from './Logo.jsx';

const say = (key, vars) => translate(detectLanguage(), key, vars);

export const DeviceWait = ({ info, onCheck, onCancel }) => {
  useEffect(() => {
    const now = () => { if (!document.hidden) onCheck(); };
    const timer = setInterval(now, 3000);
    document.addEventListener('visibilitychange', now);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', now); };
  }, [onCheck]);

  return (
    <div className="server-offline" role="alert" aria-live="polite">
      <div className="server-offline-card">
        <Logo size={48} spinning />
        <h1><ShieldCheck size={20} style={{ verticalAlign: '-3px' }} /> {say('device.waitTitle')}</h1>
        <p>{say('device.waitBody', { email: info?.email || info?.name || '' })}</p>
        <div className="server-offline-status">{say('device.waiting')}</div>
        <div className="server-offline-actions">
          <button type="button" className="secondary" onClick={onCancel}>{say('device.cancel')}</button>
        </div>
      </div>
    </div>
  );
};

const describe = (ua = '') => {
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS'
    : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : '';
  const app = /Electron/i.test(ua) || /; wv\)/.test(ua) ? 'App'
    : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [os, app].filter(Boolean).join(' · ') || ua.slice(0, 60) || '?';
};

export const DeviceApprovals = ({ api }) => {
  const [pending, setPending] = useState([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    if (document.hidden) return;
    try {
      const data = await api('/api/auth/devices/pending');
      setPending(Array.isArray(data?.pending) ? data.pending : []);
    } catch (e) { /* offline or an older server */ }
  }, [api]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 20000);
    window.addEventListener('webui:device-pending', load);
    document.addEventListener('visibilitychange', load);
    return () => {
      clearInterval(timer);
      window.removeEventListener('webui:device-pending', load);
      document.removeEventListener('visibilitychange', load);
    };
  }, [load]);

  const decide = async (approve) => {
    const first = pending[0];
    if (!first || busy) return;
    setBusy(true);
    try {
      const data = await api('/api/auth/devices/pending', { method: 'POST', body: { sessionId: first.id, approve } });
      setPending(Array.isArray(data?.pending) ? data.pending : []);
      setNote(say(approve ? 'device.approved' : 'device.denied'));
      setTimeout(() => setNote(''), 4000);
    } catch (e) {
      setPending(list => list.slice(1));
    } finally {
      setBusy(false);
    }
  };

  if (!pending.length) {
    return note ? <div className="connection-banner is-back" role="status">{note}</div> : null;
  }
  const first = pending[0];
  return (
    <div className="server-offline device-ask-overlay" role="alertdialog" aria-modal="true">
      <div className="server-offline-card device-ask-card">
        <ShieldAlert size={40} />
        <h1>{say('device.askTitle')}</h1>
        <p>{say('device.askBody')}</p>
        <p style={{ fontSize: '0.85rem', opacity: 0.8 }}>
          {describe(first.userAgent)}{first.ip ? ` · ${first.ip}` : ''}<br />
          {new Date(first.createdAt).toLocaleString()}
        </p>
        <div className="server-offline-actions">
          <button type="button" onClick={() => decide(true)} disabled={busy}>{say('device.approve')}</button>
          <button type="button" className="secondary" style={{ color: 'var(--danger, #d33)' }}
            onClick={() => decide(false)} disabled={busy}>
            {say('device.deny')}
          </button>
        </div>
      </div>
    </div>
  );
};
