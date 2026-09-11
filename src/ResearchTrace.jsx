import React, { useState } from 'react';
import { Search, FileText, ListTree, PenLine, Check, X, RefreshCcw, ChevronDown, ExternalLink } from 'lucide-react';
import { Collapsible } from './ui.jsx';
import { useI18n } from './i18n.jsx';
import { visibleSteps } from './research.js';

/**
 * What a research run did, shown as it does it.
 *
 * A run takes minutes on a local model, and the only honest way to show that
 * is to show the work: the queries it decided on, the pages it opened, the
 * ones that refused. A spinner for four minutes is indistinguishable from a
 * hang, and -- worse -- a report that arrives out of nowhere is one nobody can
 * check. The trace is what makes a wrong answer traceable to the page that
 * was wrong.
 *
 * Open while it runs, closed once it is done. The steps matter most when they
 * are the only thing on screen; afterwards the answer is what people came for,
 * and the trace is there to be opened when they doubt it.
 */

const ICONS = {
  plan: ListTree,
  search: Search,
  read: FileText,
  write: PenLine,
};

const stepLabel = (step, t) => {
  if (step.kind === 'plan') {
    return step.state === 'running'
      ? t('research.stepPlanning')
      : t('research.stepPlanned', { count: (step.queries || []).length });
  }
  if (step.kind === 'search') return t('research.stepSearch', { query: step.query || '' });
  if (step.kind === 'read') return step.title || step.url || '';
  return step.state === 'running'
    ? t('research.stepWriting', { count: step.sources || 0 })
    : t('research.stepWritten');
};

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
};

export const ResearchTrace = ({ research }) => {
  const { t } = useI18n();
  const running = !!research?.running;
  // Open while it runs; the reader can hold it open afterwards.
  const [override, setOverride] = useState(null);
  const open = override === null ? running : override;
  if (!research) return null;

  const steps = visibleSteps(research.steps || []);
  const sources = research.sources || [];
  const read = sources.filter(s => s.read).length;

  return (
    <div className={`research-trace ${running ? 'is-running' : ''}`}>
      <button
        type="button"
        className="research-summary"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
      >
        {running
          ? <RefreshCcw size={14} className="spin" />
          : research.failed ? <X size={14} /> : <Check size={14} />}
        <span className="research-title">
          {running ? t('research.running') : t('research.done')}
        </span>
        <span className="research-meta">
          {running
            ? t('research.stepsSoFar', { count: steps.length })
            : t('research.summary', {
              sources: sources.length,
              read,
              seconds: research.seconds ?? 0,
            })}
        </span>
        <ChevronDown size={13} className="research-chevron" />
      </button>

      <Collapsible open={open}>
        <div className="research-body">
          <ol className="research-steps">
            {steps.map((step, idx) => {
              const Icon = ICONS[step.kind] || Search;
              const state = step.error ? 'failed' : step.state;
              return (
                <li key={idx} className={`research-step is-${state} kind-${step.kind}`}>
                  <span className="research-step-icon">
                    {state === 'running' ? <RefreshCcw size={12} className="spin" /> : <Icon size={12} />}
                  </span>
                  <span className="research-step-label">
                    {step.kind === 'read' && step.url
                      ? <a href={step.url} target="_blank" rel="noopener noreferrer">{stepLabel(step, t)}</a>
                      : stepLabel(step, t)}
                  </span>
                  {step.kind === 'plan' && step.queries?.length > 0 && (
                    <span className="research-queries">
                      {step.queries.map((q, qi) => <code key={qi}>{q}</code>)}
                    </span>
                  )}
                  {step.error && <span className="research-step-error">{step.error}</span>}
                  {state === 'done' && step.kind === 'search' && (
                    <span className="research-step-count">{t('research.found', { count: step.found || 0 })}</span>
                  )}
                  {state === 'done' && step.kind === 'read' && (
                    <span className="research-step-count">{t('research.chars', { count: step.chars || 0 })}</span>
                  )}
                </li>
              );
            })}
          </ol>

          {/* The numbering here is the numbering in the answer: [3] above is
              the third entry below, which is what makes a citation checkable
              rather than decorative. */}
          {sources.length > 0 && (
            <ol className="research-sources">
              {sources.map((source, idx) => (
                <li key={idx} className={source.read ? 'was-read' : ''}>
                  <a href={source.url} target="_blank" rel="noopener noreferrer" title={source.url}>
                    <span className="research-source-n">[{idx + 1}]</span>
                    <span className="research-source-title">{source.title || source.url}</span>
                    <span className="research-source-host">{hostOf(source.url)}</span>
                    <ExternalLink size={11} />
                  </a>
                  {!source.read && <span className="research-source-note">{t('research.snippetOnly')}</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      </Collapsible>
    </div>
  );
};
