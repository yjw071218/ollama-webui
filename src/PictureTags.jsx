/**
 * A picture's danbooru tags, read by WD14, to copy or to draw from.
 *
 * The tagger's vocabulary is the one Anima was trained on, so what it reads
 * off a picture is the most direct prompt there is for another like it. Each
 * tag can be dropped individually before the list is used -- a tagger reads
 * what is there, including the parts somebody wants gone.
 */
import { useEffect, useState } from 'react';
import { Tags, X, Copy, CornerDownLeft, RefreshCcw, Check } from 'lucide-react';

export const PictureTags = ({ state, t, onClose, onUse, onCopy }) => {
  const [dropped, setDropped] = useState(() => new Set());
  const [copied, setCopied] = useState(false);
  const tags = (state?.tags || '').split(',').map(s => s.trim()).filter(Boolean);
  const kept = tags.filter(tag => !dropped.has(tag));

  useEffect(() => { setDropped(new Set()); }, [state?.tags]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (tag) => setDropped(prev => {
    const next = new Set(prev);
    if (next.has(tag)) next.delete(tag); else next.add(tag);
    return next;
  });

  return (
    <div className="picture-tags-backdrop" role="dialog" aria-modal="true" aria-label={t('picture.tagsTitle')} onClick={onClose}>
      <div className="picture-tags" onClick={e => e.stopPropagation()}>
        <div className="mask-editor-head">
          <span className="mask-editor-title"><Tags size={15} /> {t('picture.tagsTitle')}</span>
          <button type="button" className="icon-btn" onClick={onClose} title={t('picture.cancel')}><X size={16} /></button>
        </div>
        {state?.loading && (
          <div className="picture-tags-wait"><RefreshCcw size={15} className="spin" /> {t('picture.tagsReading')}</div>
        )}
        {state?.error && <div className="picture-tags-error">{state.error}</div>}
        {!state?.loading && !state?.error && (
          <>
            <p className="mask-editor-hint">{t('picture.tagsHint')}</p>
            <div className="picture-tags-list">
              {tags.map(tag => (
                <button
                  key={tag}
                  type="button"
                  className={`picture-tag ${dropped.has(tag) ? 'is-dropped' : ''}`}
                  onClick={() => toggle(tag)}
                  aria-pressed={!dropped.has(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
            <div className="picture-tags-actions">
              <button
                type="button"
                className="mask-tool"
                disabled={!kept.length}
                onClick={async () => { if (await onCopy(kept.join(', '))) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />} {t('picture.tagsCopy')}
              </button>
              <button type="button" className="mask-send" disabled={!kept.length} onClick={() => onUse(kept.join(', '))}>
                <CornerDownLeft size={14} /> {t('picture.tagsUse')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default PictureTags;
