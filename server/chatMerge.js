/**
 * Two versions of one chat, written on two devices from the same starting
 * point, made into one.
 *
 * ## Why
 *
 * A chat syncs as one record, and the later write wins it whole. That is right
 * for one person on one device at a time and wrong as soon as two devices
 * touch the same chat: a phone that has not yet received the answer the PC
 * just finished, and then does anything to that chat -- changes its model,
 * stars a message, sends the next question -- uploads its whole copy, newer by
 * the clock, and the PC's answer is gone from every device. Seen in the
 * account's own history (record_history) as messages that vanished, or came
 * back in a different order.
 *
 * So a device says which version its edit was made on (`base`: the stamp of
 * the copy it last had in step with the server), and when the server has
 * moved on since, the two are merged here instead of one replacing the other.
 *
 * ## Integrity, the way a table keeps it
 *
 * A message's key is its role and the moment it was written (`at`): the
 * primary key of the conversation. Two rows with one key are one message, and
 * the merged list never holds the same key twice (entity integrity). That is
 * what an edited question used to break: the edit keeps the `at` and changes
 * the words, the old rule compared words, and the conversation came back with
 * the question twice and both answers under it. A message with no `at` (old
 * data, tool results) has no key and is compared by its words, as before.
 *
 * ## The rule
 *
 * With the base copy known (the server keeps it in record_history) it is a
 * three-way merge: a message the base had and one side no longer has was
 * removed on that side on purpose -- an edited question drops the answers under
 * it, a regenerated answer drops the old one, a deleted message is deleted --
 * and it stays removed. Of two copies of one message, the side that changed it
 * since the base wins.
 *
 * Then messages are matched from the start. Where both have the same message,
 * it is kept once -- the longer copy when one is a message still being written
 * in the other. After the shared part:
 *
 *   - only one side has more: those are kept (nothing is lost);
 *   - both have more: both are kept, in the order they were written (`at`),
 *     each side's own order preserved.
 *
 * Without the base (history pruned) a merge cannot tell a message deleted on a
 * stale device from one it never received; it keeps it. Losing a deletion is
 * the cheaper mistake. Everything that is not the message list comes from the
 * device's version, which is the newer intent.
 */

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('');
  return content == null ? '' : String(content);
};

const stampOf = (message) => (Number.isFinite(message?.at) ? message.at : null);

/** The primary key of a message, or null for one without a time. */
export const messageKey = (message) => {
  const at = stampOf(message);
  return at === null ? null : `${message?.role}|${at}`;
};

/** The same message, or one copy of it further along than the other. */
const sameMessage = (a, b) => {
  if (!a || !b || a.role !== b.role) return false;
  const ka = messageKey(a), kb = messageKey(b);
  if (ka !== null && kb !== null) return ka === kb;
  const x = textOf(a.content), y = textOf(b.content);
  if (x === y) return true;
  // A reply caught mid-stream on one side: the other side's copy carries on from it.
  return a.role === 'assistant' && (x.startsWith(y) || y.startsWith(x));
};

/** Of two copies of one message, the one to keep. `before` is the copy both started from, when known. */
const pick = (server, mine, before = null) => {
  const x = textOf(server.content), y = textOf(mine.content);
  if (before) {
    const b = textOf(before.content);
    // Whoever changed it since the common copy is the newer intent.
    if (y !== b && x === b) return { ...server, ...mine };
    if (x !== b && y === b) return { ...mine, ...server };
  }
  // An edit is a deliberate rewrite and says when; the later one stands.
  const ex = Number(server.editedAt) || 0, ey = Number(mine.editedAt) || 0;
  if (ex !== ey) return ex > ey ? { ...mine, ...server } : { ...server, ...mine };
  // A reply still being written on one side: the longer copy is further along.
  if (server.role === 'assistant' && x.length > y.length) return { ...mine, ...server };
  return { ...server, ...mine };
};

/** Two message lists written on top of one another, in the order they happened. */
const interleave = (a, b) => {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i >= a.length) { out.push(b[j++]); continue; }
    if (j >= b.length) { out.push(a[i++]); continue; }
    const ta = stampOf(a[i]), tb = stampOf(b[j]);
    // Without a time to go by, the server's comes first: it was there first.
    if (ta !== null && tb !== null && tb < ta) out.push(b[j++]);
    else out.push(a[i++]);
  }
  return out;
};

/** No key twice: the first place a message stands is its place, later copies fold into it. */
export const uniqueMessages = (list) => {
  const seen = new Map();
  const out = [];
  for (const message of list) {
    const key = messageKey(message);
    if (key === null) { out.push(message); continue; }
    if (seen.has(key)) {
      const at = seen.get(key);
      out[at] = pick(out[at], message);
      continue;
    }
    seen.set(key, out.length);
    out.push(message);
  }
  return out;
};

/**
 * `server` and `mine` are chat payloads; `base` is the copy `mine` was edited
 * from, when the server still has it. Returns the merged chat, or null when
 * `mine` adds nothing to `server` (the server's copy should simply stand).
 */
export const mergeChats = (server, mine, base = null) => {
  if (!server || !mine) return mine || server || null;
  let s = Array.isArray(server.messages) ? server.messages : [];
  let m = Array.isArray(mine.messages) ? mine.messages : [];
  const b = Array.isArray(base?.messages) ? base.messages : null;
  const baseByKey = new Map();
  if (b) {
    for (const message of b) { const key = messageKey(message); if (key !== null) baseByKey.set(key, message); }
    const keysIn = (list) => new Set(list.map(messageKey).filter(key => key !== null));
    const inMine = keysIn(m), inServer = keysIn(s);
    // Removed on my side since the base: not brought back from the server.
    s = s.filter(message => { const key = messageKey(message); return key === null || !baseByKey.has(key) || inMine.has(key); });
    // Removed on the server's side since the base: not brought back by my stale copy.
    m = m.filter(message => { const key = messageKey(message); return key === null || !baseByKey.has(key) || inServer.has(key); });
  }
  s = uniqueMessages(s);
  m = uniqueMessages(m);

  let shared = 0;
  const prefix = [];
  while (shared < s.length && shared < m.length && sameMessage(s[shared], m[shared])) {
    prefix.push(pick(s[shared], m[shared], baseByKey.get(messageKey(s[shared])) || null));
    shared++;
  }
  const serverTail = s.slice(shared);
  const myTail = m.slice(shared);

  // Nothing of mine beyond what the server has: only my other fields could be news.
  if (!myTail.length) {
    const messages = uniqueMessages([...prefix, ...serverTail]);
    const { messages: _ignored, updatedAt: _a, ...myFields } = mine;
    const { messages: _ignored2, updatedAt: _b, ...serverFields } = server;
    const sameFields = JSON.stringify(myFields) === JSON.stringify(serverFields);
    const sameMessages = JSON.stringify(messages) === JSON.stringify(server.messages || []);
    if (sameFields && sameMessages) return null;
    return { ...server, ...mine, messages };
  }
  const messages = uniqueMessages(serverTail.length
    ? [...prefix, ...interleave(serverTail, myTail)]
    : [...prefix, ...myTail]);
  return { ...server, ...mine, messages };
};
