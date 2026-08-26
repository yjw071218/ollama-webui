import React, { useState, useEffect, useRef } from 'react';
import { Sparkles, Mail, Lock, User, TriangleAlert, RefreshCcw, KeyRound } from 'lucide-react';
import { useI18n } from './i18n.jsx';
import {
  registerWithPassword,
  signInWithPassword,
  signInWithGoogle,
  signInWithKakao,
  socialConfig,
  registerPasskey,
  signInWithPasskey,
  isPasskeySupported,
  hasPlatformAuthenticator,
  renderGoogleButton,
} from './auth.jsx';

const GoogleMark = () => (
  <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.4 5.4 2.5 13.2l7.8 6.1C12.2 13.3 17.6 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.2-.4-4.7H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 7.1-10 7.1-17.3z" />
    <path fill="#FBBC05" d="M10.3 28.7a14.6 14.6 0 010-9.4l-7.8-6.1a24 24 0 000 21.6l7.8-6.1z" />
    <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.4 0-11.8-3.8-13.7-9.1l-7.8 6.1C6.4 42.6 14.6 48 24 48z" />
  </svg>
);

const KakaoMark = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#191600" d="M12 3C6.9 3 2.8 6.3 2.8 10.3c0 2.6 1.7 4.9 4.3 6.2-.2.7-.7 2.6-.8 3-.1.5.2.5.4.4.2-.1 2.7-1.8 3.7-2.6.5.1 1.1.1 1.6.1 5.1 0 9.2-3.3 9.2-7.3S17.1 3 12 3z" />
  </svg>
);

