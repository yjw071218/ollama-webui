/**
 * The file changes a tool reported, read back out of its result text.
 *
 * server/workbench.js writes each change as
 *
 *     [file-change] C:\path\to\file.js (+3 -1)
 *     ```diff
 *     --- a/file.js
 *     +++ b/file.js
 *     @@ -1,3 +1,5 @@
 *     ...
 *     ```
 *
 * -- a line the model reads as prose, then a diff it can check its work
 * against. The server reads it to put the diff into a CLI's answer (see
 * server/cliModels.js); the chat reads it to show the reader what a tool
 * changed, above the answer rather than folded away with the tool steps
 * (see src/FileChanges.jsx). One parser, so the two cannot disagree.
 */

/** Every change in a tool result: `[{ file, added, removed, diff }]`. */
export const fileChangesIn = (text) => {
  const found = [];
  const re = /\[file-change\] (.+?) \(\+(\d+) -(\d+)\)\r?\n```diff\r?\n([\s\S]*?)\r?\n```/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    found.push({ file: m[1], added: Number(m[2]), removed: Number(m[3]), diff: m[4] });
  }
  return found;
};

/* How server/cliModels.js `changesAsMarkdown` puts a CLI's change into its answer. */
const ANSWER_CHANGE = /\n?📝 \*\*`(.+?)`\*\* \(\+(\d+) −(\d+)\)\r?\n```diff\r?\n([\s\S]*?)\r?\n```\n?/g;

/**
 * The changes a CLI's answer carries, and the answer without them:
 * `{ changes: [{ file, added, removed, diff }], text }`. The chat shows them
 * in the changed-files panel rather than as code blocks between paragraphs.
 */
/**
 * The answer cut at its changes, in order: `[{ type: 'text', text } |
 * { type: 'change', change }]`, so each diff is drawn right under the
 * sentence that announced it ("Now the styles:") rather than gathered at the end.
 */
export const answerPartsOf = (text) => {
  const source = String(text || '');
  const parts = [];
  let last = 0;
  for (const m of source.matchAll(ANSWER_CHANGE)) {
    const before = source.slice(last, m.index).trim();
    if (before) parts.push({ type: 'text', text: before });
    const [, file, added, removed, diff] = m;
    parts.push({ type: 'change', change: { file, added: Number(added), removed: Number(removed), diff } });
    last = m.index + m[0].length;
  }
  const rest = source.slice(last);
  if (!parts.length) return [{ type: 'text', text: source }];
  if (rest.trim()) parts.push({ type: 'text', text: rest.trim() });
  return parts;
};

export const answerChangesIn = (text) => {
  const changes = [];
  const rest = String(text || '').replace(ANSWER_CHANGE, (_, file, added, removed, diff) => {
    changes.push({ file, added: Number(added), removed: Number(removed), diff });
    return '\n';
  });
  return changes.length ? { changes, text: rest.replace(/\n{3,}/g, '\n\n').trim() } : { changes, text: String(text || '') };
};

/** A diff's lines, each with what kind of line it is, for drawing. */
export const diffLines = (diff) => String(diff || '').split(/\r?\n/).map((text) => ({
  text,
  kind: text.startsWith('@@') ? 'hunk'
    : text.startsWith('+++') || text.startsWith('---') ? 'file'
      : text.startsWith('+') ? 'add'
        : text.startsWith('-') ? 'del'
          : 'ctx',
}));
