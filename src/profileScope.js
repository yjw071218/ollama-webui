// Which profile's data is in view.
//
// Every store keys off this, so getting it wrong is not a display bug: signing
// out while it still named the account meant the guest read, wrote and deleted
// the account's chats, and the sync then uploaded those deletions.
//
// It lives in its own file so the rule can be tested rather than inferred from
// a ternary in the middle of a component.

/**
 * The scope for a signed-in state.
 *
 * The server account wins when there is one, because that identifier is the
 * same in every browser and is what makes a profile portable. The local profile
 * is next. Neither means guest, whose data is stored under the bare keys.
 *
 * `serverUser` must be cleared when the local profile signs out. A server
 * session that outlives the sign-in is how the guest ends up looking at someone
 * else's history.
 */
export const deriveScope = (serverUser, localUser) => {
  if (serverUser?.id) return `srv-${serverUser.id}`;
  if (localUser?.id) return String(localUser.id);
  return '';
};

/** True when the two states describe different people's data. */
export const scopeChanged = (before, after) => before !== after;

/**
 * Whether a server session may be kept when the local profile becomes `next`.
 *
 * Signing out, or switching to a different person, must not leave the previous
 * account's session attached — everything downstream reads the scope, so a
 * stale session silently redirects one person's writes into another's store.
 */
export const mayKeepServerSession = (serverUser, nextLocalUser) => {
  if (!serverUser) return false;
  if (!nextLocalUser) return false;            // guest never keeps an account
  // The same person: the local profile that the account was linked from.
  return !!nextLocalUser.id;
};