export const AuthScreen = ({ onAuthenticated, onGuest }) => {
  const { t, lang } = useI18n();
  const [mode, setMode] = useState('signin'); // signin | signup
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const { googleClientId, kakaoRestKey } = socialConfig();

  const [passkeyReady, setPasskeyReady] = useState(false);
  const googleBtnRef = useRef(null);

  // Google's own button is the dependable entry point; One Tap is frequently
  // suppressed by cookie policy and used to surface as a bogus credential error.
  useEffect(() => {
    if (!googleClientId || !googleBtnRef.current) return;
    let cancelled = false;
    renderGoogleButton(googleBtnRef.current, {
      locale: lang,
      onResult: (result) => {
        if (cancelled) return;
        if (result?.error) {
          setError(result.detail ? `${t(result.error)} (${result.detail})` : t(result.error));
          return;
        }
        if (result?.user) onAuthenticated(result.user);
      },
    }).then(outcome => {
      if (!cancelled && outcome?.error) setError(t(outcome.error));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  // Only offer the passkey button where the device can actually make one.
  useEffect(() => {
    let cancelled = false;
    hasPlatformAuthenticator().then(available => {
      if (!cancelled) setPasskeyReady(isPasskeySupported() && available);
    });
    return () => { cancelled = true; };
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'signup') {
        if (password !== confirm) { setError(t('auth.passwordMismatch')); return; }
        const result = await registerWithPassword({ email, password, name });
        if (result.error) { setError(t(result.error)); return; }
        onAuthenticated(result.user, { created: true });
      } else {
        const result = await signInWithPassword({ email, password });
        if (result.error) { setError(t(result.error)); return; }
        onAuthenticated(result.user);
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const passkey = async () => {
    setError('');
    setBusy(true);
    try {
      // Signing up creates the credential; signing in offers the ones already here.
      const result = mode === 'signup'
        ? await registerPasskey({ name })
        : await signInWithPasskey();

      if (result.error) {
        // "no passkey yet" on the sign-in tab is a nudge, not a dead end.
        if (result.error === 'auth.passkeyNone') {
          setMode('signup');
          setError(t('auth.passkeyNone'));
          return;
        }
        setError(result.detail ? `${t(result.error)} (${result.detail})` : t(result.error));
        return;
      }
      onAuthenticated(result.user, { created: mode === 'signup' });
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const social = async (provider) => {
    setError('');
    setBusy(true);
    try {
      const result = provider === 'google' ? await signInWithGoogle() : await signInWithKakao();
      if (result.error) {
        // Some messages interpolate the detail themselves; otherwise append it,
        // because the provider's own text is what actually identifies the fault.
        const base = t(result.error, { uri: result.detail || '' });
        const detail = typeof result.detail === 'string' ? result.detail : '';
        setError(detail && !base.includes(detail) ? `${base} — ${detail}` : base);
        console.error(`[${provider}]`, result.error, result.detail);
        return;
      }
      onAuthenticated(result.user);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="claude-logo-icon"><Sparkles size={16} color="var(--bg-primary)" /></div>
          <span>Ollama WebUI</span>
        </div>

        <h1>{mode === 'signin' ? t('auth.welcome') : t('auth.createAccount')}</h1>
        <p className="auth-subtitle">{t('auth.subtitle')}</p>

        <div className="auth-social">
          {passkeyReady && (
            <>
              <button
                type="button"
                className="auth-social-btn passkey"
                onClick={passkey}
                disabled={busy}
              >
                <KeyRound size={16} /> {mode === 'signup' ? t('auth.passkeyCreate') : t('auth.passkey')}
              </button>
              <div className="auth-hint passkey-pitch">{t('auth.passkeyPitch')}</div>
            </>
          )}

          {googleClientId ? (
            <div className="google-btn-host" ref={googleBtnRef} />
          ) : (
            <button
              type="button"
              className="auth-social-btn"
              disabled
              title={t('auth.notConfigured')}
            >
              <GoogleMark /> {t('auth.google')}
            </button>
          )}
          <button
            type="button"
            className="auth-social-btn kakao"
            onClick={() => social('kakao')}
            disabled={busy || !kakaoRestKey}
            title={kakaoRestKey ? undefined : t('auth.notConfigured')}
          >
            <KakaoMark /> {t('auth.kakao')}
          </button>
          {(!googleClientId || !kakaoRestKey) && (
            <div className="auth-hint">{t('auth.notConfigured')}</div>
          )}
        </div>

        <div className="auth-divider"><span>{t('auth.or')}</span></div>

        <form onSubmit={submit} className="auth-form">
          {mode === 'signup' && (
            <label className="auth-field">
              <User size={15} />
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('auth.name')}
                autoComplete="nickname"
              />
            </label>
          )}

          <label className="auth-field">
            <Mail size={15} />
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder={t('auth.email')}
              autoComplete="username"
              required
            />
          </label>

          <label className="auth-field">
            <Lock size={15} />
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={t('auth.password')}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
            />
          </label>

          {mode === 'signup' && (
            <label className="auth-field">
              <Lock size={15} />
              <input
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder={t('auth.confirmPassword')}
                autoComplete="new-password"
                required
              />
            </label>
          )}

          {error && (
            <div className="auth-error">
              <TriangleAlert size={14} />
              <span>
                {error}
                {/(invalid_client|origin|401)/i.test(error) && (
                  <div className="auth-error-hint">{t('auth.originHint', { origin: window.location.origin })}</div>
                )}
                {/(KOE|Redirect URI|Kakao)/i.test(error) && (
                  <div className="auth-error-hint">{t('auth.kakaoChecklist')}</div>
                )}
              </span>
            </div>
          )}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy && <RefreshCcw size={14} className="spin" />}
            {mode === 'signin' ? t('auth.signIn') : t('auth.signUp')}
          </button>
        </form>

        <div className="auth-switch">
          {mode === 'signin' ? t('auth.noAccount') : t('auth.haveAccount')}{' '}
          <button type="button" onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); }}>
            {mode === 'signin' ? t('auth.signUp') : t('auth.signIn')}
          </button>
        </div>

        <button type="button" className="auth-guest" onClick={onGuest}>
          {t('auth.guest')}
        </button>

        <p className="auth-note">{t('auth.localNote')}</p>
      </div>
    </div>
  );
};
