/**
 * Labels on chats.
 *
 * Folders already exist and are not this. A folder is where a conversation
 * *lives* — one place, carrying its own system prompt, and moving a chat into
 * one takes it out of another. That is the right shape for "this belongs to
 * the thesis" and the wrong shape for everything a conversation is *also*
 * about: a chat can be thesis work and a Rust question and something to come
 * back to, all at once, and no hierarchy holds that.
 *
 * So tags are many-to-many, weightless, and created by typing them. There is
 * no tag manager and no list of defined tags: a tag exists because a chat
 * carries it and stops existing when the last one is removed or deleted. That
 * is a deliberate limit — a vocabulary nobody has to maintain is one that gets
 * used — and it is why `allTags` derives the list from the chats every time
 * rather than keeping a register that could drift out of step with them.
 *
 * ## Case
 *
 * Matching folds case, display does not. Typing `Rust` when `rust` already
 * exists must not make two tags; but a tag typed as `Rust` should stay `Rust`
 * on screen, because lowercasing somebody's writing is a small insult that
 * accumulates. The first spelling seen wins, which is the only rule that does
 * not depend on the order the sidebar happens to render in.
 */

export const MAX_TAG = 32;
export const MAX_PER_CHAT = 12;

/**
 * A tag as it will be stored.
 *
 * Commas and hashes come off because both are how tags get typed — `#rust` in
 * a search box, `rust, wasm` pasted from somewhere — and neither is part of
 * the name. Inner whitespace is collapsed rather than banned: "side project"
 * is a perfectly good tag and forcing "side-project" is a rule to remember.
 */
export const cleanTag = (value) => String(value ?? '')
  .replace(/[#,]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, MAX_TAG);

/** How two tags are compared. Everything that matches goes through here. */
export const tagKey = (value) => cleanTag(value).toLowerCase();

export const tagsOf = (session) =>
  (Array.isArray(session?.tags) ? session.tags : [])
    .map(cleanTag)
    .filter(Boolean);

export const hasTag = (session, tag) => {
  const key = tagKey(tag);
  return tagsOf(session).some(t => tagKey(t) === key);
};

/**
 * Add one, if it is a tag and is not already there.
 *
 * Returns the same array when nothing changed, so a re-render is not provoked
 * by typing a tag that is already on the chat.
 */
export const addTag = (session, tag) => {
  const clean = cleanTag(tag);
  if (!clean || hasTag(session, clean)) return tagsOf(session);
  const held = tagsOf(session);
  if (held.length >= MAX_PER_CHAT) return held;
  return [...held, clean];
};

export const removeTag = (session, tag) => {
  const key = tagKey(tag);
  return tagsOf(session).filter(t => tagKey(t) !== key);
};

/**
 * Every tag in use, commonest first.
 *
 * Derived rather than registered: a tag exists because a chat carries it, so
 * deleting the last chat that used one removes it, and there is never a list
 * of defined tags that has drifted out of step with the chats.
 */
export const allTags = (sessions = []) => {
  const counts = new Map();
  for (const session of sessions || []) {
    if (!session || session.draft) continue;
    for (const tag of tagsOf(session)) {
      const key = tagKey(tag);
      const held = counts.get(key);
      // First spelling seen wins, so `Rust` and `rust` are one tag and the
      // display does not flicker between them as chats are re-ordered.
      if (held) held.count++;
      else counts.set(key, { tag, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
};

/**
 * Suggestions for a half-typed tag.
 *
 * Prefix matches before substring ones: somebody typing `ru` means `rust`
 * far more often than `arduino`, and a list that puts the second first is one
 * they stop reading.
 */
export const suggest = (sessions = [], query = '', limit = 8) => {
  const key = tagKey(query);
  const all = allTags(sessions);
  if (!key) return all.slice(0, limit);

  const starts = [];
  const contains = [];
  for (const entry of all) {
    const candidate = tagKey(entry.tag);
    if (candidate === key) continue;      // already typed in full
    if (candidate.startsWith(key)) starts.push(entry);
    else if (candidate.includes(key)) contains.push(entry);
  }
  return [...starts, ...contains].slice(0, limit);
};

/**
 * The chats carrying these tags.
 *
 * `all` rather than `any` by default, because filtering is narrowing: picking
 * a second tag after the first should show fewer chats, not more. `any` is
 * available for the case where two tags mean the same thing.
 */
export const filterByTags = (sessions = [], tags = [], mode = 'all') => {
  const keys = (tags || []).map(tagKey).filter(Boolean);
  if (keys.length === 0) return sessions || [];
  return (sessions || []).filter(session => {
    const held = new Set(tagsOf(session).map(tagKey));
    return mode === 'any' ? keys.some(k => held.has(k)) : keys.every(k => held.has(k));
  });
};

/**
 * Read `#tag` out of a search box.
 *
 * The sidebar already has one box for finding a chat by name. Rather than
 * adding a second control, `#` in that box means a tag — which is how people
 * type tags anyway — and everything else stays a title search. Returns both
 * halves so the caller can apply them together: `#rust deadlock` is the chats
 * tagged rust whose titles mention a deadlock.
 */
export const parseTagQuery = (text) => {
  const tags = [];
  const rest = String(text || '')
    .replace(/#([^\s#]+)/g, (whole, tag) => {
      const clean = cleanTag(tag);
      if (clean) tags.push(clean);
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { tags, text: rest };
};

/**
 * Tags for a chat that has none, from what is in it.
 *
 * Only ever a suggestion, and only from tags that already exist: inventing
 * vocabulary is how a tag list becomes forty near-duplicates. This is the
 * cheap version -- the tag's own words appearing in the title or the first
 * exchange -- which is right for something offered as a button rather than
 * applied automatically.
 */
export const suggestForChat = (sessions = [], session = null, limit = 3) => {
  if (!session || tagsOf(session).length > 0) return [];
  const text = [
    session.title || '',
    ...(session.messages || []).slice(0, 4).map(m => m?.content || ''),
  ].join(' ').toLowerCase();
  if (!text.trim()) return [];

  return allTags(sessions)
    .filter(entry => {
      const key = tagKey(entry.tag);
      // Two characters is a real tag ("go", "ai") but one is noise that
      // matches every chat ever written.
      return key.length >= 2 && text.includes(key);
    })
    .slice(0, limit)
    .map(entry => entry.tag);
};
