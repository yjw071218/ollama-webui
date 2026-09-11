// Which account's data is in view.
//
// Every store keys off this, so getting it wrong is not a display bug. The
// version this replaces took two arguments — a server account and a browser-
// local profile — and picked whichever was present. That is where the data
// mixing came from, because during boot the local one was present immediately
// and the server one arrived a round trip later, so the same browser produced
// two different scopes seconds apart and wrote chats into both.
//
// There is one input now: the account the server says is signed in. And there
// are three outcomes, not two, because "we have not asked yet" is a real state
// and pretending it means "signed out" is exactly what pointed a signed-in
// person at the guest's storage.

/** Identity is not yet known. Nothing account-scoped may be read or written. */
export const SCOPE_UNKNOWN = null;

/** The guest: signed out, on this browser. Keeps the original bare keys. */
export const SCOPE_GUEST = '';

/**
 * The scope for a session.
 *
 * `status` is the session provider's, and must be 'ready' before this means
 * anything. The prefix is kept from the previous scheme so an account that was
 * already syncing keeps the bucket its chats are already in.
 */
export const deriveScope = (user, status = 'ready') => {
  if (status !== 'ready') return SCOPE_UNKNOWN;
  return user?.id ? `srv-${user.id}` : SCOPE_GUEST;
};

/** Whether a scope names something that can be read from and written to. */
export const isResolved = (scope) => scope !== SCOPE_UNKNOWN;

/** True when the two describe different people's data. */
export const scopeChanged = (before, after) => before !== after;

/**
 * The account id a scope names, or null for the guest.
 *
 * This is what a state payload is stamped with, and what the server checks that
 * stamp against. Deriving it from the scope rather than from a separate
 * variable is deliberate: the two cannot then drift, and drift is what put one
 * account's chats into another's file.
 */
export const ownerOfScope = (scope) => {
  if (!scope || scope === SCOPE_UNKNOWN) return null;
  return scope.startsWith('srv-') ? scope.slice(4) : null;
};

/**
 * Whether a payload may be applied to a scope.
 *
 * The client-side half of the server's owner check. A pull that arrives for a
 * different account than the one on screen is discarded, not merged: by the
 * time the payload is here the only thing merging can do is put one person's
 * chats in another person's list.
 */
export const mayApplyState = (scope, payloadOwnerId) => {
  const owner = ownerOfScope(scope);
  if (!owner) return false;                     // the guest syncs nothing
  if (!payloadOwnerId) return true;             // an older, unstamped payload
  return payloadOwnerId === owner;
};
