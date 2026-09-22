import React, { useCallback, useEffect, useRef, useState } from 'react';
import localforage from 'localforage';
import { Play, Square, FlaskConical, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { useI18n } from './i18n.jsx';
import { decodeByteFallback } from './byteFallback.js';
import {
  parseSuite, formatSuite, isScorable, buildJudgePrompt, judgeSchema,
  parseVerdict, summarise, compareRuns, describeRun, newId, MAX_SCORE,
} from './evals.js';

/**
 * A set of questions, kept and re-run.
 *
 * Everything here that alters an answer — the system prompt, the preset, the
 * model, the retrieval switches — is currently adjusted by trying it once and
 * deciding it felt better. That is one sample, read once, against a fading
 * memory of the previous answer; and it is not even a fair impression, since
 * the answer that was waited for longer is the one remembered as better.
 *
 * ## Stored here, not synced
 *
 * A suite is small and a run is not — every answer the model gave, kept so a
 * regression can be read rather than inferred from a number that went down.
 * Syncing that would push megabytes of generated prose to every device on
 * every run, to be looked at on one of them. It lives in IndexedDB beside the
 * knowledge library, keyed by profile, and the suite text can be copied out in
 * the format it was written in.
 *
 * ## Serially, and stoppable
 *
 * Twenty cases is twenty answers and twenty markings on the same GPU, which is
 * ten minutes on a machine running a real model. Nothing here is parallel: two
 * generations at once on one card is slower than one after another *and* is
 * how a run fails halfway through for want of memory. The row being worked on
 * is named, because a progress bar that moves every thirty seconds cannot be
 * told from one that has stopped.
 */

const store = localforage.createInstance({ name: 'ollama-webui', storeName: 'evals' });
const keyFor = (userId) => `evals:${userId || 'guest'}`;

export const EvalPanel = ({ userId, model, systemPrompt, promptName, options, onToast }) => {
  const { t } = useI18n();

  const [text, setText] = useState('');
  const [runs, setRuns] = useState([]);
  const [busy, setBusy] = useState(null);      // { done, total, question }
  const abortRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    store.getItem(keyFor(userId)).then((saved) => {
      if (cancelled || !saved) return;
      setText(saved.text || '');
      setRuns(Array.isArray(saved.runs) ? saved.runs : []);
    });
    return () => { cancelled = true; };
  }, [userId]);

  const persist = useCallback((next) => {
    store.setItem(keyFor(userId), next).catch(() => { /* quota; the run is still on screen */ });
  }, [userId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const ask = async (question, signal) => {
    const started = Date.now();
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          ...(systemPrompt?.trim() ? [{ role: 'system', content: systemPrompt }] : []),
          { role: 'user', content: question },
        ],
        options,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      answer: decodeByteFallback(data.message?.content || ''),
      ms: Date.now() - started,
    };
  };

  const mark = async (testCase, answer, signal) => {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        stream: false,
        /* The judge does not think first. A marking that takes as long as the
           answer doubles the length of every run to produce the same 0-3. */
        think: false,
        format: judgeSchema(),
        messages: buildJudgePrompt(testCase, answer),
        options: { temperature: 0, num_predict: 200, num_ctx: 8192 },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return parseVerdict(decodeByteFallback(data.message?.content || ''));
  };

  const run = async () => {
    const cases = parseSuite(text);
    if (cases.length === 0 || !model) return;

    const controller = new AbortController();
    abortRef.current = controller;
    const results = [];

    try {
      for (let i = 0; i < cases.length; i++) {
        if (controller.signal.aborted) break;
        const testCase = cases[i];
        setBusy({ done: i, total: cases.length, question: testCase.question });

        try {
          const { answer, ms } = await ask(testCase.question, controller.signal);
          /* Marked only where something said what right looks like. A case
             with no expectation is run and shown and left unscored, rather
             than handed to a judge that would invent a number out of the
             answer's length and confidence. */
          const verdict = isScorable(testCase) ? await mark(testCase, answer, controller.signal) : null;
          results.push({
            caseId: testCase.id,
            question: testCase.question,
            expect: testCase.expect,
            answer,
            ms,
            ...(verdict ? { score: verdict.score, why: verdict.why } : {}),
            /* A marking that did not happen is not a zero, and it is not
               silence either: it is its own outcome and it says so. */
            ...(isScorable(testCase) && !verdict ? { unmarked: true } : {}),
          });
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          results.push({ caseId: testCase.id, question: testCase.question, error: e.message });
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') onToast?.(t('evals.failed', { error: e.message }), 'error');
    } finally {
      abortRef.current = null;
      setBusy(null);
    }

    if (results.length === 0) return;

    const record = {
      id: newId(),
      at: Date.now(),
      model,
      promptName: promptName || null,
      settings: { temperature: options?.temperature },
      results,
    };
    /* Ten kept. Enough to see a direction and few enough that IndexedDB is not
       holding a year of generated prose nobody will read. */
    const next = { text, runs: [record, ...runs].slice(0, 10) };
    setRuns(next.runs);
    persist(next);
  };

  const cases = parseSuite(text);
  const scorable = cases.filter(isScorable).length;
  const latest = runs[0];
  const previous = runs[1];
  const summary = latest ? summarise(latest.results) : null;
  const diff = latest && previous ? compareRuns(previous, latest) : null;

  const muted = { fontSize: '0.75rem', color: 'var(--text-muted)' };

  return (
    <div className="settings-group">
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <FlaskConical size={14} /> {t('evals.title')}
      </label>
      <div style={muted}>{t('evals.help')}</div>

      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); persist({ text: e.target.value, runs }); }}
        placeholder={t('evals.placeholder')}
        rows={8}
        style={{ width: '100%', marginTop: '0.5rem', fontFamily: 'var(--font-mono, monospace)', fontSize: '0.8rem' }}
      />
      <div style={muted}>
        {t('evals.caseCount', { count: cases.length, scored: scorable })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
        {busy ? (
          <button className="btn-ghost" onClick={() => abortRef.current?.abort()}>
            <Square size={14} style={{ marginRight: '0.3rem' }} />{t('evals.stop')}
          </button>
        ) : (
          <button className="btn-primary" disabled={cases.length === 0 || !model} onClick={run}>
            <Play size={14} style={{ marginRight: '0.3rem' }} />{t('evals.run')}
          </button>
        )}
        {/* Which question, not just a count: a bar that moves every thirty
            seconds cannot be told from one that has stopped. */}
        {busy && (
          <span style={{ ...muted, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t('evals.working', { done: busy.done + 1, total: busy.total, question: busy.question })}
          </span>
        )}
      </div>

      {summary && !busy && (
        <div style={{ marginTop: '0.75rem' }}>
          <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>
            {summary.mean === null
              ? t('evals.noScore')
              : t('evals.score', {
                percent: summary.percent,
                mean: summary.mean.toFixed(2),
                max: MAX_SCORE,
                scored: summary.scored,
              })}
          </div>
          <div style={muted}>{describeRun(latest)}</div>
          {(summary.unscored > 0 || summary.failed > 0) && (
            <div style={muted}>
              {t('evals.asterisks', { unscored: summary.unscored, failed: summary.failed })}
            </div>
          )}

          {/* Against the previous run, because "2.4 out of 3" means nothing on
              its own -- it is a property of how hard the questions are. What
              means something is that it was 2.1 before the prompt changed. */}
          {diff && (
            <div style={{ ...muted, marginTop: '0.35rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              {diff.delta === null || Math.abs(diff.delta) < 0.005
                ? <Minus size={13} />
                : diff.delta > 0 ? <TrendingUp size={13} color="var(--success)" />
                  : <TrendingDown size={13} color="var(--danger)" />}
              {t('evals.versus', {
                delta: diff.delta === null ? '—' : `${diff.delta > 0 ? '+' : ''}${diff.delta.toFixed(2)}`,
                better: diff.better,
                worse: diff.worse,
              })}
            </div>
          )}

          {/* The cases that moved, worst first. This is the part anybody acts
              on: a mean that fell says something happened, and only the list
              says what. */}
          {(diff?.moved || []).slice(0, 5).map(row => (
            <div key={row.caseId} style={{ ...muted, marginTop: '0.2rem' }}>
              <strong style={{ color: row.to < row.from ? 'var(--danger)' : 'var(--success)' }}>
                {row.from} → {row.to}
              </strong>{' '}{row.question}
            </div>
          ))}

          <details style={{ marginTop: '0.5rem' }}>
            <summary style={{ ...muted, cursor: 'pointer' }}>{t('evals.showAll')}</summary>
            {latest.results.map(row => (
              <div key={row.caseId} style={{ marginTop: '0.5rem', fontSize: '0.78rem' }}>
                <div style={{ fontWeight: 600 }}>
                  {row.error
                    ? t('evals.rowFailed')
                    : Number.isFinite(row.score) ? `${row.score}/${MAX_SCORE}` : t('evals.rowUnscored')}
                  {' · '}{row.question}
                </div>
                {/* The reason, not just the number: on a suite anybody actually
                    writes, several low scores are a wrong expectation rather
                    than a wrong answer, and only the reason tells them apart. */}
                {row.why && <div style={muted}>{row.why}</div>}
                {row.error && <div style={{ ...muted, color: 'var(--danger)' }}>{row.error}</div>}
                {row.answer && (
                  <div style={{ ...muted, whiteSpace: 'pre-wrap', maxHeight: '8rem', overflowY: 'auto' }}>
                    {row.answer}
                  </div>
                )}
              </div>
            ))}
          </details>
        </div>
      )}
    </div>
  );
};

export default EvalPanel;
