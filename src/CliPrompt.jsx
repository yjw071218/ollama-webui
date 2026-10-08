import React, { useState } from 'react';
import { ShieldQuestion, MessageCircleQuestion, Check, X, ChevronDown } from 'lucide-react';
import { useI18n } from './i18n.jsx';
import { cliLabel } from './CliLimits.jsx';

/**
 * One thing a CLI is waiting on, answered in the browser: a permission
 * ("may I run this?") or a question with choices (Claude Code's
 * AskUserQuestion, Codex's requestUserInput).
 *
 * Everything the CLI sent is shown as it sent it -- the tool, its input, the
 * question, every option's label and description -- only laid out. Nothing is
 * paraphrased, so what is approved is exactly what will run.
 */

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json());

export const answerPrompt = (id, decision, answers) => post('/cli/approvals', { id, decision, ...(answers ? { answers } : {}) });

const Detail = ({ text, open: initial = false }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(initial);
  if (!text) return null;
  let body = text, cwd = '';
  try { const input = JSON.parse(text); cwd = input?.cwd || ''; body = JSON.stringify(input, null, 2); } catch { /* plain text */ }
  const isDiff = /^(---|\+\+\+|@@|[-+] )/m.test(body);
  return (
    <div className="cli-prompt-detail">
      {cwd && <div className="cli-prompt-cwd">{t('agent.inFolder')} <code>{cwd}</code></div>}
      <button type="button" className="cli-prompt-disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown size={12} className={open ? 'is-open' : ''} aria-hidden="true" />{t('cliAgent.details')}
      </button>
      {open && (
        <pre className={isDiff ? 'is-diff' : ''}>
          {body.split('\n').map((line, i) => (
            <span key={i} className={isDiff ? (line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : '') : ''}>{line}{'\n'}</span>
          ))}
        </pre>
      )}
    </div>
  );
};

const Question = ({ q, value, onChange }) => {
  const { t } = useI18n();
  const chosen = value.picked || [];
  const pick = (label) => {
    const next = q.multiSelect
      ? (chosen.includes(label) ? chosen.filter(l => l !== label) : [...chosen, label])
      : [label];
    onChange({ ...value, picked: next, other: q.multiSelect ? value.other : '' });
  };
  return (
    <fieldset className="cli-question">
      {q.header && <legend className="cli-question-header">{q.header}</legend>}
      <div className="cli-question-text">{q.question}</div>
      {q.multiSelect && <div className="cli-question-hint">{t('cliPrompt.multi')}</div>}
      <div className="cli-question-options" role={q.multiSelect ? 'group' : 'radiogroup'}>
        {q.options.map((o, i) => {
          const on = chosen.includes(o.label);
          return (
            <button
              key={i}
              type="button"
              role={q.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={on}
              className={`cli-option ${on ? 'is-on' : ''}`}
              onClick={() => pick(o.label)}
            >
              <span className={`cli-option-mark ${q.multiSelect ? 'is-box' : ''}`} aria-hidden="true">{on && <Check size={11} />}</span>
              <span className="cli-option-text">
                <span className="cli-option-label">{o.label}</span>
                {o.description && <span className="cli-option-desc">{o.description}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {(q.allowOther || !q.options.length) && (
        <input
          type={q.secret ? 'password' : 'text'}
          className="cli-question-other"
          placeholder={q.options.length ? t('cliPrompt.other') : t('cliPrompt.answer')}
          value={value.other || ''}
          onChange={e => onChange({ picked: q.multiSelect ? chosen : (e.target.value ? [] : chosen), other: e.target.value })}
        />
      )}
    </fieldset>
  );
};

/** A pending item from /cli/approvals. `onDone(decision)` after it is answered. */
export const CliPromptCard = ({ item, onDone, compact = false }) => {
  const { t } = useI18n();
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const questions = Array.isArray(item.questions) ? item.questions : null;

  const send = async (decision, answers) => {
    if (busy) return;
    setBusy(true);
    try { await answerPrompt(item.id, decision, answers); } catch { /* the queue shows it again */ }
    onDone?.(decision);
  };

  if (questions) {
    const answers = Object.fromEntries(questions.map(q => {
      const v = values[q.id] || {};
      return [q.id, [...(v.picked || []), ...(v.other?.trim() ? [v.other.trim()] : [])]];
    }));
    const ready = questions.every(q => answers[q.id].length);
    return (
      <div className={`cli-prompt is-question ${compact ? 'is-compact' : ''}`} role="group" aria-label={t('cliPrompt.asks', { cli: cliLabel(item.provider) })}>
        <div className="cli-prompt-head">
          <MessageCircleQuestion size={15} aria-hidden="true" />
          <span>{t('cliPrompt.asks', { cli: cliLabel(item.provider) })}</span>
        </div>
        {questions.map(q => (
          <Question key={q.id} q={q} value={values[q.id] || {}} onChange={v => setValues(s => ({ ...s, [q.id]: v }))} />
        ))}
        <div className="cli-prompt-actions">
          <button type="button" className="btn-primary" disabled={!ready || busy} onClick={() => send('answer', answers)}>
            <Check size={13} /> {t('cliPrompt.submit')}
          </button>
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => send('decline')}>{t('cliPrompt.skip')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`cli-prompt is-approval ${compact ? 'is-compact' : ''}`} role="group" aria-label={t('cliAgent.approvalAsks', { cli: cliLabel(item.provider) })}>
      <div className="cli-prompt-head">
        <ShieldQuestion size={15} aria-hidden="true" />
        <span>{t('cliAgent.approvalAsks', { cli: cliLabel(item.provider) })}</span>
      </div>
      <code className="cli-prompt-title">{item.title}</code>
      <Detail text={item.detail} open={compact} />
      <div className="cli-prompt-actions">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => send('accept')}><Check size={13} /> {t('cliAgent.allowOnce')}</button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => send('acceptForSession')}>{t('cliAgent.allowSession')}</button>
        <button type="button" className="btn-ghost is-danger" disabled={busy} onClick={() => send('decline')}><X size={13} /> {t('cliAgent.decline')}</button>
      </div>
      {!compact && <div className="cli-prompt-foot">{t('cliAgent.approvalTimeout')}</div>}
    </div>
  );
};

export default CliPromptCard;
