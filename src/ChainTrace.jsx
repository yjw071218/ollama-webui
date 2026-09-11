import React, { useState } from 'react';
import { RefreshCcw, Check, X, ChevronDown, CornerDownRight } from 'lucide-react';
import { Collapsible } from './ui.jsx';
import { useI18n } from './i18n.jsx';

/**
 * What each step of a chain produced.
 *
 * The intermediate outputs are most of the value here, and they are the part
 * a single final answer throws away. When the last step disappoints — and on a
 * local model it often will — the only useful question is *which step went
 * wrong*, and that is unanswerable unless the middle was kept.
 *
 * So each step opens: the prompt it was actually sent, after the placeholders
 * were filled in, and what came back. The filled-in prompt rather than the
 * template, because "why did step three ignore my input" is nearly always
 * answered by looking at what step three was really asked.
 *
 * Open while it runs, closed afterwards — the final answer is what people came
 * for, and the working is there to be opened when they doubt it.
 */
export const ChainTrace = ({ run }) => {
  const { t } = useI18n();
  const [override, setOverride] = useState(null);
  const [openStep, setOpenStep] = useState(null);

  if (!run) return null;
  const running = !!run.running;
  const open = override === null ? running : override;
  const steps = run.steps || [];
  const done = steps.filter(s => s.state === 'done').length;

  return (
    <div className={`chain-trace ${running ? 'is-running' : ''} ${run.failed ? 'has-failed' : ''}`}>
      <button
        type="button"
        className="chain-summary"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
      >
        {running
          ? <RefreshCcw size={14} className="spin" />
          : run.failed ? <X size={14} /> : <Check size={14} />}
        <span className="chain-name">{run.name}</span>
        <span className="chain-meta">
          {running
            ? t('chains.progress', { done: done + 1, total: run.total || steps.length })
            : t('chains.finished', { count: done, seconds: run.seconds ?? 0 })}
        </span>
        <ChevronDown size={13} className="chain-chevron" />
      </button>

      <Collapsible open={open}>
        <ol className="chain-steps">
          {steps.map((step, index) => {
            const isOpen = openStep === index;
            return (
              <li className={`chain-step is-${step.state}`} key={index}>
                <button
                  type="button"
                  className="chain-step-head"
                  aria-expanded={isOpen}
                  onClick={() => setOpenStep(isOpen ? null : index)}
                >
                  <span className="chain-step-n">{index + 1}</span>
                  <span className="chain-step-title">
                    {step.title || t('chains.step', { n: index + 1 })}
                  </span>
                  {step.state === 'running' && <RefreshCcw size={11} className="spin" />}
                  {step.state === 'failed' && <span className="chain-step-error">{step.error}</span>}
                  {step.state === 'done' && (
                    <span className="chain-step-count">
                      {t('chains.chars', { count: (step.output || '').length })}
                    </span>
                  )}
                  <ChevronDown size={11} className="chain-chevron" />
                </button>

                <Collapsible open={isOpen}>
                  <div className="chain-step-body">
                    {/* The prompt as sent, not the template. "Why did step three
                        ignore my input" is nearly always answered by looking at
                        what step three was actually asked. */}
                    <div className="chain-step-label">
                      <CornerDownRight size={11} /> {t('chains.sent')}
                    </div>
                    <pre className="chain-step-pre">{step.prompt}</pre>
                    {step.output && (
                      <>
                        <div className="chain-step-label">{t('chains.came')}</div>
                        <pre className="chain-step-pre">{step.output}</pre>
                      </>
                    )}
                  </div>
                </Collapsible>
              </li>
            );
          })}
        </ol>
      </Collapsible>
    </div>
  );
};
