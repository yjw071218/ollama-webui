import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FolderSearch, RefreshCcw, Trash2, Plus, TriangleAlert } from 'lucide-react';
import { useI18n } from './i18n.jsx';
import { loadLibrary, removeDocument, DEFAULT_EMBED_MODEL } from './rag.js';
import { ingestDocument } from './ingest.js';
import {
  planSync, isEmptyPlan, parseFolders, serialiseFolders,
  scanFolder, fetchFile, fileFromBase64, SCAN_INTERVAL_MS,
} from './watchFolders.js';

/**
 * Folders the library keeps up with.
 *
 * Everything here is the same pipeline a dragged file goes through —
 * `ingestDocument`, once, for all three ways a document can arrive. What is
 * new is only the decision about *which* files to put through it, which lives
 * in `src/watchFolders.js` where it can be tested.
 *
 * ## One file at a time, and slowly
 *
 * A folder of two hundred documents is two hundred extractions and some
 * thousands of embedding calls, on the same GPU that is running the model.
 * Firing them off together would make the machine unusable for the duration
 * and, on a card with a model loaded, would fail most of them for want of
 * memory. So the sync is a queue of one, it stops the moment anybody presses
 * stop, and it says which file it is on — because a progress bar that only
 * moves every forty seconds is indistinguishable from one that has hung.
 *
 * ## A failure is per file
 *
 * One PDF that is a scan with no text, one file locked by the program that
 * wrote it, one that turns out to be a renamed zip: each of those costs its
 * own file and nothing else. A sync that stops at the first failure is a sync
 * that never finishes on a real folder.
 */
