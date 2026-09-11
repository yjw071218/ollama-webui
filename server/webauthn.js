// Passkeys, verified where it counts.
//
// The version this replaces did the whole ceremony in the browser: the page
// generated the challenge, the page stored the public key in IndexedDB, and the
// page checked the signature it had just asked for. Every one of those is the
// relying party's job, and a relying party that runs inside the thing it is
// authenticating is not verifying anything — anyone who can run script on the
// page can write a record into IndexedDB that says they are whoever they like.
//
// So: the challenge is minted here and can be spent once. The public key is
// stored here, against a server account. The signature is checked here, against
// that key, with the origin, the RP id, the user-presence flag and the signature
// counter all checked too. That is what makes a passkey a credential rather
// than a UI flourish.
//
// Attestation is deliberately 'none'. Verifying an attestation statement tells
// you which model of authenticator was used, which matters for an enterprise
// allow-list and not for a chat app; asking for it only adds a privacy prompt.

import crypto from 'node:crypto';
import { decode, decodeFirst } from './cbor.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/* -------------------------------------------------------------- challenges */

// In memory on purpose. A challenge is meaningful for minutes and losing them
// on a restart costs one retry; persisting them would mean a file write on
// every sign-in attempt for data that must not outlive the attempt anyway.
const pending = new Map();

const sweep = () => {
  const now = Date.now();
  for (const [id, entry] of pending) if (entry.expiresAt <= now) pending.delete(id);
};

/**
 * Mint a challenge and hand back an id for it.
 *
 * The id goes to the browser and comes back with the credential; the challenge
 * bytes are matched here. Nothing the browser says about which challenge it
 * answered is taken on trust — the id names a record we wrote.
 */
export const issueChallenge = (kind, meta = {}) => {
  sweep();
  const id = crypto.randomBytes(16).toString('base64url');
  const challenge = crypto.randomBytes(32);
  pending.set(id, { kind, challenge, meta, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return { id, challenge: challenge.toString('base64url') };
};

/** Spend a challenge. A second attempt with the same id finds nothing. */
export const consumeChallenge = (id, kind) => {
  sweep();
  const entry = pending.get(String(id || ''));
  if (!entry || entry.kind !== kind) return null;
  pending.delete(id);
  return entry;
};

/* ---------------------------------------------------------------- COSE keys */

const COSE = { KTY: 1, ALG: 3, CRV: -1, X: -2, Y: -3, N: -1, E: -2 };
const KTY = { OKP: 1, EC2: 2, RSA: 3 };

const CURVES = { 1: 'P-256', 2: 'P-384', 3: 'P-521', 6: 'Ed25519' };

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

/**
 * A COSE key as a JWK, which is the form Node's crypto can import directly.
 *
 * Only the algorithms an authenticator actually offers are handled: ES256 is
 * what every platform authenticator produces, RS256 is what Windows Hello used
 * to, and Ed25519 turns up on some security keys.
 */
export const coseToJwk = (cose) => {
  const get = (key) => cose.get(key);
  const kty = get(COSE.KTY);
  const alg = get(COSE.ALG);

  if (kty === KTY.EC2) {
    const curve = CURVES[get(COSE.CRV)];
    if (!curve || curve === 'Ed25519') throw new Error('Unsupported passkey curve.');
    return { jwk: { kty: 'EC', crv: curve, x: b64url(get(COSE.X)), y: b64url(get(COSE.Y)) }, alg };
  }
  if (kty === KTY.RSA) {
    return { jwk: { kty: 'RSA', n: b64url(get(COSE.N)), e: b64url(get(COSE.E)) }, alg };
  }
  if (kty === KTY.OKP) {
    if (CURVES[get(COSE.CRV)] !== 'Ed25519') throw new Error('Unsupported passkey curve.');
    return { jwk: { kty: 'OKP', crv: 'Ed25519', x: b64url(get(COSE.X)) }, alg };
  }
  throw new Error('Unsupported passkey key type.');
};

const publicKeyFrom = (jwk) => crypto.createPublicKey({ key: jwk, format: 'jwk' });

/**
 * Check a signature the way the algorithm identifier says to.
 *
 * ECDSA signatures arrive DER-encoded, which is what Node expects by default,
 * so unlike the browser's WebCrypto there is no r||s repacking to get wrong.
 */
const verifySignature = ({ jwk, alg, data, signature }) => {
  const key = publicKeyFrom(jwk);
  if (alg === -8) return crypto.verify(null, data, key, signature);          // EdDSA
  if (alg === -7) return crypto.verify('sha256', data, key, signature);      // ES256
  if (alg === -35) return crypto.verify('sha384', data, key, signature);     // ES384
  if (alg === -36) return crypto.verify('sha512', data, key, signature);     // ES512
  if (alg === -257) return crypto.verify('sha256', data, key, signature);    // RS256
  if (alg === -258) return crypto.verify('sha384', data, key, signature);
  if (alg === -259) return crypto.verify('sha512', data, key, signature);
  throw new Error(`Unsupported passkey algorithm ${alg}.`);
};

/** The algorithms offered at registration, best first. */
export const SUPPORTED_ALGORITHMS = [-7, -257, -8];

/* ------------------------------------------------------- authenticator data */

const FLAG = { UP: 0x01, UV: 0x04, AT: 0x40, ED: 0x80 };

export const parseAuthenticatorData = (buffer) => {
  const data = Buffer.from(buffer);
  if (data.length < 37) throw new Error('Malformed authenticator data.');

  const rpIdHash = data.subarray(0, 32);
  const flags = data[32];
  const signCount = data.readUInt32BE(33);

  const parsed = {
    rpIdHash,
    flags,
    signCount,
    userPresent: !!(flags & FLAG.UP),
    userVerified: !!(flags & FLAG.UV),
    credential: null,
  };

  if (flags & FLAG.AT) {
    if (data.length < 55) throw new Error('Malformed attested credential data.');
    const credentialIdLength = data.readUInt16BE(53);
    const credentialId = data.subarray(55, 55 + credentialIdLength);
    if (credentialId.length !== credentialIdLength) throw new Error('Malformed credential id.');
    // The COSE key runs to the end of the buffer unless extensions follow it,
    // so it is decoded rather than sliced at a known length.
    const { value: cose } = decodeFirst(data.subarray(55 + credentialIdLength));
    parsed.credential = {
      aaguid: data.subarray(37, 53).toString('hex'),
      credentialId,
      cose,
    };
  }

  return parsed;
};

/* ------------------------------------------------------------ client data */

/**
 * The bits of clientDataJSON that are the relying party's to check.
 *
 * `origin` is the one that matters most and is the one a browser-side check
 * cannot make meaningfully: it is the browser's own statement about which site
 * the user was on when they approved this.
 */
const checkClientData = (clientDataJSON, { type, challenge, origins }) => {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(clientDataJSON).toString('utf8'));
  } catch (e) {
    throw new Error('Malformed client data.');
  }

  if (parsed.type !== type) throw new Error('That credential answers a different ceremony.');

  const expected = Buffer.from(challenge).toString('base64url');
  const presented = String(parsed.challenge || '');
  if (presented.length !== expected.length
      || !crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) {
    throw new Error('That credential answers a different challenge.');
  }

  if (origins.length && !origins.includes(parsed.origin)) {
    throw new Error(`That credential was created on ${parsed.origin}.`);
  }

  return parsed;
};

