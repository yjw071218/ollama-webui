/**
 * A long clip's storyboard: every segment, what it was asked for, and how far
 * it has got -- with the two things that can be done about one.
 *
 * - A segment that has not started can be rewritten while the ones before it
 *   render. The storyboard the model wrote is a first draft; the part of a
 *   music video that is going wrong is usually visible by the second segment.
 * - A finished segment can be drawn again, with a new prompt or the same one,
 *   and the clip is joined again. In one continuous take the next segment
 *   opens on this one's last frame, so a redone segment leaves a jump at the
 *   next seam unless the segments after it are redone too -- which is a choice
 *   offered, not made for anybody, because it is several times the wait.
 *
 * The server keeps the segments (server/longVideo.js); this only reads and asks.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Clapperboard, RefreshCcw, Save, Loader2 } from 'lucide-react';

const secondsLabel = (value) => `${Math.round(Number(value) * 10) / 10}s`;

export const LongStoryboard = ({ longId, t, onNewVersion, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);
  const [info, setInfo] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [following, setFollowing] = useState(false);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState('');
  const version = useRef(null);
  const announced = useRef(onNewVersion);
  announced.current = onNewVersion;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/studio/long-info?id=${encodeURIComponent(longId)}`);
      const data = await res.json().catch(() => null);
      if (!data?.success) return;
      setInfo(data);
      /* A redo finished: the conversation's copy of the clip is the old file
         until it is told about the new one. */
      if (version.current !== null && data.version > version.current && data.output) {
        announced.current?.(data.output);
        setMessage(t('storyboard.redone'));
      }
      version.current = data.version;
      if (data.redoError) setMessage(t('storyboard.redoFailed', { error: data.redoError }));
    } catch (e) { /* offline: the panel keeps what it had */ }
  }, [longId, t]);

  useEffect(() => { if (open) load(); }, [open, load]);
  // Watched while anything is being drawn, and only while the panel is open.
  useEffect(() => {
    if (!open || info?.state !== 'running') return undefined;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [open, info?.state, load]);

  const post = async (path, body) => {
    const res = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
  };

  const save = async (n) => {
    setBusy(`save-${n}`);
    const answer = await post('/studio/long-prompt', { id: longId, segment: n, prompt: drafts[n] ?? info.prompts[n] });
    setBusy(null);
    setMessage(answer.success ? t('storyboard.saved', { n: n + 1 }) : (answer.error || t('storyboard.error')));
    if (answer.success) setDrafts(d => { const next = { ...d }; delete next[n]; return next; });
    load();
  };

  const redo = async (n) => {
    setBusy(`redo-${n}`);
    const answer = await post('/studio/long-redo', {
      id: longId, segment: n, prompt: drafts[n] ?? info.prompts[n], following: following && !info.cut,
    });
    setBusy(null);
    setMessage(answer.success
      ? t('storyboard.redoing', { from: answer.from + 1, to: answer.to + 1 })
      : (answer.error || t('storyboard.error')));
    load();
  };

  const running = info?.state === 'running';

  return (
    <div className={`long-storyboard ${open ? 'is-open' : ''}`}>
      <button type="button" className="long-storyboard-toggle" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <Clapperboard size={13} />
        <span>{t('storyboard.title')}</span>
        {info && <span className="long-storyboard-count">{t('storyboard.count', { count: info.count })}</span>}
        <ChevronDown size={13} className="long-storyboard-chevron" />
      </button>
      {open && (
        <div className="long-storyboard-body">
          {!info ? (
            <div className="long-storyboard-empty"><Loader2 size={14} className="spin" /></div>
          ) : (
            <>
              {!info.cut && !running && (
                <label className="long-storyboard-following">
                  <input type="checkbox" checked={following} onChange={e => setFollowing(e.target.checked)} />
                  <span>{t('storyboard.following')}</span>
                </label>
              )}
              <ol className="long-storyboard-list">
                {info.prompts.map((prompt, n) => {
                  const state = info.segments[n] || 'pending';
                  const draft = drafts[n];
                  const from = n * info.segmentSeconds;
                  return (
                    <li key={n} className={`long-segment is-${state}`}>
                      <div className="long-segment-head">
                        <span className="long-segment-number">{t('storyboard.segment', { n: n + 1 })}</span>
                        <span className="long-segment-time">{secondsLabel(from)}–{secondsLabel(from + info.segmentSeconds)}</span>
                        <span className={`long-segment-state is-${state}`}>{t(`storyboard.state.${state}`)}</span>
                      </div>
                      <textarea
                        className="long-segment-prompt"
                        value={draft ?? prompt}
                        rows={3}
                        // Only what can still change: a segment being drawn has been sent.
                        disabled={state === 'running' || (running && state !== 'pending')}
                        onChange={e => setDrafts(d => ({ ...d, [n]: e.target.value }))}
                      />
                      <div className="long-segment-actions">
                        {running && state === 'pending' && (
                          <button type="button" disabled={draft === undefined || !!busy} onClick={() => save(n)}>
                            <Save size={12} /><span>{t('storyboard.save')}</span>
                          </button>
                        )}
                        {!running && (
                          <button type="button" disabled={!!busy} onClick={() => redo(n)}>
                            {busy === `redo-${n}` ? <Loader2 size={12} className="spin" /> : <RefreshCcw size={12} />}
                            <span>{t('storyboard.redo')}</span>
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
              {message && <p className="long-storyboard-message" role="status">{message}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default LongStoryboard;
