// Turning a social sign-in into a server session.
//
// The point is that there stop being two separate notions of "your account".
// Signing in with Google or Kakao already proves who you are; doing it again
// with a second password for sync is the kind of thing nobody should have to
// discover in a settings tab.
//
// What matters here is that the proof is checked on the server. An identity
// posted by a browser is a claim, and accepting claims would let anyone sign in
// as anyone by typing a different email.

const TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo?id_token=';

/**
 * Verify a Google ID token.
 *
 * Google's tokeninfo endpoint does the signature check against its own keys,
 * which is the part that cannot be faked. What is left to check here is that
 * the token was issued for *this* application and has not expired — a valid
 * token for some other site is still a valid token.
 */
export const verifyGoogleIdToken = async (idToken, expectedClientId) => {
  if (!idToken) throw new Error('No Google credential was supplied.');

  const res = await fetch(TOKENINFO + encodeURIComponent(idToken), {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('Google rejected that credential.');

  const payload = await res.json();

  if (expectedClientId && payload.aud !== expectedClientId) {
    throw new Error('That credential was issued for a different application.');
  }
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) {
    throw new Error('That credential was not issued by Google.');
  }
  if (Number(payload.exp) * 1000 < Date.now()) {
    throw new Error('That credential has expired.');
  }
  if (!payload.sub) throw new Error('That credential names no account.');

  return {
    provider: 'google',
    providerId: payload.sub,
    email: (payload.email || '').toLowerCase(),
    // Only a verified address may be used to adopt an existing account.
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name: payload.name || payload.given_name || (payload.email || '').split('@')[0],
    avatar: payload.picture || null,
  };
};
