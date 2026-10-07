// Whether a coding CLI is signed in, read from the credentials it keeps.
//
// Shared by the server (cliModels.js signInOf, /cli/doctor) and the launcher's
// first run (first-run.mjs), so both say the same thing.
//
// A file merely existing is not a sign-in. The agy installer (and Gemini CLI)
// leave ~/.gemini/google_accounts.json as {"active": null, "old": []} before
// anybody has logged in, and the first run took that for "already signed in"
// and skipped the login. Each file is now read and must hold a credential.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const filled = (v) => typeof v === 'string' && v.trim().length > 0;

/* What a real credential looks like in each file. A file not listed here
   counts when it is non-empty JSON. */
const VALID = {
  // Claude Code: an OAuth token under claudeAiOauth (or a bare apiKey).
  '.credentials.json': (d) => filled(d?.claudeAiOauth?.accessToken) || filled(d?.claudeAiOauth?.refreshToken) || filled(d?.apiKey),
  // Codex: ChatGPT tokens, or an API key it saved.
  'auth.json': (d) => filled(d?.tokens?.refresh_token) || filled(d?.tokens?.access_token) || filled(d?.OPENAI_API_KEY),
  // agy / Gemini: a refresh token is what survives a restart.
  'oauth_creds.json': (d) => filled(d?.refresh_token),
  // The account picker: only a chosen account means someone logged in.
  'google_accounts.json': (d) => filled(d?.active),
};

/** True when `file` (an absolute path) holds a usable credential. */
export const credentialIn = (file) => {
  const data = readJson(file);
  if (!data || typeof data !== 'object' || !Object.keys(data).length) return false;
  const check = VALID[path.basename(file)];
  return check ? !!check(data) : true;
};

/** The first credentials file, of `authFiles` ([['.dir', 'name'], ...]), that holds one. */
export const signedInFile = (authFiles = [], home = os.homedir()) => (authFiles || [])
  .map(parts => path.join(home, ...parts))
  .find(credentialIn) || null;
