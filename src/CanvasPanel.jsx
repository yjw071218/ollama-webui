import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Wand2, Undo2, Copy, Check, Download, Square, RotateCcw } from 'lucide-react';
import { useI18n } from './i18n.jsx';
import { copyText } from './clipboard.js';
import { diffText, summariseDiff } from './diffText.js';
import {
  splitBlocks, snapToBlocks, buildRewritePrompt, cleanRewrite, spliceSpan, spanLabel,
} from './canvas.js';
import { decodeByteFallback } from './byteFallback.js';

/**
 * A long answer, open and editable, beside the conversation.
 *
 * The artifact panel does this for code. Prose had nothing: a report with one
 * bad paragraph could be regenerated whole — four minutes, and the nine good
 * paragraphs come back subtly different — or fixed by hand in some other
 * program, at which point the conversation is no longer where the work is.
 *
 * ## The conversation is not rewritten
 *
 * Editing here never touches the message it came from, which is the same rule
 * the artifact panel already follows for code. A transcript is a record of
 * what was said; a document is a thing being made. Letting the second silently
 * rewrite the first means a conversation that no longer says what happened,
 * and there is no undo for that. The document is saved back to the message as
 * a *separate* field, so reopening finds the work and reading the transcript
 * still finds the answer.
 *
 * ## Selection is by block
 *
 * See `src/canvas.js`. A selection snaps outward to whole paragraphs, headings
 * and list items, because a rewrite spliced into the middle of a sentence
 * meets the untouched half at an angle and nobody reads their way out of that.
 *
 * ## One change at a time, shown before it is kept
 *
 * A rewrite lands as a proposal with a diff, not as an edit. On a local model
 * a rewrite is ten to forty seconds, and having to compare it against a
 * paragraph that is no longer on screen is how a worse version gets accepted.
 * Undo keeps the whole history of the document, so accepting is cheap too.
 */

/* What the buttons ask for. Free text is the real interface -- these are the
   four instructions people type over and over, so typing them is optional. */
const PRESETS = ['shorter', 'expand', 'simpler', 'formal'];

