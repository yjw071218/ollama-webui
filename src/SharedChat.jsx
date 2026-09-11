/**
 * A published conversation, read by somebody with no account here.
 *
 * This component is deliberately the whole page rather than a mode of the app.
 * `App.jsx` mounts sync, storage, the model list, speech, the service worker
 * and a session — none of which a stranger following a link should be starting,
 * and one of which would try to fork them a session. What a shared link needs
 * is a transcript and a way back, so that is all this renders.
 *
 * It is mounted before `SessionProvider` for the same reason: opening a link
 * must not depend on being signed in, and must not tell the server who opened
 * it.
 */
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import { RefreshCcw, Sparkles, Link2Off, MessageSquare } from 'lucide-react';
import { fetchShare } from './shareLink.js';
import { useI18n } from './i18n.jsx';

const Bubble = ({ message }) => (
  <div className={`message-row ${message.role}`}>
    {message.role === 'assistant' && (
      <div className="message-avatar assistant-avatar"><Sparkles size={16} /></div>
    )}
    <div className="message-content">
      {message.images?.length > 0 && (
        <div className="user-attachments-grid" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
          {message.images.map((img, i) => (
            <img
              key={i}
              src={`data:image/jpeg;base64,${img}`}
              alt=""
              style={{ maxWidth: '260px', borderRadius: '8px', border: '1px solid var(--border-color)' }}
            />
          ))}
        </div>
      )}
      {message.role === 'assistant' ? (
        <div className="markdown-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex, rehypeHighlight]}
          >
            {message.content}
          </ReactMarkdown>
        </div>
      ) : (
        <div className="user-text"><div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div></div>
      )}
      {message.model && (
        <div className="claude-metrics"><span>{message.model}</span></div>
      )}
    </div>
  </div>
);

export const SharedChat = ({ token }) => {
  const { t, lang } = useI18n();
  const [state, setState] = useState('loading');
  const [share, setShare] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchShare(token, controller.signal)
      .then(found => {
        if (controller.signal.aborted) return;
        // One outcome for every way a link can fail, because the server gives
        // one answer for all of them on purpose -- see server/shares.js.
        if (!found) { setState('gone'); return; }
        setShare(found);
        setState('ready');
      })
      .catch(() => { if (!controller.signal.aborted) setState('gone'); });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (share?.title) document.title = share.title;
  }, [share]);

  if (state === 'loading') {
    return (
      <div className="auth-screen">
        <div className="auth-card" style={{ textAlign: 'center', padding: '2.5rem' }}>
          <RefreshCcw size={22} className="spin" />
        </div>
      </div>
    );
  }

  if (state === 'gone') {
    return (
      <div className="auth-screen">
        <div className="auth-card" style={{ textAlign: 'center', padding: '2.5rem', maxWidth: '28rem' }}>
          <Link2Off size={28} style={{ opacity: 0.6 }} />
          <h2 style={{ marginTop: '1rem' }}>{t('share.gone')}</h2>
          <p style={{ opacity: 0.75, lineHeight: 1.6 }}>{t('share.goneHelp')}</p>
        </div>
      </div>
    );
  }

  const when = new Date(share.sharedAt);

  return (
    <div className="shared-page">
      <header className="shared-header">
        <div className="shared-header-inner">
          <MessageSquare size={16} />
          <h1>{share.title || t('share.untitled')}</h1>
          <span className="shared-when">
            {t('share.sharedOn', {
              date: when.toLocaleDateString(lang, { year: 'numeric', month: 'long', day: 'numeric' }),
            })}
          </span>
        </div>
      </header>

      <main className="shared-main">
        {share.messages.map((message, i) => <Bubble key={i} message={message} />)}
      </main>

      {/* Said plainly rather than implied by the missing composer: a reader
          who does not know this app cannot tell a read-only page from one
          that is merely still loading. */}
      <footer className="shared-footer">
        <p>{t('share.readOnly')}</p>
        {share.expiresAt && (
          <p>{t('share.expiresOn', {
            date: new Date(share.expiresAt).toLocaleDateString(lang, {
              year: 'numeric', month: 'long', day: 'numeric',
            }),
          })}</p>
        )}
      </footer>
    </div>
  );
};

export default SharedChat;
