/**
 * Every picture made, in one place.
 *
 * Pictures live where they were made: on the message that asked for them, in
 * whichever chat that was, and in the Studio's own history. Finding "the one
 * with the blue ribbon from last week" meant remembering which conversation it
 * was in. This collects both, newest first, searchable by the prompt each was
 * actually drawn from, and each one knows the way back to where it came from.
 */
import { useEffect, useMemo, useState } from 'react';
import { Images, Search, MessageSquare, Download, Paperclip, Film, Wand2, Check, X, CheckCheck } from 'lucide-react';
import { chatPictures, studioPictures } from './galleryItems.js';
import { buildIndex, searchPictures, literalPictures, mergePictures } from './pictureSearch.js';
import { Veil, useSafeguardLevel, useVerdict, useVideoVerdict } from './SafeImage.jsx';
import { StudioLightbox } from './StudioLightbox.jsx';
import { copyText } from './clipboard.js';
import { videoFileOf } from './videoSafety.js';
import { cacheKey } from './nsfwClassifier.js';
import { promptSignal, shouldVeil, strongest } from './safeguard.js';
import { pictureFileOf } from './pictureSafety.js';

/**
 * A gallery item as the viewer shows it, judged and revealed as its card is:
 * the Studio's verdict where the job has one, otherwise the same classifier on
 * the same lighter copy, or the film's frames -- and revealed under the same
 * key, so a picture shown on its card is shown in the viewer, and the other way
 * round.
 */
const asViewerItem = (item) => {
  const known = item.job?.safety?.verdict;
  return {
    url: item.full,
    look: item.video ? '' : item.src,
    filename: item.filename,
    video: item.video,
    prompt: item.prompt,
    model: item.model,
    size: item.size,
    seed: item.seed,
    origin: item.source === 'chat' ? item.sessionTitle : '',
    fromChat: item.source === 'chat',
    ...(item.before ? { before: item.before } : {}),
    ...(known ? { verdict: strongest(known, promptSignal(item.prompt)) } : {}),
    file: item.video && item.file ? videoFileOf(item.file) : null,
    duration: item.duration,
    revealKey: item.source === 'studio' ? item.full : cacheKey(item.full),
  };
};

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
 *   - a film: its frames, tagged in ComfyUI, and its prompt -- as in the
 *     Studio and the chat. See videoSafety.js.
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
    /* And what the tagger makes of the file itself -- the witness that is not
       guessing. See src/pictureSafety.js. */
    file: item.video ? null : pictureFileOf({ url: item.full, filename: item.filename }),
    level,
  });
  const file = item.video && item.file ? videoFileOf(item.file) : null;
  const filmVerdict = useVideoVerdict({
    file,
    prompt: item.prompt,
    known: item.job?.safety?.verdict,
    level,
    duration: item.duration,
  });
  const asked = promptSignal(item.prompt);
  const revealKey = item.source === 'studio' ? item.full : cacheKey(item.full);
  // A film with no file to read (an old chat message) has only its prompt.
  const judged = item.video ? (filmVerdict || asked || 'safe') : verdict;
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