const rpIdMatches = (rpIdHash, rpId) =>
  crypto.createHash('sha256').update(rpId).digest().equals(Buffer.from(rpIdHash));

/* ------------------------------------------------------------- registration */

/**
 * Turn a freshly created credential into something storable.
 *
 * What comes back is the record the account keeps: the credential id the
 * browser will present, the public key to check its signatures against, and the
 * counter to compare future assertions with.
 */
export const verifyRegistration = ({
  challenge, attestationObject, clientDataJSON, rpId, origins = [],
}) => {
  checkClientData(clientDataJSON, { type: 'webauthn.create', challenge, origins });

  const attestation = decode(Buffer.from(attestationObject));
  const authData = attestation.get('authData');
  if (!authData) throw new Error('The attestation carries no authenticator data.');

  const parsed = parseAuthenticatorData(authData);
  if (!rpIdMatches(parsed.rpIdHash, rpId)) throw new Error('That credential belongs to another site.');
  if (!parsed.userPresent) throw new Error('The authenticator reported no user present.');
  if (!parsed.credential) throw new Error('The attestation carries no credential.');

  const { jwk, alg } = coseToJwk(parsed.credential.cose);
  // Importing it now means a key that cannot be used is rejected at
  // registration rather than at the first sign-in, when it is far more
  // confusing.
  publicKeyFrom(jwk);

  return {
    credentialId: parsed.credential.credentialId.toString('base64url'),
    publicKeyJwk: jwk,
    algorithm: alg,
    signCount: parsed.signCount,
    aaguid: parsed.credential.aaguid,
    userVerified: parsed.userVerified,
    createdAt: Date.now(),
  };
};

/* --------------------------------------------------------------- assertion */

/**
 * Check an assertion against a stored credential.
 *
 * The signature covers the authenticator data and a hash of the client data,
 * which is what binds "this key signed something" to "this key signed *this*
 * challenge, on *this* origin, for *this* site".
 */
export const verifyAssertion = ({
  challenge, credential, authenticatorData, clientDataJSON, signature, rpId, origins = [],
}) => {
  checkClientData(clientDataJSON, { type: 'webauthn.get', challenge, origins });

  const parsed = parseAuthenticatorData(authenticatorData);
  if (!rpIdMatches(parsed.rpIdHash, rpId)) throw new Error('That credential belongs to another site.');
  if (!parsed.userPresent) throw new Error('The authenticator reported no user present.');

  const clientDataHash = crypto.createHash('sha256').update(Buffer.from(clientDataJSON)).digest();
  const signedData = Buffer.concat([Buffer.from(authenticatorData), clientDataHash]);

  const valid = verifySignature({
    jwk: credential.publicKeyJwk,
    alg: credential.algorithm,
    data: signedData,
    signature: Buffer.from(signature),
  });
  if (!valid) throw new Error('That signature does not match the stored key.');

  // A counter that has not moved is how a cloned authenticator shows itself.
  // Plenty of passkeys legitimately report zero forever — a synced credential
  // has no single device to count on — so zero is exempt and anything else has
  // to increase.
  if (parsed.signCount !== 0 && parsed.signCount <= (credential.signCount || 0)) {
    throw new Error('That credential looks cloned; its counter went backwards.');
  }

  return { signCount: parsed.signCount, userVerified: parsed.userVerified };
};

export const _resetForTests = () => { pending.clear(); };
