// Makes .env ready to serve on the local network, without anyone editing it.
//
// The server refuses to bind beyond loopback without a token, which is right,
// but it would mean a first run of start_ollama_webui.bat stopping with an
// error. This fills in what is missing and leaves anything already set alone.
//
// Pass --network (the launcher does) to also move a loopback HOST to 0.0.0.0.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { localAddresses } from './net.js';
import { prepareEnv, readEnvValue } from './envFile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
const forNetwork = process.argv.includes('--network');

const original = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf-8') : '';

const { text, notes } = prepareEnv(original, {
  forNetwork,
  makeToken: () => crypto.randomBytes(24).toString('base64url'),
});

if (text !== original) fs.writeFileSync(ENV_FILE, text);

if (notes.length > 0) {
  console.log('Set up .env:');
  for (const note of notes) {
    const shown = note.value === null ? '(generated)' : note.value;
    console.log(`  ${note.key}=${shown}${note.why ? `   ${note.why}` : ''}`);
  }
} else {
  console.log('.env already configured.');
}

const host = readEnvValue(text, 'HOST') || '0.0.0.0';
const port = readEnvValue(text, 'PORT') || '8080';

if (host !== '127.0.0.1' && host !== 'localhost') {
  const addresses = localAddresses(os.networkInterfaces());
  if (addresses.length > 0) {
    console.log('');
    console.log('  On a phone on the same wifi, open:');
    for (const address of addresses) console.log(`    http://${address}:${port}`);
  }
}
