/**
 * Every picture made, in one place.
 *
 * Pictures live where they were made: on the message that asked for them, in
 * whichever chat that was, and in the Studio's own history. Finding "the one
 * with the blue ribbon from last week" meant remembering which conversation it
 * was in. This collects both, newest first, searchable by the prompt each was
 * actually drawn from, and each one knows the way back to where it came from.
 */
import { useMemo, useState } from 'react';
import { Images, Search, MessageSquare, Download, Paperclip, Film, Wand2 } from 'lucide-react';
import { chatPictures, studioPictures } from './galleryItems.js';
import { Veil, useSafeguardLevel, useVerdict } from './SafeImage.jsx';
import { cacheKey } from './nsfwClassifier.js';
import { promptSignal, shouldVeil } from './safeguard.js';

/**
 * One card, behind the same glass as everywhere else.
 *
 * The gallery showed every picture bare -- the one place that collects all of
 * them, and so the one most likely to be opened with someone looking over a
 * shoulder. Each card is judged the way the place it came from judges it, and
 * shares that place's reveal: a picture shown on purpose in the chat is shown
 * here too, and one covered again is covered again here.
 *
 *   - a chat picture: classified from its bytes, with the prompt's say, and
 *     revealed under the same key as in the conversation;
 *   - a Studio picture: the verdict the Studio already reached and synced, or
 *     the classifier on the light copy, revealed under the Studio's key;
 *   - a film: its prompt, which is all there is to judge -- as in the Studio.
 *
 * While a verdict is pending the card is covered, as it is everywhere: "not
 * checked yet" is not "fine".
 */
const GalleryCard = ({ item, level, t, onOpen, children }) => {
  const verdict = useVerdict({
    src: item.video ? '' : item.full,
    look: item.video ? '' : item.src,
    prompt: item.prompt,
    known: item.job?.safety?.verdict,
    level,
  });
  const asked = promptSignal(item.prompt);
  const revealKey = item.source === 'studio' ? item.full : cacheKey(item.full);
  const judged = item.video ? (asked || 'safe') : verdict;
  return (
    <Veil verdict={judged} level={level} revealKey={revealKey} t={t} className="picture-gallery-frame">
      <button type="button" className="picture-gallery-open" onClick={() => onOpen(item)} title={item.prompt}
        // Covered, the glass is what is pressed; the picture behind it does not open.
        tabIndex={shouldVeil(judged, level) ? -1 : 0}>
        {children}
      </button>
    </Veil>
  );
};

export const PictureGallery = ({ sessions, studioJobs, thumbOf, t, onOpen, onGoTo, onAttach, onDownload }) => {
  const level = useSafeguardLevel();
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');

  const items = useMemo(() => {
    const all = [...chatPictures(sessions), ...studioPictures(studioJobs, thumbOf)]
      .sort((a, b) => (b.at || 0) - (a.at || 0));
    const needle = query.trim().toLowerCase();
    return all.filter(item => (source === 'all' || item.source === source)
      && (!needle || item.prompt.toLowerCase().includes(needle) || item.sessionTitle?.toLowerCase().includes(needle)));
  }, [sessions, studioJobs, thumbOf, query, source]);

  return (
    <div className="picture-gallery">
      <div className="picture-gallery-head">
        <span className="picture-gallery-title"><Images size={16} /> {t('gallery.title')}</span>
        <span className="picture-gallery-count">{t('gallery.count', { count: items.length })}</span>
      </div>
      <div className="picture-gallery-filters">
        <label className="picture-gallery-search">
          <Search size={14} />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('gallery.search')} />
        </label>
        <div className="picture-gallery-sources" role="tablist">
          {[['all', t('gallery.all')], ['chat', t('gallery.fromChats')], ['studio', t('gallery.fromStudio')]].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={source === id}
              className={source === id ? 'is-on' : ''} onClick={() => setSource(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="picture-gallery-empty">{t('gallery.empty')}</div>
      ) : (
        <div className="picture-gallery-grid">
          {items.map(item => (
            <figure key={item.key} className="picture-gallery-item">
              <GalleryCard item={item} level={level} t={t} onOpen={onOpen}>
                {item.video
                  ? <video src={item.src} muted playsInline preload="metadata" />
                  : <img src={item.src} alt={item.prompt} loading="lazy" decoding="async" />}
                <span className="picture-gallery-badge">
                  {item.video ? <Film size={11} /> : item.source === 'studio' ? <Wand2 size={11} /> : <MessageSquare size={11} />}
                </span>
              </GalleryCard>
              <figcaption title={item.prompt}>{item.prompt || item.sessionTitle}</figcaption>
              <div className="picture-gallery-actions">
                {item.source === 'chat' && (
                  <button type="button" onClick={() => onGoTo(item)} title={t('gallery.goTo')}><MessageSquare size={13} /></button>
                )}
                {!item.video && (
                  <button type="button" onClick={() => onAttach(item)} title={t('gallery.attach')}><Paperclip size={13} /></button>
                )}
                <button type="button" onClick={() => onDownload(item)} title={t('picture.download')}><Download size={13} /></button>
              </div>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
};

export default PictureGallery;