export const WatchedFolders = ({ userId, embedModel, onLibraryChange }) => {
  const { t } = useI18n();

  const [folders, setFolders] = useState(() => parseFolders(localStorage.getItem('watchedFolders')));
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState(null);   // { folder, name, done, total }
  const [report, setReport] = useState(null);   // { added, updated, removed, failed: [] }
  const [problems, setProblems] = useState([]);
  const abortRef = useRef(null);
  const runningRef = useRef(false);

  const persist = (next) => {
    setFolders(next);
    try { localStorage.setItem('watchedFolders', serialiseFolders(next)); } catch (e) { /* private mode */ }
  };

  const sync = useCallback(async (list) => {
    /* Two syncs at once would race on the library: both load it, both save a
       version of it, and whichever finishes last wins -- silently discarding
       the other's work. A timer firing while a manual scan runs is exactly how
       that happens, so it is a flag rather than a disabled button. */
    if (runningRef.current) return;
    runningRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;
    setReport(null);
    setProblems([]);

    const tally = { added: 0, updated: 0, removed: 0, failed: [] };
    const trouble = [];

    try {
      for (const folder of list) {
        if (controller.signal.aborted) break;
        setStatus({ folder, name: '', done: 0, total: 0 });

        const scan = await scanFolder(folder, { signal: controller.signal });
        /* A folder that failed to list is left entirely alone. An unplugged
           drive looks exactly like a folder whose every file was deleted, and
           acting on that reading destroys a library that took an hour of GPU
           time -- after which the next question is answered from nothing, with
           nothing to say anything is missing. */
        if (!scan.ok) { trouble.push({ folder, error: scan.error }); continue; }
        if (scan.truncated) {
          trouble.push({ folder, error: t('watch.truncated', { limit: scan.limit }) });
        }

        const library = await loadLibrary(userId);
        const plan = planSync(folder, scan.files, library);
        if (isEmptyPlan(plan)) continue;

        const work = [...plan.add, ...plan.update];
        let done = 0;

        for (const file of work) {
          if (controller.signal.aborted) break;
          setStatus({ folder, name: file.name, done, total: work.length });
          try {
            const payload = await fetchFile(file.path, { signal: controller.signal });
            // Replaced, not added beside: the old version's chunks would
            // otherwise be retrieved alongside the new one for ever.
            if (file.replaces) await removeDocument(userId, file.replaces);
            const { library: next } = await ingestDocument(
              fileFromBase64(payload.name, payload.base64),
              {
                userId,
                embedModel: embedModel || DEFAULT_EMBED_MODEL,
                source: { folder, path: file.path, size: file.size, mtime: file.mtime },
                signal: controller.signal,
              },
            );
            onLibraryChange?.(next);
            if (file.replaces) tally.updated++; else tally.added++;
          } catch (e) {
            if (e.name === 'AbortError' || e.code === 'cancelled') throw e;
            tally.failed.push({ name: file.name, error: e.code || e.message });
          }
          done++;
        }

        for (const doc of plan.remove) {
          if (controller.signal.aborted) break;
          onLibraryChange?.(await removeDocument(userId, doc.id));
          tally.removed++;
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError' && e.code !== 'cancelled') trouble.push({ folder: null, error: e.message });
    } finally {
      runningRef.current = false;
      abortRef.current = null;
      setStatus(null);
      setReport(tally);
      setProblems(trouble);
    }
  }, [userId, embedModel, onLibraryChange, t]);

  /* On opening, and every ten minutes while the app is up. Not a file watcher:
     see the note at the top of src/watchFolders.js for why a listing beats a
     subscription here. */
  useEffect(() => {
    if (folders.length === 0) return;
    sync(folders);
    const timer = setInterval(() => sync(folders), SCAN_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [folders, sync]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const muted = { fontSize: '0.75rem', color: 'var(--text-muted)' };

  return (
    <div className="settings-group">
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <FolderSearch size={14} /> {t('watch.title')}
      </label>
      <div style={muted}>{t('watch.help')}</div>

      <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
        <input
          type="text"
          value={draft}
          placeholder={t('watch.placeholder')}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !draft.trim()) return;
            persist([...folders, draft.trim()].filter((f, i, all) => all.indexOf(f) === i));
            setDraft('');
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button
          className="btn-ghost"
          disabled={!draft.trim()}
          onClick={() => {
            persist([...folders, draft.trim()].filter((f, i, all) => all.indexOf(f) === i));
            setDraft('');
          }}
        >
          <Plus size={14} style={{ marginRight: '0.3rem' }} />{t('watch.add')}
        </button>
      </div>

      {folders.map(folder => (
        <div
          key={folder}
          style={{
            display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.4rem',
            fontSize: '0.8rem', fontFamily: 'var(--font-mono, monospace)',
          }}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {folder}
          </span>
          {/* Removing a folder stops it being scanned. It deliberately does not
              delete what it already indexed: those documents are answers to
              questions somebody may still be asking, and a settings row that
              silently destroys an hour of GPU time is not one anybody should
              press without being told. The panel above lists them. */}
          <button
            className="action-btn"
            title={t('watch.remove')}
            onClick={() => persist(folders.filter(f => f !== folder))}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.6rem' }}>
        {status ? (
          <button className="btn-ghost" onClick={() => abortRef.current?.abort()}>
            {t('watch.stop')}
          </button>
        ) : (
          <button className="btn-ghost" disabled={folders.length === 0} onClick={() => sync(folders)}>
            <RefreshCcw size={14} style={{ marginRight: '0.3rem' }} />{t('watch.scanNow')}
          </button>
        )}
        {/* Which file, not just a count: on a local model one document is
            twenty to sixty seconds, and a bar that moves that rarely is
            indistinguishable from one that has hung. */}
        {status && (
          <span style={muted}>
            {status.name
              ? t('watch.working', { name: status.name, done: status.done + 1, total: status.total })
              : t('watch.scanning', { folder: status.folder })}
          </span>
        )}
      </div>

      {report && !status && (
        <div style={{ ...muted, marginTop: '0.4rem' }}>
          {report.added || report.updated || report.removed
            ? t('watch.done', { added: report.added, updated: report.updated, removed: report.removed })
            : t('watch.upToDate')}
        </div>
      )}

      {(report?.failed || []).map((failure, i) => (
        <div key={`${failure.name}-${i}`} style={{ ...muted, color: 'var(--danger)', marginTop: '0.25rem' }}>
          {failure.name}: {failure.error}
        </div>
      ))}

      {problems.map((problem, i) => (
        <div
          key={`${problem.folder || 'x'}-${i}`}
          style={{
            display: 'flex', gap: '0.4rem', marginTop: '0.4rem',
            fontSize: '0.75rem', color: 'var(--danger)',
          }}
        >
          <TriangleAlert size={13} style={{ marginTop: '0.1rem', flexShrink: 0 }} />
          <div>{problem.folder ? <strong>{problem.folder}: </strong> : null}{problem.error}</div>
        </div>
      ))}
    </div>
  );
};

export default WatchedFolders;
