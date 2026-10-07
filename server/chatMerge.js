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
 * ## The rule
 *
 * Messages are matched from the start. Where both have the same message, it is
 * kept once -- the longer copy when one is a message still being written in
 * the other. After the shared part:
 *
 *   - only one side has more: those are kept (nothing is lost);
 *   - both have more: both are kept, in the order they were written (`at`),
 *     each side's own order preserved.
 *
 * What a merge cannot tell apart is a message deleted on a stale device from
 * one it never received; it keeps it. Losing a deletion is the cheaper mistake.
 * Everything that is not the message list comes from the device's version,
 * which is the newer intent.
 */

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('');
  return content == null ? '' : String(content);
};

/** The same message, or one copy of it further along than the other. */
const sameMessage = (a, b) => {
  if (!a || !b || a.role !== b.role) return false;
  if (a.at != null && b.at != null && a.at !== b.at) return false;
  const x = textOf(a.content), y = textOf(b.content);
  if (x === y) return true;
  // A reply caught mid-stream on one side: the other side's copy carries on from it.
  return a.role === 'assistant' && (x.startsWith(y) || y.startsWith(x));
};

/** Of two copies of one message, the one to keep. */
const pick = (server, mine) => {
  const x = textOf(server.content), y = textOf(mine.content);
  if (x.length > y.length) return { ...mine, ...server };
  return { ...server, ...mine };
};

const stampOf = (message) => (Number.isFinite(message?.at) ? message.at : null);

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

/**
 * `server` and `mine` are chat payloads. Returns the merged chat, or null when
 * `mine` adds nothing to `server` (the server's copy should simply stand).
 */
export const mergeChats = (server, mine) => {
  if (!server || !mine) return mine || server || null;
  const s = Array.isArray(server.messages) ? server.messages : [];
  const m = Array.isArray(mine.messages) ? mine.messages : [];

  let shared = 0;
  const prefix = [];
  while (shared < s.length && shared < m.length && sameMessage(s[shared], m[shared])) {
    prefix.push(pick(s[shared], m[shared]));
    shared++;
  }
  const serverTail = s.slice(shared);
  const myTail = m.slice(shared);

  // Nothing of mine beyond what the server has: only my other fields could be news.
  if (!myTail.length) {
    const messages = [...prefix, ...serverTail];
    const { messages: _ignored, updatedAt: _a, ...myFields } = mine;
    const { messages: _ignored2, updatedAt: _b, ...serverFields } = server;
    const sameFields = JSON.stringify(myFields) === JSON.stringify(serverFields);
    const sameMessages = JSON.stringify(messages) === JSON.stringify(s);
    if (sameFields && sameMessages) return null;
    return { ...server, ...mine, messages };
  }
  const messages = serverTail.length
    ? [...prefix, ...interleave(serverTail, myTail)]
    : [...prefix, ...myTail];
  return { ...server, ...mine, messages };
};
