/* The versions of one chat the server still keeps, and a way back to one.
 *
 * Every edit of a synced chat leaves its previous version in the server's
 * record_history (see server/recordHistory.js: the newest fifty, then one a
 * day for ninety days). This lists them and puts one back.
 *
 * Putting one back is an ordinary edit -- the old messages, stamped now -- so
 * it syncs to the other devices like any change, and the version it replaced
 * lands in the history in turn. A restore is therefore undoable by the same
 * screen, which is the property that makes it safe to offer with one click. */
import React, { useCallback, useEffect, useState } from 'react';
import { History, RefreshCcw, RotateCcw } from 'lucide-react';
import { api } from './session.jsx';
import { confirmDialog } from './ConfirmDialog.jsx';

export const listChatRevisions = async (id) =>
  (await api(`/api/auth/history?${new URLSearchParams({ kind: 'chat', id: String(id) })}`)).revisions || [];

export const readChatRevision = async (id, rev) =>
  (await api(`/api/auth/history?${new URLSearchParams({ kind: 'chat', id: String(id), rev: String(rev) })}`)).revision;

/** The chat as it should be after restoring `payload` over `current`. */
export const restoredChat = (current, payload) => ({
  ...payload,
  // Its identity is the chat being restored, whatever the old copy says.
  id: current.id,
  // The *current* time stamp, so that `stamped()` (src/sessionEdit.js) sees
  // an edit that left the clock alone and stamps it now. Never the old time:
  // the restore would lose to the very version it is replacing.
  updatedAt: current.updatedAt,
});

const when = (ms) => {
  const d = new Date(ms);
  return d.toLocaleDateString() === new Date().toLocaleDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export default function ChatTimeline({ chat, signedIn, t, onRestore, toast }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revisions, setRevisions] = useState(null);

  const load = useCallback(async () => {
    if (!chat?.id) return;
    setBusy(true);
    try { setRevisions(await listChatRevisions(chat.id)); }
    catch (e) { toast?.(e.message, 'error'); setRevisions([]); }
    finally { setBusy(false); }
  }, [chat?.id, toast]);

  // A different chat is a different list.
  useEffect(() => { setRevisions(null); setOpen(false); }, [chat?.id]);
  useEffect(() => { if (open && revisions === null) load(); }, [open, revisions, load]);

  const restore = async (rev) => {
    if (!(await confirmDialog(t('timeline.confirm', { date: when(rev.updatedAt) }), { confirmLabel: t('timeline.restore') }))) return;
    setBusy(true);
    try {
      const old = await readChatRevision(chat.id, rev.rev);
      if (!old?.payload) throw new Error(t('timeline.gone'));
      onRestore(restoredChat(chat, old.payload));
      toast?.(t('timeline.restored'), 'success');
      setRevisions(null);
    } catch (e) {
      toast?.(e.message, 'error', 8000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-group">
      <label>{t('timeline.title')}</label>
      <div className="setting-desc">{t('timeline.explain')}</div>
      {!signedIn ? (
        <div className="setting-desc" style={{ marginTop: '0.6rem' }}>{t('share.signInFirst')}</div>
      ) : !open ? (
        <button className="btn pull-btn" style={{ marginTop: '0.6rem' }} onClick={() => setOpen(true)}>
          <History size={14} />{' '}{t('timeline.show')}
        </button>
      ) : (
        <div style={{ marginTop: '0.6rem' }}>
          <button className="icon-btn bordered" title={t('timeline.show')} disabled={busy} onClick={load}>
            <RefreshCcw size={14} className={busy ? 'spin' : ''} />
          </button>
          {revisions && revisions.length === 0 && (
            <div className="setting-desc" style={{ marginTop: '0.4rem' }}>{t('timeline.none')}</div>
          )}
          {revisions && revisions.length > 0 && (
            <div className="share-list" style={{ maxHeight: 320, overflowY: 'auto' }}>
              {revisions.map(rev => (
                <div key={rev.rev} className="share-row">
                  <div className="share-row-main">
                    <div className="share-row-title">
                      {when(rev.updatedAt)}
                      {rev.title && rev.title !== chat.title ? ` · ${rev.title}` : ''}
                    </div>
                    <div className="share-row-meta">
                      {rev.deleted ? t('timeline.deleted')
                        : t('timeline.messages', { count: rev.messages ?? '?' })}
                    </div>
                  </div>
                  {!rev.deleted && (
                    <button className="icon-btn" title={t('timeline.restore')} disabled={busy}
                      onClick={() => restore(rev)}>
                      <RotateCcw size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
