#!/usr/bin/env node
/**
 * Point agy's custom status line at server/agyStatusline.mjs, so what agy
 * knows of its quota reaches the app. See that file for why.
 *
 *     npm run agy:statusline            install
 *     npm run agy:statusline -- --remove
 *
 * Only `statusLine` in ~/.gemini/antigravity-cli/settings.json is touched,
 * and only if it is not already someone else's: a status line the reader set
 * up themselves is left alone and reported. A copy of the file is kept next
 * to it first. The file is written only if it parsed -- agy itself learned
 * the hard way what overwriting a settings file it could not read does.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'agyStatusline.mjs').split(path.sep).join('/');
const FILE = process.env.AGY_SETTINGS_FILE || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
const OURS = 'agyStatusline.mjs';

const remove = process.argv.includes('--remove');

let settings = {};
if (fs.existsSync(FILE)) {
  try {
    settings = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, '')) || {};
  } catch (e) {
    console.error(`${FILE} is not valid JSON (${e.message}); leaving it alone.`);
    process.exit(1);
  }
}

const current = settings.statusLine;
const isOurs = typeof current?.command === 'string' && current.command.includes(OURS);

if (remove) {
  if (!isOurs) { console.log('No status line of ours to remove.'); process.exit(0); }
  delete settings.statusLine;
} else {
  if (current && !isOurs) {
    console.log(`agy already has a status line of your own:\n  ${JSON.stringify(current)}\nLeft as it is. Remove it first to use this one.`);
    process.exit(0);
  }
  // `node` from PATH and a path without spaces: runs whether or not agy
  // hands the command to a shell.
  settings.statusLine = { type: 'command', command: `node ${SCRIPT}`, stack_with_default: true };
}

if (fs.existsSync(FILE)) fs.copyFileSync(FILE, `${FILE}.bak-ollama-webui`);
fs.mkdirSync(path.dirname(FILE), { recursive: true });
fs.writeFileSync(FILE, `${JSON.stringify(settings, null, 2)}\n`);
console.log(remove ? `Removed the status line from ${FILE}.` : `agy's status line now reports its quota to Ollama WebUI (${FILE}).`);
