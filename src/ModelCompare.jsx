import React, { useEffect, useRef, useState } from 'react';
import { X, Play, Square, RefreshCcw, Copy, Check, Cpu, TriangleAlert } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from './i18n.jsx';

/** Reasoning is folded away so the answers can be compared side by side. */
const splitThinking = (content) => {
  const text = String(content || '');
  const thinking = [...text.matchAll(/<think>([\s\S]*?)(?:<\/think>|$)/gi)]
    .map(m => m[1])
    .join('\n')
    .trim();
  const answer = text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim();
  return { thinking, answer };
};

const Column = ({ run, onCopy, copied }) => {
  const { t } = useI18n();
  const { thinking, answer } = splitThinking(run.content);
  const [showThinking, setShowThinking] = useState(false);

  return (
    <div className="compare-column">
      <div className="compare-head">
        <Cpu size={13} />
        <span className="compare-model">{run.model}</span>
        {run.status === 'running' && <RefreshCcw size={12} className="spin" />}
        {run.metrics && (
          <span className="compare-metrics">
            {run.metrics.totalTime}s
            {run.metrics.tokensPerSec ? ` · ${run.metrics.tokensPerSec} tok/s` : ''}
            {run.metrics.evalCount ? ` · ${run.metrics.evalCount} tok` : ''}
          </span>
        )}
        <button className="icon-btn" title={t('common.copy')} onClick={() => onCopy(run.model, answer)}>
          {copied === run.model ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>

      <div className="compare-body">
        {run.error && (
          <div className="auth-error"><TriangleAlert size={14} /> <span>{run.error}</span></div>
        )}

        {thinking && (
          <button className="compare-think-toggle" onClick={() => setShowThinking(v => !v)}>
            {showThinking ? t('compare.hideThinking') : t('compare.showThinking')}
          </button>
        )}
        {thinking && showThinking && <pre className="compare-thinking">{thinking}</pre>}

        {answer
          ? <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown></div>
          : run.status === 'running'
            ? <div className="stream-dots"><span /><span /><span /></div>
            : !run.error && <div className="compare-empty">{t('compare.noOutput')}</div>}
      </div>
    </div>
  );
};

export const ModelCompare = ({ models, defaultPrompt, systemPrompt, options, onClose }) => {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState(defaultPrompt || '');
  const [selected, setSelected] = useState(() => models.slice(0, 2).map(m => m.name));
  const [runs, setRuns] = useState([]);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(null);
  const controllers = useRef([]);

  useEffect(() => () => controllers.current.forEach(c => c.abort()), []);

  const toggleModel = (name) => {
    setSelected(prev => (prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]));
  };

  const copy = (model, text) => {
    navigator.clipboard.writeText(text);
    setCopied(model);
    setTimeout(() => setCopied(null), 1500);
  };

  const stop = () => {
    controllers.current.forEach(c => c.abort());
    controllers.current = [];
    setRunning(false);
    setRuns(prev => prev.map(r => (r.status === 'running' ? { ...r, status: 'stopped' } : r)));
  };

  const run = async () => {
    if (!prompt.trim() || selected.length === 0) return;

    setRunning(true);
    setRuns(selected.map(model => ({ model, content: '', status: 'running', metrics: null, error: '' })));
    controllers.current = [];

    // Fired together: the wall-clock comparison is the interesting part.
    await Promise.all(selected.map(async (model) => {
      const controller = new AbortController();
      controllers.current.push(controller);

      const messages = systemPrompt
        ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
        : [{ role: 'user', content: prompt }];

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ model, messages, options }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let thinking = '';
        let answer = '';

        const paint = () => setRuns(prev => prev.map(r => (
          r.model === model
            ? { ...r, content: (thinking ? `<think>\n${thinking}\n</think>\n\n` : '') + answer }
            : r
        )));

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            let parsed;
            try { parsed = JSON.parse(line); } catch (e) { continue; }

            const delta = parsed.message || {};
            if (delta.thinking) thinking += delta.thinking;
            if (delta.content) answer += delta.content;
            if (delta.thinking || delta.content) paint();

            if (parsed.done) {
              const totalTime = (parsed.total_duration / 1e9).toFixed(2);
              const tokensPerSec = parsed.eval_duration && parsed.eval_count
                ? (parsed.eval_count / (parsed.eval_duration / 1e9)).toFixed(1)
                : null;
              setRuns(prev => prev.map(r => (
                r.model === model
                  ? { ...r, status: 'done', metrics: { totalTime, tokensPerSec, evalCount: parsed.eval_count } }
                  : r
              )));
            }
          }
        }

        setRuns(prev => prev.map(r => (r.model === model && r.status === 'running' ? { ...r, status: 'done' } : r)));
      } catch (e) {
        if (e.name === 'AbortError') return;
        setRuns(prev => prev.map(r => (r.model === model ? { ...r, status: 'error', error: e.message } : r)));
      }
    }));

    setRunning(false);
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal compare-modal" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
          <h2 style={{ marginBottom: 0 }}>{t('compare.title')}</h2>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="settings-group">
          <label>{t('compare.models')} ({selected.length})</label>
          <div className="compare-picker">
            {models.map(m => (
              <button
                key={m.name}
                className={`compare-chip ${selected.includes(m.name) ? 'active' : ''}`}
                onClick={() => toggleModel(m.name)}
                disabled={running}
              >
                {m.name}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-group">
          <label>{t('compare.prompt')}</label>
          <textarea
            className="settings-textarea"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder={t('compare.promptPlaceholder')}
            style={{ minHeight: '90px' }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
            {running ? (
              <button className="icon-btn bordered" onClick={stop}>
                <Square size={13} /> {t('composer.stop')}
              </button>
            ) : (
              <button className="pull-btn" onClick={run} disabled={!prompt.trim() || selected.length === 0}>
                <Play size={14} style={{ marginRight: '0.35rem' }} /> {t('compare.run')}
              </button>
            )}
          </div>
        </div>

        {runs.length > 0 && (
          <div className="compare-grid" style={{ '--compare-columns': Math.min(runs.length, 3) }}>
            {runs.map(r => <Column key={r.model} run={r} onCopy={copy} copied={copied} />)}
          </div>
        )}

        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('compare.help')}</div>
      </div>
    </div>
  );
};
