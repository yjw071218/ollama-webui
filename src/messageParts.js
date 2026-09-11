/**
 * An assistant message, split into what the reader reads and what goes in the
 * thinking dropdown: reasoning, tool calls, and what the tools returned.
 *
 * Its own file because the thing it gets wrong is visible: a call it fails to
 * recognise is shown to the reader as part of the answer, tag, attributes and
 * prompt included. Pure, so that is testable without rendering anything.
 */
import { decodeByteFallback } from './byteFallback.js';
import { DRAWING_TAGS, tagAttrs, TAG_ATTRS, canonicalToolTags } from './tools.js';

/* A tool call, whatever attributes it carries and in whatever order.
 *
 * This used to accept `path` and `query` and nothing else, so a drawing call --
 * `style`, `negative`, `from`, `change` -- never matched, and the whole tag,
 * prompt and all, was shown to the reader as part of the answer instead of as
 * a step in the thinking dropdown. */
const TOOL_CALL = `<(TOOL_(?!RESULT\\b)[A-Z_]+)${TAG_ATTRS}\\s*>([\\s\\S]*?)<\\/\\2>`;
const MESSAGE_PARTS = new RegExp(
  `(?:<think>([\\s\\S]*?)(?:<\\/think>|$))|(?:${TOOL_CALL})|(?:<TOOL_RESULT>([\\s\\S]*?)<\\/TOOL_RESULT>)`,
  'gi',
);

/** One tool call as a block, from its name, attribute text and body. */
const toolCallBlock = (tool, attrText, body = '', extra = {}) => {
  const name = String(tool).toUpperCase();
  const attrs = tagAttrs(attrText);
  return {
    type: 'tool_call',
    tool: name,
    attrs,
    // A drawing's body is its prompt, shown as a sentence; only the tools that
    // take a path put one in the body.
    path: attrs.path || (DRAWING_TAGS.has(name) ? undefined : body.trim() || undefined),
    query: attrs.query,
    content: body,
    ...extra,
  };
};

/**
 * `streaming` is for the message still arriving, the only one that can end in
 * a call whose closing tag has not been written yet.
 */
export const parseAssistantMessage = (content, { streaming = false } = {}) => {
  const blocks = [];
  // Decoding here as well as at accumulation is what repairs chats that were
  // already saved with the byte spellings in them. The guard inside makes it
  // free for the overwhelming majority of messages that have none.
  // The documented tag form, whatever form the model wrote -- see canonicalToolTags.
  const currentText = canonicalToolTags(decodeByteFallback(content || ''));

  const regex = new RegExp(MESSAGE_PARTS.source, MESSAGE_PARTS.flags);
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(currentText)) !== null) {
    if (match.index > lastIndex) {
      const beforeText = currentText.substring(lastIndex, match.index).trim();
      if (beforeText) blocks.push({ type: 'text', content: beforeText });
    }

    if (match[1] !== undefined) {
      blocks.push({ type: 'think', content: match[1], isComplete: match[0].endsWith('</think>') });
    } else if (match[2] !== undefined) {
      blocks.push(toolCallBlock(match[2], match[3], match[4] || ''));
    } else if (match[5] !== undefined) {
      blocks.push({ type: 'tool_result', content: match[5] });
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < currentText.length) {
    let remainingText = currentText.substring(lastIndex);
    /* A call still being written. While it streams, the tag has no closing
       half yet and matches nothing above, so for the seconds it takes to
       write a prompt the raw tag was on screen. It is a step in progress, and
       is shown as one. Only while streaming: in a finished message an opening
       tag with no end is text somebody wrote. */
    if (streaming) {
      const open = /<TOOL_(?!RESULT)[A-Z_]*[^<]*$/i.exec(remainingText);
      if (open) {
        const head = /^<(TOOL_[A-Z_]+)((?:\s+[A-Za-z_][\w-]*="[^"]*")*)[^>]*(>?)([\s\S]*)$/i.exec(open[0]);
        const before = remainingText.slice(0, open.index).trim();
        if (before) blocks.push({ type: 'text', content: before });
        blocks.push(toolCallBlock(head?.[1] || 'TOOL', head?.[2] || '', head?.[3] ? head[4] : '', { pending: true }));
        remainingText = '';
      }
    }
    remainingText = remainingText.trim();
    if (remainingText) blocks.push({ type: 'text', content: remainingText });
  }

  return blocks;
};
