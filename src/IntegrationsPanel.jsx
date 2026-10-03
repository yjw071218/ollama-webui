/* The account from outside the app: API keys for the OpenAI-compatible
 * endpoint (server/openaiCompat.js) and the Telegram bot (server/telegram.js).
 *
 * A key is shown exactly once, when it is made -- the server keeps only its
 * hash -- so the screen says so beside it, and offers the one thing anyone
 * does next: copy it, with the base URL and a working example. */
import React, { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, Send, Trash2 } from 'lucide-react';
import { api } from './session.jsx';
import { confirmDialog } from './ConfirmDialog.jsx';

const when = (ms) => (ms ? new Date(ms).toLocaleDateString() : '—');

export default function IntegrationsPanel({ user, t, toast, copyText }) {
  const [keys, setKeys] = useState([]);
  const [made, setMade] = useState(null);
  const [name, setName] = useState('');
  const [telegram, setTelegram] = useState(null);
  const [linkUrl, setLinkUrl] = useState('');

  const load = useCallback(async () => {
    if (!user) return;
    try { setKeys((await api('/api/auth/apikeys')).keys || []); } catch (e) { /* offline */ }
    try { setTelegram(await api('/api/auth/telegram')); } catch (e) { setTelegram(null); }
  }, [user]);
  useEffect(() => { load(); }, [load]);

  if (!user) {
    return (
      <div className="settings-group">
        <label>{t('integrations.title')}</label>
        <div className="setting-desc">{t('share.signInFirst')}</div>
      </div>
    );
  }

  const base = `${window.location.origin}/v1`;
  const copy = (text) => { copyText?.(text); toast?.(t('share.copied'), 'success'); };

  const create = async () => {
    try {
      const out = await api('/api/auth/apikeys', { method: 'POST', body: { name } });
      setMade(out.created);
      setKeys(out.keys || []);
      setName('');
    } catch (e) { toast?.(e.message, 'error'); }
  };
  const revoke = async (id) => {
    if (!(await confirmDialog(t('integrations.revokeConfirm'), { danger: true, confirmLabel: t('integrations.revoke') }))) return;
    try {
      const out = await api('/api/auth/apikeys', { method: 'POST', body: { revoke: id } });
      setKeys(out.keys || []);
      if (made?.id === id) setMade(null);
    } catch (e) { toast?.(e.message, 'error'); }
  };
  const link = async () => {
    try {
      const out = await api('/api/auth/telegram', { method: 'POST', body: { link: true } });
      setLinkUrl(out.url);
      window.open(out.url, '_blank', 'noopener');
    } catch (e) { toast?.(e.message, 'error', 8000); }
  };
  const unlinkChat = async (id) => {
    try {
      const out = await api('/api/auth/telegram', { method: 'POST', body: { unlink: id } });
      setTelegram(prev => ({ ...prev, links: out.links || [] }));
    } catch (e) { toast?.(e.message, 'error'); }
  };

  const example = made
    ? `curl ${base}/chat/completions \\\n  -H "Authorization: Bearer ${made.key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"","messages":[{"role":"user","content":"Hello"}]}'`
    : '';

  return (
    <>
      <div className="settings-group">
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}><KeyRound size={15} /> {t('integrations.apiTitle')}</label>
        <div className="setting-desc">{t('integrations.apiHelp')}</div>
        <div className="share-url-row" style={{ marginTop: '0.5rem' }}>
          <input type="text" className="settings-input" readOnly value={base} onFocus={e => e.target.select()} />
          <button className="icon-btn bordered" title={t('share.copy')} onClick={() => copy(base)}><Copy size={14} /></button>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
          <input className="settings-input" value={name} onChange={e => setName(e.target.value)}
            placeholder={t('integrations.keyName')} maxLength={60} />
          <button className="btn pull-btn" onClick={create}><KeyRound size={14} />{' '}{t('integrations.newKey')}</button>
        </div>

        {made && (
          <div style={{ marginTop: '0.6rem' }}>
            <div className="setting-desc" style={{ color: 'var(--warning, #d97706)' }}>{t('integrations.shownOnce')}</div>
            <div className="share-url-row">
              <input type="text" className="settings-input" readOnly value={made.key} onFocus={e => e.target.select()} />
              <button className="icon-btn bordered" title={t('share.copy')} onClick={() => copy(made.key)}><Copy size={14} /></button>
            </div>
            <textarea className="settings-textarea" readOnly rows={4} value={example}
              style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.72rem', marginTop: '0.4rem' }} />
          </div>
        )}

        {keys.length > 0 && (
          <div className="share-list" style={{ marginTop: '0.6rem' }}>
            {keys.map(k => (
              <div key={k.id} className="share-row">
                <div className="share-row-main">
                  <div className="share-row-title">{k.name} <code style={{ opacity: 0.7 }}>{k.prefix}…</code></div>
                  <div className="share-row-meta">
                    {t('integrations.keyMeta', { created: when(k.createdAt), used: when(k.lastUsedAt) })}
                  </div>
                </div>
                <button className="icon-btn" title={t('integrations.revoke')} onClick={() => revoke(k.id)}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-group">
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}><Send size={15} /> Telegram</label>
        <div className="setting-desc">{t('integrations.tgHelp')}</div>
        {!telegram?.configured ? (
          <div className="setting-desc" style={{ marginTop: '0.4rem' }}>{t('integrations.tgNotConfigured')}</div>
        ) : !telegram?.bot ? (
          <div className="setting-desc" style={{ marginTop: '0.4rem' }}>{t('integrations.tgNotRunning')}</div>
        ) : (
          <>
            <button className="btn pull-btn" style={{ marginTop: '0.5rem' }} onClick={link}>
              <Send size={14} />{' '}{t('integrations.tgLink', { bot: telegram.bot })}
            </button>
            {linkUrl && (
              <div className="share-url-row" style={{ marginTop: '0.4rem' }}>
                <input type="text" className="settings-input" readOnly value={linkUrl} onFocus={e => e.target.select()} />
                <button className="icon-btn bordered" title={t('share.copy')} onClick={() => copy(linkUrl)}><Copy size={14} /></button>
              </div>
            )}
          </>
        )}
        {(telegram?.links || []).length > 0 && (
          <div className="share-list" style={{ marginTop: '0.6rem' }}>
            {telegram.links.map(l => (
              <div key={l.tgChatId} className="share-row">
                <div className="share-row-main">
                  <div className="share-row-title">Telegram · {l.tgChatId}</div>
                  <div className="share-row-meta">{when(l.createdAt)}{l.model ? ` · ${l.model}` : ''}</div>
                </div>
                <button className="icon-btn" title={t('integrations.unlink')} onClick={() => unlinkChat(l.tgChatId)}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
