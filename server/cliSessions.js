/**
 * Picking a CLI conversation back up instead of sending it all again.
 *
 * ## Why
 *
 * Each answer from a CLI model is a fresh process, and the conversation goes
 * to it as one long transcript (see `toPrompt` in server/cliModels.js). That
 * keeps the app the only owner of the history, and it costs: turn twenty
 * sends turns one to nineteen again, as one new user message, so nothing of
 * it can be read from the provider's prompt cache -- the cache matches a
 * prefix of *messages*, and a transcript that grew by one turn inside a
 * single message shares no message with the last one. On a subscription that
 * is quota spent re-reading what was already read.
 *
 * Each CLI can resume a session of its own (Claude Code `--resume`, Codex
 * `thread/resume`, agy `--conversation`), and a resumed session is sent as
 * the messages it was, so the provider's cache does its job.
 *
 * ## The drift, and why this does not suffer from it
 *
 * A CLI session is a second copy of the history, and the reason the app did
 * not use them is that the copies drift: a message edited, an answer
 * regenerated, a turn deleted. So a session is looked up by the history
 * itself. After an answer, the conversation *including that answer* is hashed
 * and the session remembered under the hash. The next request is split at its
 * last assistant message; if everything up to there hashes to a remembered
 * session, only what came after it is sent. Anything changed -- an edit, a
 * regeneration, a different model -- is a different hash, and the turn is
 * sent whole as before. Nothing here can make an answer see a history the
 * reader does not.
 *
 *     CLI_RESUME=false              never resume (every turn sent whole)
 *     CLI_RESUME=claude-code,codex  only these
 *     CLI_RESUME_TTL_HOURS=72       forget a session after this long
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stripThinking } from '../src/codeAware.js';

const RESUMABLE = ['claude-code', 'codex', 'agy'];
const MAX_ENTRIES = 500;
const DEFAULT_TTL_HOURS = 72;

const listOf = (value) => String(value || '').split(',').map(s => s.trim()).filter(Boolean);

/** Whether this CLI's sessions are resumed, by `CLI_RESUME`. */
export const resumeEnabled = (providerId, env = {}) => {
  const value = String(env.CLI_RESUME ?? '').trim().toLowerCase();
  if (['false', '0', 'off', 'no', 'none'].includes(value)) return false;
  if (!value || ['true', '1', 'on', 'yes', 'all'].includes(value)) return RESUMABLE.includes(providerId);
  return listOf(value).includes(providerId);
};

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('');
  return content == null ? '' : String(content);
};

/* The text as it matters: the app strips reasoning and tidies whitespace on
   the way out, and a hash that broke on a trailing newline would never hit. */
const normal = (content) => stripThinking(textOf(content))
  .replace(/\s+/g, ' ')
  .trim();

/* The app's system prompt states the current time to the millisecond
   ("Current date and time: 2026-10-03T10:58:39.385Z"), so hashed as it is,
   no conversation ever matched its own next turn: nothing resumed, and every
   turn went out as a flattened transcript in which the earlier answers'
   tool calls are invisible. In instructions, a date-time counts as its date. */
const DATE_TIME = /(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const instructionText = (content) => normal(content).replace(DATE_TIME, '$1');

/** One conversation, as a key: which CLI and model, and every message in it. */
export const historyKey = (providerId, model, messages = []) => {
  const shape = (messages || []).filter(Boolean).map(m => [
    m.role || 'user',
    m.role === 'system' || m.role === 'developer' ? instructionText(m.content) : normal(m.content),
    Array.isArray(m.images) ? m.images.length : 0,
  ]);
  return crypto.createHash('sha256').update(JSON.stringify([providerId, model, shape])).digest('hex');
};

/**
 * The request split where a session could take over: everything up to and
 * including the last assistant message, and what came after it. Null when
 * there is no earlier answer, or nothing after it to answer.
 */
export const splitForResume = (messages = []) => {
  const list = (messages || []).filter(Boolean);
  let last = -1;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].role === 'assistant') { last = i; break; }
  if (last < 0) return null;
  const tail = list.slice(last + 1);
  if (!tail.some(m => m.role === 'user' || m.role === 'tool')) return null;
  return { prefix: list.slice(0, last + 1), tail };
};

const LABEL = { user: 'User', tool: 'Tool result', system: 'System instruction', developer: 'Developer instruction' };

/**
 * What a resumed session is sent: the new messages only. One user message is
 * sent as itself; a tool result or an instruction placed after the history is
 * labelled, as the transcript would have labelled it.
 */
export const tailRequest = (tail = [], { formatInstruction = '' } = {}) => {
  const turns = tail.filter(Boolean);
  let lastUser = -1;
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === 'user') { lastUser = i; break; }
  const images = lastUser >= 0
    ? (turns[lastUser].images || []).map(i => String(i || '').replace(/^data:[^;]+;base64,/, '')).filter(Boolean)
    : [];
  let prompt;
  if (turns.length === 1 && turns[0].role === 'user') {
    prompt = textOf(turns[0].content);
  } else {
    prompt = [
      ...turns.map(t => `[${LABEL[t.role] || 'User'}]\n${textOf(t.content)}`),
      '',
      'Write your next message in reply to the above.',
    ].join('\n\n').trim();
  }
  if (formatInstruction) prompt = `${prompt}\n\n${formatInstruction}`;
  return { prompt, images };
};

/* ------------------------------------------------------------- the store

   On disk, so a restart does not cost every open conversation its next turn
   sent whole. Small: a hash, an id and a time per answer, the newest kept. */

const dataDir = () => (process.env.WEBUI_DATA_DIR
  ? path.resolve(process.env.WEBUI_DATA_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), 'data'));

export const createSessionStore = ({ file = () => path.join(dataDir(), 'cli-sessions.json'), now = Date.now } = {}) => {
  let entries = null;
  const load = () => {
    if (entries) return entries;
    try { entries = JSON.parse(fs.readFileSync(file(), 'utf8')) || {}; } catch { entries = {}; }
    return entries;
  };
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), JSON.stringify(entries));
    } catch { /* kept in memory until the next write works */ }
  };
  const ttlOf = (env) => {
    const hours = Number(env?.CLI_RESUME_TTL_HOURS);
    return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_TTL_HOURS) * 3600 * 1000;
  };
  return {
    /** The session remembered for this history, or null. */
    find(key, env = {}) {
      const entry = load()[key];
      if (!entry) return null;
      if (now() - entry.at > ttlOf(env)) return null;
      return entry;
    },
    remember(key, { id, provider }) {
      if (!key || !id) return;
      const all = load();
      all[key] = { id: String(id), provider, at: now() };
      const keys = Object.keys(all);
      if (keys.length > MAX_ENTRIES) {
        keys.sort((a, b) => all[a].at - all[b].at);
        for (const old of keys.slice(0, keys.length - MAX_ENTRIES)) delete all[old];
      }
      save();
    },
    /** A session that would not resume is not offered again. */
    forget(key) {
      const all = load();
      if (all[key]) { delete all[key]; save(); }
    },
    size: () => Object.keys(load()).length,
  };
};

export const sessions = createSessionStore();
