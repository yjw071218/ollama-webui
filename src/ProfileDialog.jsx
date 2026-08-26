import React, { useEffect, useRef, useState } from 'react';
import { X, Camera, Trash2, Check, RefreshCcw, TriangleAlert, Lock, LogOut, UserPlus } from 'lucide-react';
import { useI18n } from './i18n.jsx';
import { updateUser, changePassword, prepareAvatar } from './auth.jsx';

const PALETTE = ['#D97757', '#2563EB', '#059669', '#7C3AED', '#DB2777', '#D97706', '#0891B2', '#475569'];

/** Deterministic colour so a profile without a picture still looks like itself. */
export const avatarColor = (seed) => {
  const text = String(seed || '');
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
};

export const ProfileAvatar = ({ user, size = 40, className = '' }) => {
  const name = user?.name || '?';
  if (user?.avatar) {
    return <img className={`profile-avatar ${className}`} src={user.avatar} alt="" style={{ width: size, height: size }} />;
  }
  return (
    <div
      className={`profile-avatar ${className}`}
      style={{ width: size, height: size, background: avatarColor(user?.id || name), fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
};

export const ProfileDialog = ({ user, onClose, onUpdated, onSignOut, onSwitch, onDelete }) => {
  const { t } = useI18n();
  const fileRef = useRef(null);

  const [name, setName] = useState(user.name || '');
  const [email, setEmail] = useState(user.email || '');
  const [avatar, setAvatar] = useState(user.avatar || '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileSaved, setProfileSaved] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSaved, setPasswordSaved] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dirty = name !== (user.name || '') || email !== (user.email || '') || avatar !== (user.avatar || '');

  const pickAvatar = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setProfileError('');
    try {
      setAvatar(await prepareAvatar(file));
    } catch (err) {
      setProfileError(err.message || String(err));
    }
  };

  const saveProfile = async (e) => {
    e.preventDefault();
    setProfileError('');
    setProfileSaved(false);
    setSavingProfile(true);
    try {
      const result = await updateUser(user.id, { name, email, avatar });
      if (result.error) { setProfileError(t(result.error)); return; }
      onUpdated(result.user);
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2000);
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async (e) => {
    e.preventDefault();
    setPasswordError('');
    setPasswordSaved(false);
    if (nextPassword !== confirmPassword) { setPasswordError(t('auth.passwordMismatch')); return; }
    setSavingPassword(true);
    try {
      const result = await changePassword(user.id, currentPassword, nextPassword);
      if (result.error) { setPasswordError(t(result.error)); return; }
      setCurrentPassword('');
      setNextPassword('');
      setConfirmPassword('');
      setPasswordSaved(true);
      setTimeout(() => setPasswordSaved(false), 2500);
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal profile-dialog" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
          <h2 style={{ marginBottom: 0 }}>{t('auth.profile')}</h2>
          <button className="icon-btn" onClick={onClose} title={`${t('common.close')} (Esc)`}><X size={18} /></button>
        </div>

        <form onSubmit={saveProfile} className="settings-group">
          <div className="profile-identity">
            <div className="profile-avatar-edit">
              <ProfileAvatar user={{ ...user, name, avatar }} size={76} />
              <button
                type="button"
                className="profile-avatar-btn"
                onClick={() => fileRef.current?.click()}
                title={t('profile.changePhoto')}
              >
                <Camera size={14} />
              </button>
              <input ref={fileRef} type="file" accept="image/*" onChange={pickAvatar} style={{ display: 'none' }} />
            </div>

            <div className="profile-identity-fields">
              <label>{t('auth.name')}</label>
              <input
                type="text"
                className="settings-input"
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={60}
              />

              <label style={{ marginTop: '0.5rem' }}>{t('auth.email')}</label>
              <input
                type="email"
                className="settings-input"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder={user.provider === 'password' ? '' : t('profile.optional')}
              />

              {avatar && (
                <button type="button" className="profile-remove-photo" onClick={() => setAvatar('')}>
                  <Trash2 size={12} /> {t('profile.removePhoto')}
                </button>
              )}
            </div>
          </div>

          {profileError && <div className="auth-error"><TriangleAlert size={14} /> <span>{profileError}</span></div>}

          <div className="profile-actions">
            <span className="profile-provider-tag">{user.provider}</span>
            <div style={{ flex: 1 }} />
            <button type="submit" className="auth-submit profile-save" disabled={savingProfile || !dirty}>
              {savingProfile ? <RefreshCcw size={14} className="spin" /> : profileSaved ? <Check size={14} /> : null}
              {profileSaved ? t('profile.saved') : t('common.save')}
            </button>
          </div>
        </form>

        {user.provider === 'password' && (
          <form onSubmit={savePassword} className="settings-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Lock size={13} /> {t('profile.changePassword')}
            </label>

            <input
              type="password"
              className="settings-input"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              placeholder={t('profile.currentPassword')}
              autoComplete="current-password"
              style={{ marginBottom: '0.4rem' }}
            />
            <input
              type="password"
              className="settings-input"
              value={nextPassword}
              onChange={e => setNextPassword(e.target.value)}
              placeholder={t('profile.newPassword')}
              autoComplete="new-password"
              style={{ marginBottom: '0.4rem' }}
            />
            <input
              type="password"
              className="settings-input"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder={t('auth.confirmPassword')}
              autoComplete="new-password"
            />

            {passwordError && <div className="auth-error" style={{ marginTop: '0.5rem' }}><TriangleAlert size={14} /> <span>{passwordError}</span></div>}

            <div className="profile-actions" style={{ marginTop: '0.6rem' }}>
              <div style={{ flex: 1 }} />
              <button
                type="submit"
                className="auth-submit profile-save"
                disabled={savingPassword || !currentPassword || !nextPassword}
              >
                {savingPassword ? <RefreshCcw size={14} className="spin" /> : passwordSaved ? <Check size={14} /> : null}
                {passwordSaved ? t('profile.passwordChanged') : t('profile.changePassword')}
              </button>
            </div>
          </form>
        )}

        <div className="settings-group">
          <label>{t('profile.thisDevice')}</label>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button className="icon-btn bordered" onClick={onSwitch}>
              <UserPlus size={14} /> {t('auth.switchAccount')}
            </button>
            <button className="icon-btn bordered" onClick={onSignOut}>
              <LogOut size={14} /> {t('auth.signOut')}
            </button>
            <button className="icon-btn bordered" style={{ color: 'var(--danger)' }} onClick={onDelete}>
              <Trash2 size={14} /> {t('auth.deleteAccount')}
            </button>
          </div>
          <div className="auth-note" style={{ marginTop: '0.75rem' }}>{t('auth.localNote')}</div>
        </div>
      </div>
    </div>
  );
};
