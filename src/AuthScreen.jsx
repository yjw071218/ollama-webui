import React, { useState, useEffect, useRef } from 'react';
import { Sparkles, Mail, Lock, User, TriangleAlert, RefreshCcw, KeyRound } from 'lucide-react';
import { useI18n } from './i18n.jsx';
import { socialConfig, renderGoogleButton, signInWithKakao } from './auth.jsx';
import { registerAccount, loginWithPassword, loginWithGoogle } from './session.jsx';
import { signInWithPasskey, isPasskeySupported, supportsAutofill } from './passkey.js';
import { ProfileAvatar } from './ProfileDialog.jsx';

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

// The server sends a code alongside the English message. Translating the code
// is what lets a Korean user read a Korean error; the message is the fallback
// for anything that has not been given a code yet.
const SERVER_ERRORS = {
  'bad-credentials': 'auth.invalidCredentials',
  'email-taken': 'auth.emailTaken',
  'weak-password': 'auth.passwordShort',
  'invalid-email': 'auth.invalidEmail',
  'name-required': 'auth.nameRequired',
  'wrong-password': 'auth.wrongCurrentPassword',
  throttled: 'auth.throttled',
  offline: 'auth.serverUnreachable',
  csrf: 'auth.staleRequest',
};

export const AuthScreen = ({ onSignedIn, onGuest, accounts = [], onUse }) => {
  const { t, lang } = useI18n();
  const [mode, setMode] = useState('signin'); // signin | signup
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const { googleClientId, kakaoRestKey } = socialConfig();

  const [passkeyReady, setPasskeyReady] = useState(false);
  const googleBtnRef = useRef(null);
  // Holds the pending conditional (autofill) passkey request, which has to be
  // abandoned before any other sign-in opens its own prompt.
  const abortRef = useRef(null);

  /** Server failures speak in codes; everything else already speaks in keys. */
  const report = (e) => {
    const key = SERVER_ERRORS[e?.code];
    setError(key ? t(key) : (e?.message || String(e)));
  };

  // Google's own button is the dependable entry point; One Tap is frequently
  // suppressed by cookie policy and used to surface as a bogus credential error.
  useEffect(() => {
    if (!googleClientId || !googleBtnRef.current) return undefined;
    let cancelled = false;

    renderGoogleButton(googleBtnRef.current, {
      locale: lang,
      onError: (result) => { if (!cancelled) setError(t(result.error)); },
      onCredential: async (credential) => {
        if (cancelled) return;
        setBusy('google');
        try {
          // The token is verified by the server against Google. Nothing here
          // reads it, because nothing here could tell a real one from a forgery.
          onSignedIn(await loginWithGoogle(credential));
        } catch (e) {
          report(e);
        } finally {
          if (!cancelled) setBusy('');
        }
      },
    }).then(outcome => {
      if (!cancelled && outcome?.error) setError(t(outcome.error));
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, googleClientId]);

  // Only offer the passkey button where the browser can actually use one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ready = isPasskeySupported();
      if (!cancelled) setPasskeyReady(ready);
      if (!ready) return;

      // Conditional mediation: the browser offers the passkey from the email
      // field itself, the way it offers a saved password, so there is nothing
      // to find and click. It is abandoned the moment another method is used.
      if (!(await supportsAutofill())) return;
      const controller = new AbortController();
      abortRef.current = controller;
      const result = await signInWithPasskey({ conditional: true, signal: controller.signal });
      if (cancelled || result.aborted) return;
      if (result.session) onSignedIn(result.session);
    })();
    return () => { cancelled = true; abortRef.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A pending autofill prompt has to go before another method opens its own,
  // or the browser refuses the second request outright.
  const stopAutofill = () => { abortRef.current?.abort(); abortRef.current = null; };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    stopAutofill();
    setBusy('password');
    try {
      if (mode === 'signup') {
        if (password !== confirm) { setError(t('auth.passwordMismatch')); return; }
        onSignedIn(await registerAccount(name, email, password), { created: true });
      } else {
        onSignedIn(await loginWithPassword(email, password));
      }
    } catch (err) {
      report(err);
    } finally {
      setBusy('');
    }
  };

  const passkey = async () => {
    setError('');
    stopAutofill();
    setBusy('passkey');
    try {
      const result = await signInWithPasskey();
      if (result.aborted) return;
      if (result.error) {
        setError(result.detail ? `${t(result.error)} — ${result.detail}` : t(result.error));
        return;
      }
      onSignedIn(result.session);
    } finally {
      setBusy('');
    }
  };

  const kakao = async () => {
    setError('');
    stopAutofill();
    setBusy('kakao');
    try {
      const result = await signInWithKakao();
      if (result.error) {
        const base = t(result.error, { uri: result.detail || '' });
        const detail = typeof result.detail === 'string' ? result.detail : '';
        setError(detail && !base.includes(detail) ? `${base} — ${detail}` : base);
        return;
      }
      // Kakao leaves for its consent screen and the page that returns is
      // already signed in, so there is no session to hand over here — and the
      // spinner should stay up until the navigation happens.
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      if (!window.location.href.includes('kauth.kakao.com')) setBusy('');
    }
  };

  const working = !!busy;

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="claude-logo-icon"><Sparkles size={16} color="var(--bg-primary)" /></div>
          <span>Ollama WebUI</span>
        </div>

        <h1>{mode === 'signin' ? t('auth.welcome') : t('auth.createAccount')}</h1>
        <p className="auth-subtitle">{t('auth.subtitle')}</p>

        {/* Accounts already signed in on this browser.
            This screen is reached by choosing to add an account, and the way
            back has to be here: while it is up, the profile menu — the other
            place a tab switches accounts — is not on screen. Picking one costs
            no sign-in, because the session never ended. */}
        {accounts.length > 0 && onUse && (
          <div className="auth-accounts">
            <div className="auth-accounts-label">{t('auth.otherAccounts')}</div>
            {accounts.map(account => (
              <button
                key={account.sessionId}
                type="button"
                className="auth-account"
                onClick={() => onUse(account.sessionId)}
                disabled={working}
              >
                <ProfileAvatar user={account.user} size={28} />
                <span className="auth-account-meta">
                  <span className="auth-account-name">{account.user.name}</span>
                  {account.user.email && <span className="auth-account-email">{account.user.email}</span>}
                </span>
              </button>
            ))}
            <div className="auth-hint">{t('auth.tabScoped')}</div>
          </div>
        )}

        <div className="auth-social">
          {passkeyReady && mode === 'signin' && (
            <>
              <button
                type="button"
                className="auth-social-btn passkey"
                onClick={passkey}
                disabled={working}
              >
                {busy === 'passkey' ? <RefreshCcw size={16} className="spin" /> : <KeyRound size={16} />}
                {t('auth.passkey')}
              </button>
              <div className="auth-hint passkey-pitch">{t('auth.passkeyPitch')}</div>
            </>
          )}

          {googleClientId ? (
            <div className="google-btn-host" ref={googleBtnRef} />
          ) : (
            <button type="button" className="auth-social-btn" disabled title={t('auth.notConfigured')}>
              <GoogleMark /> {t('auth.google')}
            </button>
          )}

          <button
            type="button"
            className="auth-social-btn kakao"
            onClick={kakao}
            disabled={working || !kakaoRestKey}
            title={kakaoRestKey ? undefined : t('auth.notConfigured')}
          >
            {busy === 'kakao' ? <RefreshCcw size={16} className="spin" /> : <KakaoMark />}
            {t('auth.kakao')}
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
                autoComplete="name"
                required
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
              // `webauthn` is what lets the browser offer a passkey from this
              // field alongside saved passwords.
              autoComplete={mode === 'signup' ? 'username' : 'username webauthn'}
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

          <button type="submit" className="auth-submit" disabled={working}>
            {busy === 'password' && <RefreshCcw size={14} className="spin" />}
            {mode === 'signin' ? t('auth.signIn') : t('auth.signUp')}
          </button>
        </form>

        <div className="auth-switch">
          {mode === 'signin' ? t('auth.noAccount') : t('auth.haveAccount')}{' '}
          <button type="button" onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); }}>
            {mode === 'signin' ? t('auth.signUp') : t('auth.signIn')}
          </button>
        </div>

        <button type="button" className="auth-guest" onClick={onGuest} disabled={working}>
          {t('auth.guest')}
        </button>

        <p className="auth-note">{t('auth.serverNote')}</p>
      </div>
    </div>
  );
};