export const PictureGallery = ({ sessions, studioJobs, thumbOf, t, onGoTo, onAttach, onDownload, scope = '' }) => {
  const level = useSafeguardLevel();
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  // The key of the item open in the viewer -- a key, not a position, so a
  // picture arriving while it is open does not move the viewer to another one.
  const [viewing, setViewing] = useState(null);
  /* Which ones are picked, by key.
   *
   * Saving twenty pictures meant twenty presses on twenty different buttons,
   * each of which had to be found first. Picking is a mode rather than a
   * modifier key, because half the time this gallery is being used on a phone
   * and there is no modifier key there -- and because a grid where a plain tap
   * sometimes opens and sometimes selects is a grid nobody trusts. */
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState(() => new Set());
  const togglePicked = (key) => setPicked((was) => {
    const next = new Set(was);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  const stopPicking = () => { setPicking(false); setPicked(new Set()); };

  const everything = useMemo(() => [...chatPictures(sessions, thumbOf), ...studioPictures(studioJobs, thumbOf)]
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .filter(item => source === 'all' || item.source === source),
  [sessions, studioJobs, thumbOf, source]);

  /* What was typed, found by meaning when the words do not match.
   *
   * Substring first, always: type part of a prompt you remember exactly and
   * that is what you want, not the five prompts most like it. The semantic
   * pass runs only when the letters find nothing, which is the case it is for
   * -- you remember *a red sunset over water* and what was typed a month ago
   * was `golden hour, ocean horizon, dramatic clouds`. See src/pictureSearch.js.
   */
  const [semantic, setSemantic] = useState({ query: '', hits: [], searching: false, failed: false });
  const literal = useMemo(() => literalPictures(everything, query), [everything, query]);

  useEffect(() => {
    const wanted = query.trim();
    // Nothing typed, or the letters already found something: no work to do.
    if (wanted.length < 2 || literal.length > 0) {
      setSemantic({ query: wanted, hits: [], searching: false, failed: false });
      return undefined;
    }
    if (semantic.query === wanted && !semantic.searching) return undefined;
    const controller = new AbortController();
    let stopped = false;
    setSemantic({ query: wanted, hits: [], searching: true, failed: false });
    (async () => {
      try {
        const index = await buildIndex(scope, everything, { signal: controller.signal });
        const hits = await searchPictures(index, wanted, { signal: controller.signal });
        if (!stopped) setSemantic({ query: wanted, hits, searching: false, failed: false });
      } catch (e) {
        // No embedding model, or it is not running. The letters are still the
        // answer; this half simply has nothing to add.
        if (!stopped) setSemantic({ query: wanted, hits: [], searching: false, failed: true });
      }
    })();
    return () => { stopped = true; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, literal.length, everything, scope]);

  const items = useMemo(
    () => (semantic.query === query.trim() ? mergePictures(everything, literal, semantic.hits) : literal),
    [everything, literal, semantic, query],
  );

  /* Only what is on screen counts as picked. Searching, then picking, then
     searching again must not leave a save quietly carrying pictures the reader
     can no longer see -- so the set is read through the list rather than
     trusted on its own. */
  const chosen = items.filter(item => picked.has(item.key));

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
          {/* The letters found nothing and the meaning is being looked for.
              Said out loud because the first one on a large gallery is a wait:
              every prompt has to be embedded once. */}
          {semantic.searching && <span className="gallery-searching">{t('gallery.byMeaning')}</span>}
        </label>
        {/* Picking several at once. A mode, not a modifier: half of this is
            used on a phone, and a grid where a tap sometimes opens and
            sometimes selects is one nobody trusts. */}
        <button
          type="button"
          className={`picture-gallery-pick ${picking ? 'is-on' : ''}`}
          aria-pressed={picking}
          onClick={() => (picking ? stopPicking() : setPicking(true))}
          title={picking ? t('gallery.pickDone') : t('gallery.pick')}
        >
          <CheckCheck size={14} aria-hidden="true" />
          <span>{picking ? t('gallery.pickDone') : t('gallery.pick')}</span>
        </button>
        <div className="picture-gallery-sources" role="tablist">
          {[['all', t('gallery.all')], ['chat', t('gallery.fromChats')], ['studio', t('gallery.fromStudio')]].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={source === id}
              className={source === id ? 'is-on' : ''} onClick={() => setSource(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* What can be done to all of them. Only while picking, and only with
          something picked -- a bar that is always there, usually saying zero,
          is a bar that is always in the way. */}
      {picking && (
        <div className="picture-gallery-bulk" role="status">
          <span className="picture-gallery-bulk-count">
            {t('gallery.picked', { count: chosen.length })}
          </span>
          <button type="button" onClick={() => setPicked(new Set(items.map(item => item.key)))}
            disabled={chosen.length === items.length}>
            <Check size={13} aria-hidden="true" /> {t('gallery.pickAll')}
          </button>
          <button type="button" disabled={!chosen.length}
            onClick={async () => {
              /* One at a time and awaited, not twenty at once. A browser
                 cancels all but the first few of a burst of downloads, so a
                 loop that fires them in parallel quietly saves three of
                 twenty -- which reads as the button half working. */
              for (const item of chosen) await onDownload(item);
              stopPicking();
            }}>
            <Download size={13} aria-hidden="true" /> {t('gallery.savePicked', { count: chosen.length })}
          </button>
          <button type="button" disabled={!chosen.some(item => !item.video)}
            onClick={() => { chosen.filter(item => !item.video).forEach(onAttach); stopPicking(); }}>
            <Paperclip size={13} aria-hidden="true" /> {t('gallery.attachPicked')}
          </button>
          <button type="button" className="picture-gallery-bulk-close" onClick={stopPicking}
            aria-label={t('gallery.pickDone')} title={t('gallery.pickDone')}>
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <div className="picture-gallery-empty">{t('gallery.empty')}</div>
      ) : (
        <div className="picture-gallery-grid">
          {items.map(item => (
            <figure
              key={item.key}
              className={`picture-gallery-item ${picking ? 'is-picking' : ''} ${picked.has(item.key) ? 'is-picked' : ''}`}
            >
              <GalleryCard item={item} level={level} t={t}
                /* While picking, a tap picks rather than opens. The card is
                   the whole target, not a small checkbox in a corner: a
                   twelve-pixel box is not something anybody hits on a phone. */
                onOpen={(opened) => (picking ? togglePicked(opened.key) : setViewing(opened.key))}>
                {item.video
                  ? <video src={item.src} muted playsInline preload="metadata" />
                  : <img src={item.src} alt={item.prompt} loading="lazy" decoding="async" />}
                <span className="picture-gallery-badge">
                  {item.video ? <Film size={11} /> : item.source === 'studio' ? <Wand2 size={11} /> : <MessageSquare size={11} />}
                </span>
                {picking && (
                  <span className="picture-gallery-tick" aria-hidden="true">
                    {picked.has(item.key) && <Check size={13} />}
                  </span>
                )}
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

      {/* The Studio's viewer, walking the grid as it is filtered. */}
      {viewing && (() => {
        const at = items.findIndex(item => item.key === viewing);
        if (at < 0) return null;
        return (
          <StudioLightbox
            items={items.map(asViewerItem)}
            index={at}
            onIndex={n => setViewing(items[n].key)}
            onClose={() => setViewing(null)}
            onCopy={copyText}
            onDownload={n => onDownload(items[n])}
            tools={[
              {
                id: 'goto', icon: <MessageSquare size={16} />, label: t('gallery.goTo'),
                when: (shown) => shown.fromChat, run: n => onGoTo(items[n]),
              },
              {
                id: 'attach', icon: <Paperclip size={16} />, label: t('gallery.attach'),
                when: (shown) => !shown.video, run: n => onAttach(items[n]),
              },
            ]}
            t={t}
          />
        );
      })()}
    </div>
  );
};

export default PictureGallery;
