import React, { useEffect, useRef, useState } from 'react';
import { FileText, Trash2, Upload, RefreshCcw, TriangleAlert, Check, X } from 'lucide-react';
import { useI18n } from './i18n.jsx';
import {
  extractDocument,
  chunkPages,
  embedTexts,
  normalise,
  isSupportedDocument,
  loadLibrary,
  addDocument,
  removeDocument,
  saveLibrary,
  DEFAULT_EMBED_MODEL,
} from './rag.js';

const formatBytes = (bytes) => {
  if (!bytes && bytes !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

// Embedding a large document in one request can time out; batch it.
const EMBED_BATCH = 32;

export const KnowledgePanel = ({ userId, models, embedModel, onEmbedModelChange, onLibraryChange }) => {
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
      if (!isSupportedDocument(file)) {
        setError(t('rag.unsupported', { name: file.name }));
        continue;
      }

      try {
        setBusy({ name: file.name, stage: 'extract', done: 0, total: 0 });
        const pages = await extractDocument(file, (done, total) => {
          setBusy({ name: file.name, stage: 'extract', done, total });
        });

        const chunks = chunkPages(pages);
        if (chunks.length === 0) {
          setError(t('rag.noText', { name: file.name }));
          setBusy(null);
          continue;
        }

        const vectors = [];
        for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
          setBusy({ name: file.name, stage: 'embed', done: i, total: chunks.length });
          const batch = chunks.slice(i, i + EMBED_BATCH).map(c => c.text);
          const embedded = await embedTexts(batch, embedModel);
          // Store normalised so retrieval is a dot product.
          embedded.forEach(v => vectors.push(normalise(v)));
        }

        const doc = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          size: file.size,
          pages: pages.length,
          addedAt: Date.now(),
          embedModel,
          enabled: true,
          chunks: chunks.map((c, i) => ({ page: c.page, text: c.text, vector: vectors[i] })),
        };

        publish(await addDocument(userId, doc));
      } catch (e) {
        setError(`${file.name}: ${e.message}`);
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
          accept=".pdf,.docx,.txt,.md,.markdown,.csv,.json,.log,.yaml,.yml,.xml,.html,.htm,.tsv"
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
                </div>
              </div>
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
