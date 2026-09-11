import React, { useCallback, useEffect, useState } from 'react';
import {
  KeyRound, Trash2, RefreshCcw, LogOut, Monitor, Check, TriangleAlert, Plus,
} from 'lucide-react';
import { useI18n } from './i18n.jsx';
import { relativeTime } from './relativeTime.js';
import { listSessions, changePassword } from './session.jsx';
import { addPasskey, listPasskeys, removePasskey, isPasskeySupported } from './passkey.js';

/**
 * The account's security settings: passkeys, other devices, password.
 *
 * These exist because the server can now answer for them. A passkey list means
 * something when the keys are registered against an account rather than against
 * one browser's IndexedDB; a session list means something when sessions are
 * server-side records that can actually be revoked. Before this rework neither
 * was true, so neither was shown.
 */
export const SecurityPanel = ({ user, onUserChanged, toast }) => {
  const { t, lang } = useI18n();

  const [passkeys, setPasskeys] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [keys, devices] = await Promise.all([listPasskeys(), listSessions()]);
      setPasskeys(keys.passkeys || []);
      setSessions(devices.sessions || []);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const add = async () => {
    setError('');
    setBusy('passkey');
    try {
      const result = await addPasskey({ label: navigator.platform || '' });
      if (result.error) {
        setError(result.detail ? `${t(result.error)} — ${result.detail}` : t(result.error));
        return;
      }
      onUserChanged?.(result.user);
      setPasskeys(result.passkeys || []);
      toast?.(t('security.passkeyAdded'), 'success');
    } finally {
      setBusy('');
    }
  };

  const remove = async (id) => {
    setError('');
    setBusy(`remove-${id}`);
    try {
      const result = await removePasskey(id);
      onUserChanged?.(result.user);
      setPasskeys(result.passkeys || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  const savePassword = async (e) => {
    e.preventDefault();
    setError('');
    if (nextPassword !== confirmPassword) { setError(t('auth.passwordMismatch')); return; }
    setBusy('password');
    try {
      const result = await changePassword(currentPassword, nextPassword);
      onUserChanged?.(result.user);
      setCurrentPassword(''); setNextPassword(''); setConfirmPassword('');
      // Every other session was ended by the change. Saying so is the point:
      // that is what makes changing a password worth doing.
      toast?.(t('security.passwordChanged', { count: result.endedSessions || 0 }), 'success', 8000);
      refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <div className="settings-group">
        <label>{t('security.passkeys')}</label>
        <div className="setting-help" style={{ marginBottom: '0.6rem' }}>{t('security.passkeysHelp')}</div>

        {passkeys.length === 0 && (
          <div className="auth-note" style={{ margin: '0 0 0.6rem' }}>{t('security.noPasskeys')}</div>
        )}

        {passkeys.map(key => (
          <div className="account-card" key={key.id} style={{ marginBottom: '0.4rem' }}>
            <div className="account-avatar"><KeyRound size={16} /></div>
            <div className="account-meta">
              <div className="account-name">{key.label || t('security.passkey')}</div>
              <div className="account-email">
                {key.lastUsedAt
                  ? t('security.lastUsed', { when: relativeTime(key.lastUsedAt, lang) })
                  : t('security.neverUsed')}
              </div>
            </div>
            <button
              className="icon-btn bordered"
              style={{ color: 'var(--danger)' }}
              disabled={busy === `remove-${key.id}`}
              onClick={() => remove(key.id)}
              title={t('security.removePasskey')}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}

        {isPasskeySupported() ? (
          <button className="icon-btn bordered" disabled={!!busy} onClick={add} style={{ marginTop: '0.4rem' }}>
            {busy === 'passkey' ? <RefreshCcw size={14} className="spin" /> : <Plus size={14} />}
            {t('security.addPasskey')}
          </button>
        ) : (
          <div className="setting-help">{t('auth.passkeyUnsupported')}</div>
        )}
      </div>

      <div className="settings-group">
        <label>{t('security.devices')}</label>
        <div className="setting-help" style={{ marginBottom: '0.6rem' }}>{t('security.devicesHelp')}</div>

        {sessions.map(entry => (
          <div className="account-card" key={entry.id} style={{ marginBottom: '0.4rem' }}>
            <div className="account-avatar">
              {entry.current ? <Check size={16} /> : <Monitor size={16} />}
            </div>
            <div className="account-meta">
              <div className="account-name">
                {entry.current ? t('security.thisDevice') : (entry.ip || t('security.otherDevice'))}
              </div>
              <div className="account-email" style={{ wordBreak: 'break-all' }}>
                {entry.userAgent || '—'}
              </div>
              <div className="account-provider">
                {t('security.lastSeen', { when: relativeTime(entry.lastSeenAt, lang) })}
              </div>
            </div>
          </div>
        ))}
      </div>

      {user?.hasPassword && (
        <div className="settings-group">
          <label>{t('security.password')}</label>
          <div className="setting-help" style={{ marginBottom: '0.6rem' }}>{t('security.passwordHelp')}</div>
          <form onSubmit={savePassword}>
            <input
              type="password"
              className="settings-input"
              style={{ marginBottom: '0.4rem' }}
              placeholder={t('profile.currentPassword')}
              autoComplete="current-password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              required
            />
            <input
              type="password"
              className="settings-input"
              style={{ marginBottom: '0.4rem' }}
              placeholder={t('profile.newPassword')}
              autoComplete="new-password"
              value={nextPassword}
              onChange={e => setNextPassword(e.target.value)}
              required
            />
            <input
              type="password"
              className="settings-input"
              style={{ marginBottom: '0.5rem' }}
              placeholder={t('auth.confirmPassword')}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              required
            />
            <button className="auth-submit profile-save" disabled={busy === 'password'} type="submit">
              {busy === 'password' && <RefreshCcw size={14} className="spin" />}
              {t('profile.changePassword')}
            </button>
          </form>
        </div>
      )}

      {error && (
        <div className="auth-error" style={{ marginTop: '0.5rem' }}>
          <TriangleAlert size={14} /> <span>{error}</span>
        </div>
      )}
    </>
  );
};

/** The button that ends every session but this one. Kept separate so the
 *  account panel can place it beside the other account-wide actions. */
export const SignOutOthersButton = ({ onClick, busy }) => {
  const { t } = useI18n();
  return (
    <button className="icon-btn bordered" disabled={busy} onClick={onClick}>
      {busy ? <RefreshCcw size={14} className="spin" /> : <LogOut size={14} />}
      {t('security.signOutOthers')}
    </button>
  );
};
