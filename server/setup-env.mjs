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
import { localAddresses, routedAddress } from './net.js';
import { prepareEnv, readEnvValue } from './envFile.js';
import { normaliseOrigin } from './origin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
const forNetwork = process.argv.includes('--network');
// The launcher needs the port to open a browser tab. Printing it alone keeps
// the batch file free of quoting gymnastics.
const printPortOnly = process.argv.includes('--print-port');
// And it needs to know *which address* to open, which is the whole point of
// PUBLIC_ORIGIN: opening the desktop on localhost while telling the phone to
// use a hostname is how one person ends up signed in twice with two separate
// local caches. Empty output means none is configured, and the launcher falls
// back to localhost as it always did.
const printOriginOnly = process.argv.includes('--print-origin');

const original = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf-8') : '';

if (printPortOnly) {
  process.stdout.write(readEnvValue(original, 'PORT') || '5173');
  process.exit(0);
}

if (printOriginOnly) {
  process.stdout.write(normaliseOrigin(readEnvValue(original, 'PUBLIC_ORIGIN'), {
    port: Number(readEnvValue(original, 'PORT')) || 5173,
  }));
  process.exit(0);
}

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
const port = readEnvValue(text, 'PORT') || '5173';

if (host !== '127.0.0.1' && host !== 'localhost') {
  const preferred = await routedAddress();
  const usable = localAddresses(os.networkInterfaces(), preferred).filter(e => !e.virtual);
  if (usable.length > 0) {
    console.log('');
    console.log('  On a phone on the same wifi, open:');
    for (const entry of usable) console.log(`    http://${entry.address}:${port}`);
  }

  // Said once, here, because this is the run where someone is deciding how they
  // are going to reach this thing. A hostname chosen now and used by every
  // device costs nothing; two addresses discovered later cost a second account.
  if (!readEnvValue(text, 'PUBLIC_ORIGIN') && usable.length > 0) {
    console.log('');
    console.log('  Using more than one device? Put ONE address in .env as');
    console.log('  PUBLIC_ORIGIN and open that everywhere. A browser stores chats,');
    console.log('  settings and the login cookie per origin, so two hostnames for');
    console.log('  one server means two logins and two local caches. For example:');
    console.log(`    PUBLIC_ORIGIN=http://${usable[0].address}.nip.io:${port}`);
  }
}
