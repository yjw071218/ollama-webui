import React, { useEffect, useRef, useState } from 'react';
import { FileText, Trash2, Upload, RefreshCcw, TriangleAlert, Check, X, Globe } from 'lucide-react';
import { useI18n } from './i18n.jsx';
import {
  loadLibrary,
  removeDocument,
  saveLibrary,
  DEFAULT_EMBED_MODEL,
} from './rag.js';
import { ingestDocument } from './ingest.js';

const formatBytes = (bytes) => {
  if (!bytes && bytes !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

export const KnowledgePanel = ({ userId, models, embedModel, onEmbedModelChange, onLibraryChange, chats, folders }) => {
  const { t } = useI18n();
  const fileRef = useRef(null);
  const [docs, setDocs] = useState([]);
  const [busy, setBusy] = useState(null);   // { name, stage, done, total }
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadLibrary(userId).then(list => { if (!cancelled) setDocs(list); });
    return () => { cancelled = true; };
  }, [userId]);

  const publish = (next) => {
    setDocs(next);
    onLibraryChange?.(next);
  };

  const ingest = async (files) => {
    setError('');
    for (const file of files) {
      try {
        // The same routine the composer uses when an attachment is too long to
        // send whole -- see src/ingest.js. One copy, so a document embedded
        // from here and one embedded from there are the same thing.
        const { library } = await ingestDocument(file, {
          userId,
          embedModel,
          onProgress: ({ stage, done, total }) => setBusy({ name: file.name, stage, done, total }),
        });
        publish(library);
      } catch (e) {
        if (e.code === 'binary') setError(t('rag.unsupported', { name: file.name }));
        else if (e.code === 'no-text') setError(t('rag.noText', { name: file.name }));
        else setError(`${file.name}: ${e.message}`);
      } finally {
        setBusy(null);
      }
    }
  };

  const toggle = async (id) => {
    const next = docs.map(d => (d.id === id ? { ...d, enabled: d.enabled === false } : d));
    await saveLibrary(userId, next);
    publish(next);
  };

  const remove = async (id) => {
    publish(await removeDocument(userId, id));
  };

  /**
   * Promote a document to the shared library.
   *
   * A file attached to a chat belongs to that chat, which is right by default
   * and wrong the moment you realise the manual you dropped into one
   * conversation is the manual you want in all of them. Dropping the owner is
   * the whole operation; there is nothing to re-embed.
   */
  const share = async (id) => {
    const next = docs.map(d => {
      if (d.id !== id) return d;
      const { chatId, folderId, ...rest } = d;
      return rest;
    });
    await saveLibrary(userId, next);
    publish(next);
  };

  // A document says which chat it came from, and a chat id is not a name.
  const chatName = (id) => {
    const found = (chats || []).find(c => String(c.id) === String(id));
    return found ? (found.title || t('rag.scopeGoneChat')) : t('rag.scopeGoneChat');
  };
  const folderName = (id) => {
    const found = (folders || []).find(f => String(f.id) === String(id));
    return found ? found.name : t('rag.scopeGoneFolder');
  };

  const totalChunks = docs.reduce((sum, d) => sum + (d.chunks?.length || 0), 0);
  const embedCandidates = models.filter(m => /embed|bge|gte|minilm|e5/i.test(m.name));

  return (
    <>
      <div className="settings-group">
        <label>{t('rag.embedModel')}</label>
        <select className="settings-input" value={embedModel} onChange={e => onEmbedModelChange(e.target.value)}>
          {embedCandidates.length === 0 && <option value={embedModel}>{embedModel}</option>}
          {embedCandidates.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
        </select>
        {embedCandidates.length === 0 && (
          <div className="setup-why" style={{ marginTop: '0.5rem' }}>
            {t('rag.noEmbedModel')}
            <code style={{ display: 'block', marginTop: '0.4rem' }}>ollama pull {DEFAULT_EMBED_MODEL}</code>
          </div>
        )}
      </div>

      <div className="settings-group">
        <label>{t('rag.documents')} ({docs.length}{totalChunks ? ` · ${t('rag.chunks', { count: totalChunks })}` : ''})</label>

        <input
          ref={fileRef}
          type="file"
          multiple
          /* No filter: what a file is, is decided by reading it. See
             `sniffKind` in rag.js. */
          style={{ display: 'none' }}
          onChange={e => { ingest(Array.from(e.target.files)); e.target.value = ''; }}
        />

        <button className="icon-btn bordered" onClick={() => fileRef.current?.click()} disabled={!!busy}>
          <Upload size={14} /> {t('rag.add')}
        </button>

        {busy && (
          <div className="rag-progress">
            <RefreshCcw size={13} className="spin" />
            <span>
              {busy.stage === 'extract' ? t('rag.extracting', { name: busy.name }) : t('rag.embedding', { name: busy.name })}
              {busy.total ? ` ${busy.done}/${busy.total}` : ''}
            </span>
          </div>
        )}

        {error && (
          <div className="auth-error" style={{ marginTop: '0.5rem' }}>
            <TriangleAlert size={14} />
            <span>{error}</span>
            <button className="icon-btn" onClick={() => setError('')}><X size={13} /></button>
          </div>
        )}

        <div className="rag-list">
          {docs.length === 0 && !busy && (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{t('rag.empty')}</div>
          )}
          {docs.map(doc => (
            <div className={`rag-item ${doc.enabled === false ? 'is-off' : ''}`} key={doc.id}>
              <FileText size={14} />
              <div className="rag-item-meta">
                <div className="rag-item-name">{doc.name}</div>
                <div className="rag-item-detail">
                  {formatBytes(doc.size)} · {t('rag.chunks', { count: doc.chunks?.length || 0 })}
                  {doc.pages > 1 ? ` · ${t('rag.pages', { count: doc.pages })}` : ''}
                  {/* Where a document may be used. Without this the library is
                      a flat pile and there is no way to tell a manual meant
                      for every chat from an invoice that arrived in one. */}
                  {doc.chatId && <span className="rag-scope">{chatName(doc.chatId)}</span>}
                  {doc.folderId && <span className="rag-scope">{folderName(doc.folderId)}</span>}
                  {!doc.chatId && !doc.folderId && <span className="rag-scope shared">{t('rag.scopeShared')}</span>}
                </div>
              </div>
              {(doc.chatId || doc.folderId) && (
                <button
                  className="icon-btn"
                  title={t('rag.share')}
                  onClick={() => share(doc.id)}
                >
                  <Globe size={14} />
                </button>
              )}
              <button
                className={`icon-btn ${doc.enabled === false ? '' : 'toggled'}`}
                title={doc.enabled === false ? t('rag.enable') : t('rag.disable')}
                onClick={() => toggle(doc.id)}
              >
                <Check size={14} />
              </button>
              <button className="icon-btn" style={{ color: 'var(--danger)' }} onClick={() => remove(doc.id)}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>

        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.6rem' }}>
          {t('rag.help')}
        </div>
      </div>
    </>
  );
};
