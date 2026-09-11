/**
 * What actually changed between two answers.
 *
 * Regenerating already keeps both — there is a pager under the message reading
 * "2 / 3". What it does not tell you is the thing you regenerated to find out:
 * whether the second attempt is *different*, and where. On a local model an
 * answer is six hundred words and arrives four minutes apart from its
 * predecessor, so comparing them means reading six hundred words twice from
 * memory. Nobody does that. They skim, decide it "looks about the same", and
 * the regeneration was wasted.
 *
 * A diff turns that into a glance.
 *
 * ## Words, not characters or lines
 *
 * Character diffs of prose produce confetti: every changed word becomes three
 * fragments because its neighbours share letters. Line diffs are worse — a
 * paragraph is one line, so changing one word marks the whole paragraph, which
 * is exactly the information we wanted to remove. Words are the unit a reader
 * compares in, so they are the unit here.
 *
 * ## Cost
 *
 * The obvious algorithm is O(n·m), which for two three-thousand-word answers
 * is nine million cells and a visibly frozen tab. Two things keep it cheap:
 * the common head and tail are removed first (regenerated answers usually
 * share an opening and a closing, and often much more), and if what remains is
 * still too big the comparison falls back to paragraphs. A coarse diff drawn
 * instantly beats a perfect one that never arrives.
 */

/** Above this many word-pairs, fall back to comparing paragraphs. */
export const CELL_LIMIT = 400000;

/**
 * Split into comparable units, keeping the whitespace.
 *
 * The gaps are held with the word before them so that rejoining the parts
 * reproduces the original exactly — a diff that silently normalises spacing is
 * one you cannot trust about code, and code is what half these answers are.
 */
export const tokenise = (text) => String(text ?? '').match(/\s*\S+\s*|\s+/g) || [];

const paragraphs = (text) => String(text ?? '').split(/(\n{2,})/).filter(part => part !== '');

/** Comparison ignores surrounding space; display keeps it. */
const key = (token) => token.trim();

/**
 * Longest common subsequence, over token keys.
 *
 * Row-by-row rather than a full table where possible would save memory, but
 * the backtrack needs the table, and the caller has already guaranteed the
 * product is under `CELL_LIMIT`.
 */
const lcs = (a, b) => {
  const rows = a.length;
  const cols = b.length;
  // One flat typed array: a 2000×2000 array-of-arrays costs several times this
  // and spends the difference in the garbage collector.
  const table = new Int32Array((rows + 1) * (cols + 1));
  const at = (i, j) => i * (cols + 1) + j;

  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[at(i, j)] = key(a[i]) === key(b[j])
        ? table[at(i + 1, j + 1)] + 1
        : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }

  const parts = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (key(a[i]) === key(b[j])) { parts.push({ type: 'same', text: b[j] }); i++; j++; }
    else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) { parts.push({ type: 'remove', text: a[i] }); i++; }
    else { parts.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < rows) { parts.push({ type: 'remove', text: a[i] }); i++; }
  while (j < cols) { parts.push({ type: 'add', text: b[j] }); j++; }
  return parts;
};

/** Neighbouring parts of the same kind, joined. One `<ins>`, not forty. */
export const coalesce = (parts) => {
  const out = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (last && last.type === part.type) last.text += part.text;
    else out.push({ ...part });
  }
  return out.filter(part => part.text !== '');
};

/**
 * The diff, as a list of runs.
 *
 * `coarse` is set when the answers were too long to compare word by word and
 * paragraphs were used instead — the caller shows that, because a paragraph
 * marked wholly changed when one word moved would otherwise be a lie the
 * reader has no way to detect.
 */
export const diffText = (before, after) => {
  const a = tokenise(before);
  const b = tokenise(after);

  // The head and the tail. Regenerations usually share an opening sentence and
  // a closing one, and stripping them is often the difference between nine
  // million cells and nine thousand.
  let head = 0;
  while (head < a.length && head < b.length && key(a[head]) === key(b[head])) head++;
  let tail = 0;
  while (
    tail < a.length - head
    && tail < b.length - head
    && key(a[a.length - 1 - tail]) === key(b[b.length - 1 - tail])
  ) tail++;

  const middleA = a.slice(head, a.length - tail);
  const middleB = b.slice(head, b.length - tail);

  const shared = [
    ...(head ? [{ type: 'same', text: a.slice(0, head).join('') }] : []),
  ];
  const ending = tail ? [{ type: 'same', text: a.slice(a.length - tail).join('') }] : [];

  if (middleA.length * middleB.length > CELL_LIMIT) {
    // Too big for words. Paragraphs are coarse but instant, and an honest
    // coarse answer beats a perfect one that never renders.
    const coarse = lcs(paragraphs(middleA.join('')), paragraphs(middleB.join('')));
    return { parts: coalesce([...shared, ...coarse, ...ending]), coarse: true };
  }

  return { parts: coalesce([...shared, ...lcs(middleA, middleB), ...ending]), coarse: false };
};

/**
 * How much changed, in words.
 *
 * `identical` is the case worth naming: two regenerations of a deterministic
 * prompt really can come back the same, and "nothing changed" is a much more
 * useful thing to be told than an empty diff to squint at.
 */
export const summariseDiff = (parts) => {
  const words = (text) => (String(text).match(/\S+/g) || []).length;
  let added = 0;
  let removed = 0;
  let same = 0;
  for (const part of parts) {
    const count = words(part.text);
    if (part.type === 'add') added += count;
    else if (part.type === 'remove') removed += count;
    else same += count;
  }
  return { added, removed, same, identical: added === 0 && removed === 0 };
};
