// When a chat last changed, decided in one place.
//
// `updatedAt` looks like a display detail — it is what the sidebar sorts by and
// what "2 hours ago" is read from — but it is really the sync's clock, and two
// separate mechanisms are built on it:
//
//   * This device uploads a chat only when its stamp differs from the stamp it
//     last sent (see `localChanges` in syncEngine.js). An unstamped change is
//     therefore never uploaded. Not late — never.
//   * The server keeps a record only when its stamp beats the one it holds, and
//     the same rule decides which of two devices' edits survives. An unstamped
//     change cannot win that comparison, and a tombstone it should have beaten
//     will delete it again on the next pull.
//
// So a chat edited without moving its stamp is edited in this browser and
// nowhere else, permanently. That was the state of most of the app: sending a
// message stamped the chat, and then appending the assistant's empty
// placeholder did not, nor did any token of the reply. The upload that fired a
// second after the send carried the placeholder — an assistant message with no
// content — and every upload after it skipped the chat as unchanged. The other
// device showed "Thinking..." over an empty bubble and went on showing it after
// a reload, because that was genuinely what the account held. Deleting a
// message, starring one, clearing a chat, renaming it, moving it to a folder
// and dropping a regeneration variant were all invisible for the same reason.
//
// The fix is not to remember the stamp at each of the twenty-odd places a chat
// is edited. It is to stamp where the edit happens.

/**
 * The revised chat, with an honest timestamp on it.
 *
 * Three cases, and the middle one is the whole point:
 *
 *   * The revision returned the chat it was given — nothing changed, so
 *     nothing is stamped. This is how a caller says "not this one", and
 *     stamping it anyway would upload an identical chat and let it win a
 *     conflict it should have lost.
 *   * The revision changed something but left `updatedAt` alone: the caller
 *     just edited the chat and did not think about the clock. Stamp it.
 *   * The revision set `updatedAt` itself. Leave it. A restore from the undo
 *     toast and a chat pulled from the account both carry a timestamp that
 *     means something, and overwriting it would break exactly the comparison
 *     it exists for.
 */
export const stamped = (before, after, now = Date.now()) => {
  if (!after || after === before) return before;
  return after.updatedAt === before.updatedAt ? { ...after, updatedAt: now } : after;
};

/**
 * Whether the sync would notice the difference between two versions of a chat.
 *
 * The honest statement of what `localChanges` does, and the thing worth
 * asserting in a test: not "did the object change" — every render changes the
 * object — but "would this change ever leave the browser".
 */
export const syncWouldSee = (before, after) => (before?.updatedAt || 0) !== (after?.updatedAt || 0);

/**
 * When this chat was last *talked in*.
 *
 * Distinct from `updatedAt`, and the distinction is the point. `updatedAt` is
 * the sync clock: every edit has to move it or the edit never leaves this
 * browser — moving a chat into a folder included, which is precisely the bug
 * the note at the top of this file exists to describe.
 *
 * But the sidebar reads that same number as "last message", so filing a chat
 * away jumped it to the top of the list and relabelled a three-week-old
 * conversation as "just now". Both readings are reasonable and they cannot be
 * the same field.
 *
 * Derived rather than stored: every message already carries its own `at`, so
 * there is nothing to migrate, nothing to keep in step, and no way for it to
 * drift from what the transcript actually shows. Scanned from the end because
 * messages are appended in order, so the answer is almost always the first one
 * looked at.
 *
 * Falls back to `updatedAt` for chats saved before messages carried a
 * timestamp, and to `createdAt` for a chat with nothing in it yet.
 */
export const conversationTime = (session) => {
  const messages = session?.messages;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const at = messages[i]?.at;
      if (at) return at;
    }
  }
  return session?.updatedAt || session?.createdAt || 0;
};
