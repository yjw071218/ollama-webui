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

/**
 * Where an attached file is on the PC (found by /cli/locate), for the
 * model to cite and for a CLI agent to open. Hidden from the transcript like
 * the other markers -- the chip already says which file it was.
 */
/**
 * A web page asked about from the Windows app's own browser (browser.mjs):
 * all of its text for the model, and only a chip in the transcript. Its
 * pictures travel as the message's images, hidden there too.
 */
export const webpageMarker = ({ title, url, text, images = 0 }) =>
  `\n\n--- [Web Page] ${String(title || url).replace(/\s*\|\s*/g, ' ').replace(/\n/g, ' ')} | ${url} | ${images} images ---\n`
  + `The reader is looking at this web page and is asking about it. Its full text follows`
  + `${images ? `; the attached images are ${images > 1 ? 'the page screenshot and its pictures' : 'the page screenshot'}` : ''}.\n\n${text}\n-------------------`;

/** The same page again in one chat: its text and pictures are already above. */
export const webpageAgainMarker = ({ title, url }) =>
  `\n\n[Web Page again: ${String(title || url).replace(/[\]\n|]/g, ' ')} | ${url} | its full text and images were sent earlier in this conversation]`;

/** Whether a chat's messages already carry this page (fragment ignored). */
export const pageAlreadySent = (messages = [], url = '') => {
  const bare = (u) => String(u || '').split('#')[0];
  const want = bare(url);
  if (!want) return false;
  return messages.some(m => m?.role === 'user' && [...String(m.content || '').matchAll(/--- \[Web Page\] .*? \| (\S*) \| \d+ images ---/g)].some(x => bare(x[1]) === want));
};

export const pathMarker = (name, where) => `\n[Attached file path: ${name} -> ${where}]`;

/* ------------------------------------------------------------- the reading */

// Anchored on the fixed tail rather than on the name, so a filename with a
// comma or a full stop in it still parses.
const INDEXED = /\[Attached document: (.+?)(?:, (\d+) pages)?\. Its full text has been indexed; the relevant passages are supplied below\.\]/g;
// The body is captured, not skipped. It is the only surviving copy of what was
// attached — an attachment is folded into the message text and stored nowhere
// else — so a chip in the transcript can open the file the same way the chip in
// the composer could before it was sent.
const FILE = /---\s+Attached File:\s+(.*?)\s+---\n([\s\S]*?)\n-------------------/g;
const WEBPAGE = /---\s+\[Web Page\]\s+(.*?) \| (\S*) \| (\d+) images ---\n[\s\S]*?\n-------------------/g;
const WEBPAGE_AGAIN = /\n?\[Web Page again: (.*?) \| (\S*) \| [^\]\n]*\]/g;
const URL_FETCH = /---\s+\[MCP Tool\] Fetched Content from\s+(.*?)\s+---[\s\S]*?-------------------/g;
const IMAGE_NOTE = /---\s+Image Analysis by.*?\n[\s\S]*?-------------------\n?/g;
// Retrieved passages and web grounding, which the export strips and the
// transcript never had.
const CONTEXT = /---\s+\[(Knowledge|Grounding)\][\s\S]*?-------------------/g;

/** Every marker, for callers that only want them gone. */
const PATH = /\n?\[Attached file path: [^\]\n]*\]/g;
const ALL = [INDEXED, WEBPAGE, WEBPAGE_AGAIN, FILE, URL_FETCH, IMAGE_NOTE, CONTEXT, PATH];

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
  for (const m of text.matchAll(WEBPAGE)) {
    // Shown as a chip that does not open: the page went to the model only.
    found.push({ at: m.index, attachment: { type: 'url', webpage: true, name: `🌐 ${m[1]}${Number(m[3]) ? ` · 이미지 ${m[3]}장` : ''}`, url: m[2] } });
  }
  for (const m of text.matchAll(WEBPAGE_AGAIN)) {
    found.push({ at: m.index, attachment: { type: 'url', webpage: true, name: `🌐 ${m[1]} · 앞에서 전달됨`, url: m[2] } });
  }
  for (const m of text.matchAll(URL_FETCH)) {
    found.push({ at: m.index, attachment: { type: 'url', name: m[1] } });
  }

  /* Where a file was kept (pathMarker), so a sent PDF opens as the document. */
  const paths = new Map();
  for (const m of text.matchAll(/\[Attached file path: (.*?) -> ([^\]\n]+)\]/g)) paths.set(m[1], m[2]);
  for (const f of found) if (paths.has(f.attachment.name) && !f.attachment.path) f.attachment.path = paths.get(f.attachment.name);

  found.sort((a, b) => a.at - b.at);

  return {
    attachments: found.map(f => f.attachment),
    cleanedContent: stripAttachments(text).trim(),
  };
};

/** The same blocks removed, for a preview line, an export or a spoken reading. */
export const stripAttachments = (content, replacement = '') =>
  ALL.reduce((text, pattern) => text.replace(pattern, replacement), String(content || ''));

/**
 * A sent message taken apart for editing: the words the reader typed, and the
 * attachment blocks as they were sent, so the edit box can show them as chips
 * (removable) instead of pasting whole files into the textarea. `joinEdited`
 * puts them back together, in the same order handleSend writes them.
 */
export const splitForEdit = (content) => {
  const text = String(content || '');
  const blocks = [];
  const take = (pattern, kind, nameOf) => {
    for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      blocks.push({ at: m.index, kind, name: nameOf(m), raw: m[0].startsWith('\n') ? m[0] : `\n\n${m[0]}` });
    }
  };
  take(FILE, 'file', m => m[1]);
  take(INDEXED, 'indexed', m => m[1]);
  take(WEBPAGE, 'webpage', m => `🌐 ${m[1]}`);
  take(WEBPAGE_AGAIN, 'webpage', m => `🌐 ${m[1]}`);
  take(PATH, 'path', m => (/\[Attached file path: (.*?) -> /.exec(m[0]) || [])[1] || 'path');
  blocks.sort((a, b) => a.at - b.at);
  return { text: stripAttachments(text).trim(), blocks: blocks.map(({ at, ...b }, i) => ({ ...b, id: `${i}:${at}` })) };
};

export const joinEdited = (text, blocks = []) => String(text || '') + blocks.map(b => b.raw).join('');
