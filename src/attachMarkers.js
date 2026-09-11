/**
 * The blocks a turn injects into the user's message, written and read in one
 * place.
 *
 * An attachment is not stored on the message. It is folded into the text that
 * goes to the model, wrapped in a marker, and the transcript then unwraps it
 * again so the reader sees a chip with a filename instead of ten thousand
 * lines of CSV. That round trip works only while the writer and every reader
 * agree on the marker, and they did not.
 *
 * A file short enough to send whole is written as
 *
 *     --- Attached File: notes.txt ---
 *     ...the whole file...
 *     -------------------
 *
 * and a file too long for that is indexed into the knowledge library instead,
 * leaving only a note that says so. The note was added at the send site and
 * nowhere else — so four separate hand-written regexes went on looking for
 * `--- Attached File:` and found nothing, and the reader of a long attachment
 * saw the raw sentence `[Attached document: report.pdf, 214 pages. Its full
 * text has been indexed…]` sitting in their own message where every other
 * attachment showed a chip. The transcript, the HTML export, the sidebar
 * preview and the text-to-speech all had the same hole, because they were four
 * copies of the same knowledge rather than one.
 *
 * The wire format is unchanged: it is what old chats already hold, and the
 * sentence is addressed to the model, which does need to be told that the
 * passages below it are the file it was just handed.
 */

/* ------------------------------------------------------------- the writing */

/** A file small enough to travel whole. */
export const fileMarker = (name, data) =>
  `\n\n--- Attached File: ${name} ---\n${data}\n-------------------`;

/**
 * A file that went to the knowledge library instead.
 *
 * Naming it here is what tells the model that the passages retrieved a few
 * lines below are the document it was just handed, rather than something that
 * drifted in from an unrelated file.
 */
export const indexedMarker = ({ name, pages }) =>
  `\n\n[Attached document: ${name}${pages ? `, ${pages} pages` : ''}`
  + '. Its full text has been indexed; the relevant passages are supplied below.]';

/* ------------------------------------------------------------- the reading */

// Anchored on the fixed tail rather than on the name, so a filename with a
// comma or a full stop in it still parses.
const INDEXED = /\[Attached document: (.+?)(?:, (\d+) pages)?\. Its full text has been indexed; the relevant passages are supplied below\.\]/g;
// The body is captured, not skipped. It is the only surviving copy of what was
// attached — an attachment is folded into the message text and stored nowhere
// else — so a chip in the transcript can open the file the same way the chip in
// the composer could before it was sent.
const FILE = /---\s+Attached File:\s+(.*?)\s+---\n([\s\S]*?)\n-------------------/g;
const URL_FETCH = /---\s+\[MCP Tool\] Fetched Content from\s+(.*?)\s+---[\s\S]*?-------------------/g;
const IMAGE_NOTE = /---\s+Image Analysis by.*?\n[\s\S]*?-------------------\n?/g;
// Retrieved passages and web grounding, which the export strips and the
// transcript never had.
const CONTEXT = /---\s+\[(Knowledge|Grounding)\][\s\S]*?-------------------/g;

/** Every marker, for callers that only want them gone. */
const ALL = [INDEXED, FILE, URL_FETCH, IMAGE_NOTE, CONTEXT];

/**
 * The chips to draw above a message, and the message with the blocks removed.
 *
 * Order matters: an indexed document is listed where it was written, so a
 * message carrying both kinds shows them the way they were attached.
 */
export const extractAttachments = (content) => {
  const text = String(content || '');
  const found = [];

  for (const m of text.matchAll(FILE)) {
    // `data` is what the viewer shows. Named to match the composer's own
    // attachment objects so one dialog can open either.
    found.push({ at: m.index, attachment: { type: 'file', name: m[1], data: m[2] } });
  }
  for (const m of text.matchAll(INDEXED)) {
    found.push({
      at: m.index,
      // `indexed` rather than a separate kind of thing: this is a file the
      // reader attached, and it is drawn exactly like one. What differs is
      // where its text ended up, which belongs in the tooltip and not in a
      // chip that looks unlike its neighbours.
      attachment: { type: 'indexed', name: m[1], pages: m[2] ? Number(m[2]) : null },
    });
  }
  for (const m of text.matchAll(URL_FETCH)) {
    found.push({ at: m.index, attachment: { type: 'url', name: m[1] } });
  }

  found.sort((a, b) => a.at - b.at);

  return {
    attachments: found.map(f => f.attachment),
    cleanedContent: stripAttachments(text).trim(),
  };
};

/** The same blocks removed, for a preview line, an export or a spoken reading. */
export const stripAttachments = (content, replacement = '') =>
  ALL.reduce((text, pattern) => text.replace(pattern, replacement), String(content || ''));
