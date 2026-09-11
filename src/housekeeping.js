/**
 * Which chats are worth doing something about.
 *
 * A sidebar accumulates. Four hundred conversations in, the ones that matter
 * are indistinguishable from the three hundred that were a single question
 * answered in ten seconds, and the honest reason nobody tidies is that tidying
 * means opening each one to remember what it was. That is the work this does:
 * not the deleting, the *deciding*.
 *
 * ## Conservative on purpose
 *
 * Every rule here has to be one a person would agree with before they look. A
 * suggestion that turns out to be wrong once teaches somebody to stop reading
 * the list, and a list nobody reads is worse than no list because it took up
 * the space where a real one could have been. So:
 *
 *   * Anything pinned is never suggested. Pinning is an explicit statement.
 *   * Anything containing a starred message is never suggested. So is that.
 *   * Anything in a folder is never suggested for deletion — filing it was a
 *     decision, and this is not entitled to overrule it — though it can still
 *     be suggested for archiving.
 *   * "Old" is ninety days, not thirty. A conversation from six weeks ago is
 *     one you might still be in the middle of.
 *
 * ## Suggesting, never doing
 *
 * Nothing here acts. It returns a list with reasons and numbers, and every
 * action is a button somebody presses. Archiving is offered in bulk because it
 * is reversible; deleting is offered one at a time because it is not.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Untouched for this long, and it is probably finished. */
export const STALE_DAYS = 90;
/** Past this many estimated tokens, a chat is worth splitting or compacting. */
export const HUGE_TOKENS = 24000;
/** Below this, a saving is not worth reporting as a reason to act. */
export const MEANINGFUL_TOKENS = 2000;

const estimate = (text) => {
  if (!text) return 0;
  const str = String(text);
  let wide = 0;
  for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) > 127) wide++;
  return Math.ceil((str.length - wide) / 4 + wide / 1.5);
};

export const tokensIn = (session) =>
  (session?.messages || []).reduce((sum, m) => sum + estimate(m?.content), 0);

/**
 * Chats this must never comment on.
 *
 * Each of these is somebody having already made a decision about the chat, and
 * a tidying suggestion that overrules an explicit decision is the one that
 * makes the whole list untrustworthy.
 */
export const isProtected = (session) => !!(
  session?.pinned
  || (session?.messages || []).some(m => m?.starred)
);

const touchedAt = (session) => session?.updatedAt || session?.createdAt || 0;

/** A rough fingerprint for "these two are the same conversation". */
const opening = (session) => {
  const first = (session?.messages || []).find(m => m?.role === 'user');
  return String(first?.content || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
};

/**
 * What to do about the sidebar.
 *
 * Ordered by how safe the suggestion is: empty and abandoned chats first —
 * losing one costs nothing — then duplicates, then stale, then the big ones,
 * which are a suggestion to *read* rather than to remove.
 */
export const suggestions = (sessions = [], { now = Date.now() } = {}) => {
  const live = (sessions || []).filter(s => (
    // An id is what every suggestion is acted on by. A record without one
    // would produce a row no button could do anything with.
    s && s.id !== undefined && s.id !== null
    && !s.draft && !s.archived && !isProtected(s)
  ));
  const out = [];
  const claimed = new Set();

  const claim = (session, entry) => {
    // One suggestion per chat. Three rows about the same conversation is a
    // list that looks longer than the problem it describes.
    if (claimed.has(session.id)) return;
    claimed.add(session.id);
    out.push(entry);
  };

  /* -------------------------------------------------------------- empty */
  for (const session of live) {
    if ((session.messages || []).length === 0) {
      claim(session, { kind: 'empty', id: session.id, title: session.title || '', action: 'delete' });
    }
  }

  /* ---------------------------------------------------------- abandoned */
  // A question asked and never answered: usually a send that failed, or a
  // second thought. Nothing was learned in it, so nothing is lost.
  for (const session of live) {
    const messages = session.messages || [];
    if (messages.length === 1 && messages[0]?.role === 'user') {
      claim(session, { kind: 'abandoned', id: session.id, title: session.title || '', action: 'delete' });
    }
  }

  /* ---------------------------------------------------------- duplicates */
  // Asked the same thing twice, usually because the first attempt was not
  // found. The older one is the one to keep -- it may have been continued.
  const byOpening = new Map();
  for (const session of live) {
    const key = opening(session);
    if (key.length < 20) continue;      // too short to be a fingerprint
    if (!byOpening.has(key)) byOpening.set(key, []);
    byOpening.get(key).push(session);
  }
  for (const group of byOpening.values()) {
    if (group.length < 2) continue;
    const sorted = group.slice().sort((a, b) => touchedAt(a) - touchedAt(b));
    for (const session of sorted.slice(1)) {
      claim(session, {
        kind: 'duplicate', id: session.id, title: session.title || '',
        action: 'delete', otherId: sorted[0].id, otherTitle: sorted[0].title || '',
      });
    }
  }

  /* --------------------------------------------------------------- stale */
  for (const session of live) {
    const age = Math.floor((now - touchedAt(session)) / DAY);
    if (age >= STALE_DAYS) {
      claim(session, { kind: 'stale', id: session.id, title: session.title || '', action: 'archive', days: age });
    }
  }

  /* ----------------------------------------------------------- oversized */
  // Not a suggestion to remove anything: a chat this long is one where every
  // new turn re-reads twenty thousand tokens before it writes a word.
  for (const session of live) {
    const tokens = tokensIn(session);
    if (tokens >= HUGE_TOKENS) {
      claim(session, {
        kind: 'huge', id: session.id, title: session.title || '',
        action: 'open', tokens, messages: (session.messages || []).length,
      });
    }
  }

  const rank = { empty: 0, abandoned: 1, duplicate: 2, stale: 3, huge: 4 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || (b.days || 0) - (a.days || 0));
};

/**
 * What tidying would recover, roughly.
 *
 * In tokens rather than bytes, because tokens are the unit everything else on
 * this screen is counted in — and because the number people actually care
 * about is how much of the sidebar is dead weight, not how many kilobytes it
 * occupies on a disk with a terabyte free.
 */
export const wouldRecover = (sessions = [], entries = []) => {
  const byId = new Map((sessions || []).map(s => [s.id, s]));
  let tokens = 0;
  let chats = 0;
  for (const entry of entries) {
    if (entry.action !== 'delete') continue;
    const session = byId.get(entry.id);
    if (!session) continue;
    tokens += tokensIn(session);
    chats++;
  }
  return {
    tokens,
    chats,
    /* Whether it is worth printing. "Deleting these would free about eighteen
       tokens" is true, motivates nobody, and makes the panel look like it is
       grasping for something to say. */
    worthSaying: chats > 0 && tokens >= MEANINGFUL_TOKENS,
  };
};
