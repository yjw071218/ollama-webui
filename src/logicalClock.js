/**
 * A hybrid logical clock for everything the sync compares by time.
 *
 * ## Why
 *
 * Every record's `updatedAt` is read off the device that wrote it, and the
 * account keeps whichever write has the larger number. That is timestamp
 * ordering, and it is only correct if "larger" means "later". Between a phone
 * and a PC it does not: phones are routinely a few seconds ahead or behind, so
 * the PC could pin a chat *after* the phone last touched it and still stamp it
 * with a smaller number -- and the pin was refused as the older write. A lost
 * update, caused by nothing but two clocks disagreeing.
 *
 * ## The rule (Lamport, with the wall clock kept where it is good)
 *
 *   * Every time this device sees a stamp -- a record arriving from the
 *     account, a chat read from storage -- the clock remembers the largest.
 *   * Every new stamp is greater than both the wall clock and anything seen:
 *     `max(now, last + 1, floor + 1)`.
 *
 * So an edit made after seeing another device's edit is always stamped after
 * it (happened-before is preserved), whatever the two clocks say. Edits that
 * genuinely did not see each other are concurrent; for those the field-level
 * merge (server/chatMerge.js) decides, field by field.
 *
 * A device whose clock is wildly ahead must not drag every other device's
 * stamps a year into the future, so a stamp more than a day ahead of this
 * clock is not adopted.
 */

const FUTURE_LIMIT_MS = 24 * 60 * 60 * 1000;
let last = 0;

/** Note a stamp this device has seen (from storage or from the account). */
export const observeStamp = (at) => {
  const t = Number(at);
  if (!Number.isFinite(t) || t <= last) return;
  if (t > Date.now() + FUTURE_LIMIT_MS) return;
  last = t;
};

/** Note every chat's stamp in a list. */
export const observeChats = (list) => {
  if (!Array.isArray(list)) return;
  for (const chat of list) observeStamp(chat?.updatedAt);
};

/**
 * A new stamp: later than the wall clock, than anything seen, and than
 * `floor` (the stamp of the thing being edited).
 */
export const nextStamp = (floor = 0, now = Date.now()) => {
  const f = Number(floor);
  const t = Math.max(Number(now) || Date.now(), last + 1, Number.isFinite(f) ? f + 1 : 0);
  last = t;
  return t;
};

/** For tests: forget everything seen. */
export const resetClock = () => { last = 0; };
