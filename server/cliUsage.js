/**
 * What the CLI models have been used for, kept.
 *
 * The tally in server/cliModels.js is since the server started, and it is a
 * glance at "is this working". This is the account: one line per answer, in
 * `server/data/cli-usage.jsonl`, with whose it was, which conversation, the
 * tokens, and the price where the CLI says one (Claude Code reports what the
 * answer would have cost on the API; Codex and agy report tokens only).
 *
 * Appended, never rewritten, because more than one process writes it: the
 * server, and server/mcpDelegate.mjs when a local model hands a question to a
 * CLI. An append of one short line is safe from both; a read-modify-write of
 * a JSON file is not.
 *
 * Read back by `/cli/usage` as totals per day, per CLI and per conversation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY = 24 * 60 * 60 * 1000;
const MAX_BYTES = 8 * 1024 * 1024;       // about fifty thousand answers; older ones are dropped

const dataDir = () => (process.env.WEBUI_DATA_DIR
  ? path.resolve(process.env.WEBUI_DATA_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), 'data'));

export const usageFile = () => path.join(dataDir(), 'cli-usage.jsonl');

const finite = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null);

/** One answer, as the line kept for it. */
export const usageLine = ({
  at = Date.now(), provider, model, owner = '', chat = '', via = 'chat',
  usage = {}, ms = 0, error = '', resumed = false, fallbackFrom = '',
} = {}) => {
  const line = { at, provider, model, via };
  if (owner) line.owner = String(owner);
  if (chat) line.chat = String(chat).slice(0, 120);
  const prompt = finite(usage.prompt);
  const out = finite(usage.eval);
  const cached = finite(usage.cached);
  const cost = finite(usage.costUsd);
  if (prompt !== null) line.prompt = prompt;
  if (out !== null) line.eval = out;
  if (cached !== null && cached > 0) line.cached = cached;
  if (cost !== null) line.costUsd = Math.round(cost * 1e6) / 1e6;
  if (ms) line.ms = Math.round(ms);
  if (error) line.error = String(error).slice(0, 200);
  if (resumed) line.resumed = true;
  if (fallbackFrom) line.fallbackFrom = fallbackFrom;
  return line;
};

/* A file past its size keeps its newer half. Checked on write, rarely. */
const trim = (file) => {
  try {
    const { size } = fs.statSync(file);
    if (size <= MAX_BYTES) return;
    const text = fs.readFileSync(file, 'utf8');
    const kept = text.slice(text.length - Math.floor(MAX_BYTES / 2));
    fs.writeFileSync(file, kept.slice(kept.indexOf('\n') + 1));
  } catch { /* the next write tries again */ }
};

let writes = 0;
/** Keep one answer. Never throws: a ledger that fails must not fail the answer. */
export const recordUsage = (entry, { file = usageFile() } = {}) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(usageLine(entry))}\n`);
    if (++writes % 200 === 0) trim(file);
  } catch { /* nothing to be done about a full disk from here */ }
};

export const readUsage = ({ file = usageFile(), since = 0 } = {}) => {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const lines = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    try {
      const line = JSON.parse(raw);
      if (line && line.at >= since) lines.push(line);
    } catch { /* a line cut by a crash */ }
  }
  return lines;
};

const dayOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const blank = () => ({ runs: 0, failures: 0, prompt: 0, eval: 0, cached: 0, costUsd: 0, resumed: 0, fallbacks: 0 });
const add = (into, line) => {
  into.runs += 1;
  if (line.error) into.failures += 1;
  into.prompt += line.prompt || 0;
  into.eval += line.eval || 0;
  into.cached += line.cached || 0;
  into.costUsd += line.costUsd || 0;
  if (line.resumed) into.resumed += 1;
  if (line.fallbackFrom) into.fallbacks += 1;
  return into;
};

/**
 * The ledger folded for the settings panel: today, the last seven and thirty
 * days per CLI, a row per day, and the conversations that used the most.
 * `owner` limits it to one account; `null` is everybody's.
 */
export const summariseUsage = (lines = [], { owner = null, now = Date.now(), days = 30 } = {}) => {
  const mine = owner === null ? lines : lines.filter(l => (l.owner || '') === String(owner || ''));
  const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
  const windows = { today: startToday.getTime(), week: now - 7 * DAY, month: now - days * DAY };
  const totals = { today: {}, week: {}, month: {} };
  const byDay = new Map();
  const byChat = new Map();
  const byVia = {};
  for (const line of mine) {
    if (line.at < windows.month) continue;
    for (const [span, from] of Object.entries(windows)) {
      if (line.at < from) continue;
      totals[span][line.provider] = add(totals[span][line.provider] || blank(), line);
    }
    const day = dayOf(line.at);
    byDay.set(day, add(byDay.get(day) || blank(), line));
    byVia[line.via || 'chat'] = add(byVia[line.via || 'chat'] || blank(), line);
    if (line.chat) {
      const row = byChat.get(line.chat) || { chat: line.chat, ...blank(), last: 0, models: new Set() };
      add(row, line);
      row.last = Math.max(row.last, line.at);
      row.models.add(`${line.provider}:${line.model}`);
      byChat.set(line.chat, row);
    }
  }
  const chats = [...byChat.values()]
    .map(row => ({ ...row, models: [...row.models] }))
    .sort((a, b) => (b.costUsd - a.costUsd) || ((b.prompt + b.eval) - (a.prompt + a.eval)))
    .slice(0, 10);
  const daysList = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, v]) => ({ day, ...v }));
  return { totals, days: daysList, chats, via: byVia };
};
