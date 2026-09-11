/**
 * A chat that nobody has said anything in yet.
 *
 * Pressing "new chat" used to create a conversation: a row appeared in the
 * sidebar, it was written to storage, and it was uploaded to the account —
 * before a single word had been typed. Open the app, glance at it, close it,
 * and you had made a chat. Do that on a phone and a laptop and you had made
 * two, and they synced to each other. The list filled up with "New Chat, New
 * Chat, New Chat" and the only way to get rid of them was to delete them one
 * by one.
 *
 * A conversation should begin when somebody starts one. So pressing the button
 * now opens a *draft*: it is the chat on screen, it can be typed into, it can
 * hold attachments and a model choice — and it does not exist anywhere else
 * until the first message is sent.
 *
 * The flag is explicit rather than inferred from `messages.length === 0`,
 * because those are two different states. Clearing a chat's messages leaves a
 * real conversation that happens to be empty: it has a title somebody chose, a
 * folder, a place in the list, and it must stay in storage. A draft has never
 * been anything. Inferring would silently delete the first kind along with the
 * second.
 */

/*
 * A chat id that is not already taken.
 *
 * `Date.now()` was the id, and three clicks of "new chat" inside one
 * millisecond produced three chats sharing one. Nothing complained: they were
 * invisible drafts. Then the first message was sent, `reviseSession` matched
 * on the id and wrote the message into all three, and the sidebar grew three
 * identical rows -- while storage, which keys by id, held one. A duplicate id
 * is not a display bug; it means two records that can never be told apart
 * again.
 *
 * Still a number, and still ascending, because ids are compared with === all
 * over the app and sorted on in a few places. It just cannot repeat.
 */
let lastId = 0;
export const nextSessionId = () => {
  const now = Date.now();
  lastId = now > lastId ? now : lastId + 1;
  return lastId;
};

/** Is this the chat nobody has spoken in yet? */
export const isDraft = (session) => !!session?.draft;

/** A new draft, ready to be typed into. */
export const newDraft = (model = '') => ({
  id: nextSessionId(),
  title: 'New Chat',
  messages: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  lastModel: model,
  draft: true,
});

/**
 * What the first message does to it.
 *
 * Spread over the chat rather than deleting the key, because `undefined`
 * survives a spread and `delete` on a frozen object does not. The record is
 * about to be written to storage, where `draft: undefined` and no key at all
 * are the same thing — JSON.stringify drops it either way.
 */
export const promoted = (session) => ({ ...session, draft: undefined });

/**
 * Drafts other than the one on screen.
 *
 * Pressing "new chat" three times in a row should leave one draft, not three.
 * They are invisible and unsaved either way, but an array that grows every
 * time a button is pressed is a leak whether or not anybody can see it.
 */
export const withoutStaleDrafts = (sessions, keepId) =>
  (sessions || []).filter(s => !isDraft(s) || s.id === keepId);

/** What is safe to write to storage and send to the account. */
export const persistable = (sessions) => (sessions || []).filter(s => !isDraft(s));
