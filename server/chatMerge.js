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

/* ------------------------------------------------------- the other fields
 *
 * Everything that is not the message list -- pinned, title, folder, model,
 * archived, persona... -- used to come from whichever device uploaded, whole.
 * So a pin made on the PC was undone by a phone that, not yet in step, merely
 * streamed a reply into the same chat: the phone's copy said `pinned: false`
 * and its fields won. A lost update, field by field.
 *
 * Now each field is its own last-writer-wins register. A device stamps the
 * fields an edit changed (`_fieldAt`, src/sessionEdit.js); of two copies the
 * field with the later stamp stands, whoever uploaded. Fields without stamps
 * (older clients) fall back to the three-way rule: the side that changed it
 * since the common copy wins; with no common copy, the uploading device's. */
const META = new Set(['messages', 'updatedAt', '_fieldAt']);
const sameValue = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
export const fieldStampsOf = (chat) => (chat && chat._fieldAt && typeof chat._fieldAt === 'object' ? chat._fieldAt : {});

/** The non-message fields of two copies, merged field by field. */
export const mergeFields = (server, mine, base = null) => {
  const fs = fieldStampsOf(server), fm = fieldStampsOf(mine);
  const out = {};
  const stamps = { ...fs };
  for (const [key, at] of Object.entries(fm)) stamps[key] = Math.max(Number(stamps[key]) || 0, Number(at) || 0);
  const keys = new Set([...Object.keys(server || {}), ...Object.keys(mine || {})]);
  for (const key of keys) {
    if (META.has(key)) continue;
    const ts = Number(fs[key]) || 0, tm = Number(fm[key]) || 0;
    let useMine;
    if (ts || tm) useMine = tm > ts || (tm === ts && (!base || !sameValue(mine?.[key], base?.[key])));
    else if (base) useMine = !sameValue(mine?.[key], base?.[key]) || sameValue(server?.[key], base?.[key]);
    else useMine = true;
    const from = useMine ? mine : server;
    if (from && key in from) out[key] = from[key];
  }
  // Sorted, so the same merge in either order is the same bytes (convergence).
  if (Object.keys(stamps).length) out._fieldAt = Object.fromEntries(Object.entries(stamps).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return out;
};

/**
 * `winner` stands, except for fields `loser` changed later (by their own
 * stamps). Used where one whole copy wins on time -- a stale upload, a pull
 * landing on a device with an unsent edit -- so that the edit inside the
 * losing copy is not lost with it.
 */
export const foldNewerFields = (winner, loser) => {
  if (!winner || !loser) return winner;
  const fw = fieldStampsOf(winner), fl = fieldStampsOf(loser);
  let out = null;
  for (const [key, at] of Object.entries(fl)) {
    if (META.has(key)) continue;
    if ((Number(at) || 0) <= (Number(fw[key]) || 0)) continue;
    out ??= { ...winner, _fieldAt: { ...fw } };
    if (key in loser) out[key] = loser[key]; else delete out[key];
    out._fieldAt[key] = Number(at);
  }
  return out || winner;
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
    const fields = mergeFields(server, mine, base);
    const { messages: _ignored2, updatedAt: _b, ...serverFields } = server;
    const keys = new Set([...Object.keys(fields), ...Object.keys(serverFields)]);
    const sameFields = [...keys].every(key => sameValue(fields[key], serverFields[key]));
    const sameMessages = JSON.stringify(messages) === JSON.stringify(server.messages || []);
    if (sameFields && sameMessages) return null;
    return { ...fields, messages };
  }
  const messages = uniqueMessages(serverTail.length
    ? [...prefix, ...interleave(serverTail, myTail)]
    : [...prefix, ...myTail]);
  return { ...mergeFields(server, mine, base), messages };
};