export const CanvasPanel = ({
  initialText,
  title,
  model,
  language,
  numCtx,
  onClose,
  onPersist,
  onToast,
}) => {
  const { t } = useI18n();

  /* The document and everything it has been. An array rather than a single
     value because undo has to reach back more than one step: a run of small
     rewrites is the normal way this gets used, and an undo that only reverses
     the last of them is an undo people stop trusting. */
  const [history, setHistory] = useState(() => [String(initialText || '')]);
  const text = history[history.length - 1];

  const [span, setSpan] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState(null);   // { span, before, after }
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef(null);
  const bodyRef = useRef(null);

  const blocks = useMemo(() => splitBlocks(text), [text]);

  /* Saved back to the conversation as the document changes, debounced: this is
     a keystroke-free surface, so the only writes are rewrites and undos, but
     an accepted rewrite should survive closing the panel by accident. */
  useEffect(() => {
    if (history.length === 1) return;              // nothing has happened yet
    const timer = setTimeout(() => onPersist?.(text), 400);
    return () => clearTimeout(timer);
  }, [text, history.length, onPersist]);

  useEffect(() => () => abortRef.current?.abort(), []);

  /**
   * Where the pointer left off, in document coordinates.
   *
   * The panel renders the document as one `<pre>` of plain text rather than as
   * rendered Markdown, and that is the decision that makes this work at all. A
   * rendered document has no stable mapping back to source offsets — a
   * selection over a bulleted list gives you offsets into the browser's idea
   * of the text, which is not the text the splice has to cut. Plain text is
   * less pretty and it is the only version where "the reader selected
   * characters 412 to 480" means anything.
   */
  const readSelection = useCallback(() => {
    const node = bodyRef.current;
    const selection = window.getSelection();
    if (!node || !selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    if (!node.contains(range.startContainer)) return;

    const before = range.cloneRange();
    before.selectNodeContents(node);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    const end = start + range.toString().length;

    setSpan(snapToBlocks(blocks, start, end));
    setProposal(null);
  }, [blocks]);

  const rewrite = async (what) => {
    if (!span || busy || !model) return;
    const asked = String(what || '').trim();
    if (!asked) return;

    setBusy(true);
    setProposal(null);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: false,
          /* A rewrite is a writing task, not a reasoning one, and a model that
             thinks first spends thirty seconds deciding how to shorten a
             paragraph. */
          think: false,
          messages: buildRewritePrompt(text, span, asked, { language }),
          options: {
            temperature: 0.4,
            /* Room for the block and a bit -- a rewrite that runs to four
               times the original has not understood the task, and cutting it
               off is cheaper than waiting for it. */
            num_predict: Math.max(256, Math.ceil(span.text.length / 2)),
            ...(numCtx ? { num_ctx: numCtx } : {}),
          },
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const after = cleanRewrite(decodeByteFallback(data.message?.content || ''), span.text);

      if (after.trim() === span.text.trim()) {
        onToast?.(t('canvas.unchanged'), 'info');
        return;
      }
      setProposal({ span, before: span.text, after });
    } catch (e) {
      if (e.name !== 'AbortError') onToast?.(t('canvas.failed', { error: e.message }), 'error');
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const accept = () => {
    if (!proposal) return;
    setHistory(list => [...list, spliceSpan(text, proposal.span, proposal.after)]);
    setProposal(null);
    setSpan(null);
    setInstruction('');
  };

  const undo = () => {
    if (history.length < 2) return;
    setHistory(list => list.slice(0, -1));
    setProposal(null);
    setSpan(null);
  };

  const download = () => {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(title || 'document').replace(/[^\w가-힣\- ]+/g, '').trim().slice(0, 60) || 'document'}.md`;
    link.click();
    // Not at once: the Android app reads the file from this URL after the click.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  const words = useMemo(() => (text.match(/\S+/g) || []).length, [text]);

  return (
    <div className="canvas-panel" role="region" aria-label={t('canvas.title')}>
      <div className="canvas-head">
        <div className="canvas-title" title={title}>{title || t('canvas.title')}</div>
        <div className="canvas-head-actions">
          <span className="canvas-count">{t('canvas.words', { count: words })}</span>
          <button
            className="variant-btn" onClick={undo}
            disabled={history.length < 2} title={t('canvas.undo')}
          >
            <Undo2 size={14} />
          </button>
          <button
            className="variant-btn"
            onClick={async () => {
              if (await copyText(text)) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
            }}
            title={t('canvas.copy')}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button className="variant-btn" onClick={download} title={t('canvas.download')}>
            <Download size={14} />
          </button>
          <button className="variant-btn" onClick={onClose} title={t('canvas.close')}>
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Plain text on purpose -- see readSelection. The highlight is drawn by
          slicing the same string three ways rather than by wrapping nodes,
          because a wrapper inside the selectable region changes the offsets
          the next selection reports. */}
      <pre
        className="canvas-body"
        ref={bodyRef}
        onMouseUp={readSelection}
        onKeyUp={readSelection}
        tabIndex={0}
      >
        {span ? (
          <>
            {text.slice(0, span.start)}
            <mark className="canvas-selected">{text.slice(span.start, span.end)}</mark>
            {text.slice(span.end)}
          </>
        ) : text}
      </pre>

      {proposal ? (
        <div className="canvas-foot">
          <CanvasDiff before={proposal.before} after={proposal.after} />
          <div className="canvas-actions">
            <button className="btn-primary" onClick={accept}>{t('canvas.keep')}</button>
            <button className="btn-ghost" onClick={() => setProposal(null)}>
              <RotateCcw size={14} style={{ marginRight: '0.35rem' }} />{t('canvas.discard')}
            </button>
          </div>
        </div>
      ) : (
        <div className="canvas-foot">
          {/* Said plainly rather than left to be inferred from a disabled
              button: "nothing happens when I press it" is the failure this
              line exists to prevent. */}
          <div className="canvas-hint">
            {span ? t('canvas.selected', { label: spanLabel(span.text) }) : t('canvas.selectFirst')}
          </div>
          <div className="canvas-presets">
            {PRESETS.map(preset => (
              <button
                key={preset}
                className="canvas-preset"
                disabled={!span || busy}
                onClick={() => rewrite(t(`canvas.preset.${preset}`))}
              >
                {t(`canvas.preset.${preset}`)}
              </button>
            ))}
          </div>
          <div className="canvas-actions">
            <input
              type="text"
              className="canvas-input"
              value={instruction}
              placeholder={t('canvas.instructionPlaceholder')}
              disabled={!span || busy}
              onChange={e => setInstruction(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') rewrite(instruction); }}
            />
            {busy ? (
              <button className="btn-ghost" onClick={() => abortRef.current?.abort()}>
                <Square size={14} style={{ marginRight: '0.35rem' }} />{t('canvas.stop')}
              </button>
            ) : (
              <button
                className="btn-primary"
                disabled={!span || !instruction.trim()}
                onClick={() => rewrite(instruction)}
              >
                <Wand2 size={14} style={{ marginRight: '0.35rem' }} />{t('canvas.rewrite')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * What the rewrite actually changed.
 *
 * The same one-column diff the variant pager uses, for the same reason: two
 * columns of the same paragraph is more reading, not less. Reused rather than
 * reimplemented, so "changed" means one thing in this app.
 */
const CanvasDiff = ({ before, after }) => {
  const { t } = useI18n();
  const { parts } = useMemo(() => diffText(before, after), [before, after]);
  const summary = useMemo(() => summariseDiff(parts), [parts]);

  return (
    <div className="canvas-diff">
      <div className="variant-diff-summary">
        {t('diff.summary', { added: summary.added, removed: summary.removed })}
      </div>
      <div className="variant-diff-body">
        {parts.map((part, n) => (
          part.type === 'same'
            ? <span key={n}>{part.text}</span>
            : part.type === 'add'
              ? <ins className="diff-add" key={n}>{part.text}</ins>
              : <del className="diff-remove" key={n}>{part.text}</del>
        ))}
      </div>
    </div>
  );
};

export default CanvasPanel;
