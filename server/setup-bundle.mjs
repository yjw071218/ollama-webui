// Moving this PC's setup to another one, so a new install behaves like this
// one without retyping keys.
//
//   node server/setup-bundle.mjs export [file]   writes ollama-webui-setup.json
//                                                (Desktop by default)
//   node server/setup-bundle.mjs import <file>   merges it into .env
//
// first-run.mjs looks for the bundle by itself (next to the app, on the
// Desktop, in Downloads) and offers to import it, so on a new PC the usual
// path is: export here, copy the file over, run the installer.
//
// Only settings that mean the same thing on any PC travel: the access token,
// social sign-in keys, search API keys, CLI and Ollama behaviour. Paths
// (FFMPEG_BIN, engine folders, TLS files) and the public address are this
// machine's own and are left out -- PUBLIC_ORIGIN is worked out again on the
// new PC. The file holds secrets (token, Kakao secret, API keys): keep it like
// a password and delete it once imported.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvValue, writeEnvValue } from './envFile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
export const BUNDLE_NAME = 'ollama-webui-setup.json';

const EXACT = [
  'ACCESS_TOKEN', 'PORT', 'TRUST_LAN',
  'VITE_GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_ID', 'VITE_KAKAO_REST_KEY', 'KAKAO_REST_KEY', 'KAKAO_CLIENT_SECRET',
  'BRAVE_API_KEY', 'TAVILY_API_KEY', 'SERPER_API_KEY', 'SEARXNG_URL',
  'OLLAMA_URL', 'OLLAMA_MANAGED', 'OLLAMA_MANAGED_FIT_TARGET', 'LLM_BACKEND', 'LLAMACPP_URL',
  'COMFYUI_URL', 'COMFYUI_PREVIEW', 'VRAM_EXCLUSIVE',
  'DB_BACKUP_ENABLED', 'DB_BACKUP_INTERVAL_MS', 'DB_BACKUP_RETENTION',
  'DUCKDNS_DOMAIN', 'DUCKDNS_TOKEN', 'TTS_PORT', 'STT_PORT', 'GPT_SOVITS_CONFIG',
];
// Whole families: CLI_* (but not *_PATH), WEB_SEARCH_*.
const portable = (key) => EXACT.includes(key)
  || (/^(CLI_|WEB_SEARCH_)/.test(key) && !/_PATH$|_ROOTS$/.test(key));

const keysIn = (text) => [...String(text).matchAll(/^[^\S\r\n]*([A-Z][A-Z0-9_]*)[^\S\r\n]*=/gm)].map(m => m[1]);

/** The portable settings of an .env text, as { KEY: value }, empties left out. */
export const pickPortable = (text) => Object.fromEntries(
  [...new Set(keysIn(text))].filter(portable)
    .map(k => [k, readEnvValue(text, k)]).filter(([, v]) => v !== ''),
);

/** `text` with the bundle's settings written in. Returns { text, keys }. */
export const applyBundle = (text, bundle) => {
  const settings = bundle?.settings && typeof bundle.settings === 'object' ? bundle.settings : {};
  let out = String(text ?? '');
  const keys = [];
  for (const [k, v] of Object.entries(settings)) {
    if (!portable(k) || typeof v !== 'string' || /[\r\n]/.test(v)) continue;
    out = writeEnvValue(out, k, v);
    keys.push(k);
  }
  return { text: out, keys };
};

export const readBundle = (file) => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data?.kind !== 'ollama-webui-setup') throw new Error(`${file} is not an Ollama WebUI setup file.`);
  return data;
};

/** Where a copied-over bundle is usually left. The first that exists. */
export const findBundle = () => [
  path.join(ROOT, BUNDLE_NAME),
  path.join(ROOT, '..', BUNDLE_NAME),
  path.join(os.homedir(), 'Desktop', BUNDLE_NAME),
  path.join(os.homedir(), 'OneDrive', 'Desktop', BUNDLE_NAME),
  path.join(os.homedir(), 'Downloads', BUNDLE_NAME),
].find(f => fs.existsSync(f)) || null;

const desktop = () => [path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'OneDrive', 'Desktop')]
  .find(d => fs.existsSync(d)) || os.homedir();

const main = () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'export') {
    const text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
    const settings = pickPortable(text);
    const file = path.resolve(arg || path.join(desktop(), BUNDLE_NAME));
    fs.writeFileSync(file, JSON.stringify({ kind: 'ollama-webui-setup', version: 1, exported: new Date().toISOString(), settings }, null, 2));
    console.log(`Exported ${Object.keys(settings).length} settings to ${file}`);
    console.log('It contains your access token and API keys: copy it to the new PC, then delete it.');
  } else if (cmd === 'import') {
    const file = arg || findBundle();
    if (!file) { console.error('No setup file given or found.'); process.exit(1); }
    const text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
    const { text: next, keys } = applyBundle(text, readBundle(file));
    fs.writeFileSync(ENV_FILE, next);
    console.log(`Imported ${keys.length} settings from ${file}`);
  } else {
    console.log('usage: node server/setup-bundle.mjs export [file] | import [file]');
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
