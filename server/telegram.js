// Talking to the account from Telegram.
//
// The server can already answer a conversation with no browser open
// (server/turns.js) and already knows the account's memories and library
// (server/accountContext.js). A bot is the missing front door: the phone's
// messenger instead of opening the PWA, and somewhere for a scheduled answer
// ("summarise the news every morning") to arrive as a notification with the
// text in it.
//
// Each linked Telegram chat talks into one of the account's conversations, so
// everything said there is also in the app, synced, like any other chat.
//
// Setup is one line in .env -- TELEGRAM_BOT_TOKEN from @BotFather -- and a
// link made in Settings: the app shows a one-time code (as a t.me deep link),
// and sending it to the bot ties that Telegram chat to the account. Nothing
// else can talk to the bot: an unlinked chat is told how to link and nothing
// more, so a stranger who finds the bot cannot use the machine's models.
//
// Long polling, not a webhook: a webhook needs a public HTTPS address, and
// this server usually has neither.
//
// Commands:  /new   start a new conversation
//            /model <name>   answer with that model (no name: show it)
//            /unlink         forget this Telegram chat

import crypto from 'node:crypto';
import { database } from './db.js';
import { applyChanges } from './records.js';
import { publishRev } from './liveSync.js';
import { runServerTurn } from './turns.js';
import { accountContext, accountDefaultModel } from './accountContext.js';
import { stripThinking } from '../src/codeAware.js';

const API = 'https://api.telegram.org';
const MAX_MESSAGE = 4000;         // Telegram's limit is 4096; leave room.
const CODE_TTL_MS = 10 * 60 * 1000;

// ------------------------------------------------------------------ links

/* One-time link codes, in memory: they live ten minutes, and a restart
   losing them costs one more tap in Settings. */
const codes = new Map();

export const makeLinkCode = (userId, now = Date.now()) => {
  for (const [code, entry] of codes) if (entry.expires < now) codes.delete(code);
  const code = crypto.randomBytes(9).toString('base64url');
  codes.set(code, { userId, expires: now + CODE_TTL_MS });
  return code;
};

export const redeemLinkCode = (code, now = Date.now()) => {
  const entry = codes.get(String(code || ''));
  codes.delete(String(code || ''));
  return entry && entry.expires >= now ? entry.userId : null;
};

export const linkFor = (tgChatId) => database()
  .prepare('SELECT tg_chat_id, user_id, chat_id, model FROM telegram_links WHERE tg_chat_id = ?')
  .get(String(tgChatId)) || null;

export const linksOf = (userId) => database()
  .prepare('SELECT tg_chat_id AS tgChatId, chat_id AS chatId, model, created_at AS createdAt FROM telegram_links WHERE user_id = ? ORDER BY created_at')
  .all(userId);

export const unlink = (userId, tgChatId) => Number(database()
  .prepare('DELETE FROM telegram_links WHERE user_id = ? AND tg_chat_id = ?')
  .run(userId, String(tgChatId)).changes) > 0;

/** A new, empty conversation for the account, written like any other chat. */
export const newChat = (userId, title, now = Date.now()) => {
  const id = now;
  const payload = { id, title, messages: [], createdAt: now, updatedAt: now, source: 'telegram' };
  const result = applyChanges(userId, { records: [{ kind: 'chat', id: String(id), updatedAt: now, payload }] });
  if (result.applied > 0) publishRev(userId, result.rev, 'server');
  return String(id);
};

const link = (tgChatId, userId, chatId, now = Date.now()) => database().prepare(`
  INSERT INTO telegram_links (tg_chat_id, user_id, chat_id, model, created_at) VALUES (?,?,?,'',?)
  ON CONFLICT (tg_chat_id) DO UPDATE SET user_id = excluded.user_id, chat_id = excluded.chat_id
`).run(String(tgChatId), userId, chatId, now);

const setChat = (tgChatId, chatId) =>
  database().prepare('UPDATE telegram_links SET chat_id = ? WHERE tg_chat_id = ?').run(chatId, String(tgChatId));
const setModel = (tgChatId, model) =>
  database().prepare('UPDATE telegram_links SET model = ? WHERE tg_chat_id = ?').run(model, String(tgChatId));

/** Long text as Telegram-sized pieces, cut at paragraph, line or space. */
export const splitMessage = (text, max = MAX_MESSAGE) => {
  const out = [];
  let rest = String(text || '').trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
};

/** What a model wrote, as text for a messenger: no reasoning, no tool tags. */
export const forMessenger = (answer) => stripThinking(String(answer || ''))
  .replace(/<TOOL_[A-Z_]+(\s+[^>]*)?>[\s\S]*?(<\/TOOL_[A-Z_]+>|$)/gi, '')
  .trim();

// ---------------------------------------------------------------- the bot

let bot = null;

/**
 * Handle one incoming message. Exported for tests: `send(chatId, text)` and
 * `turn(args)` stand in for Telegram and the model.
 */
export const handleMessage = async (message, { send, turn, typing = async () => {}, env = {}, beforeInference, now = Date.now } = {}) => {
  const tgChatId = message?.chat?.id;
  const text = String(message?.text || '').trim();
  if (tgChatId == null) return;

  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(text);
  if (start) {
    const userId = start[1] ? redeemLinkCode(start[1], now()) : null;
    if (!userId) {
      return send(tgChatId, 'To use this bot, open the web UI → Settings → Account → Telegram and press "Link", then open the link it gives you.');
    }
    const existing = linkFor(tgChatId);
    const chatId = existing && existing.user_id === userId ? existing.chat_id : newChat(userId, 'Telegram', now());
    link(tgChatId, userId, chatId, now());
    return send(tgChatId, 'Linked. Anything you write here is answered by your models and saved in the web UI as the "Telegram" conversation. /new starts a fresh one, /model picks a model.');
  }

  const linked = linkFor(tgChatId);
  if (!linked) return send(tgChatId, 'This chat is not linked to an account. Link it from the web UI: Settings → Account → Telegram.');

  if (/^\/new(?:@\w+)?$/.test(text)) {
    setChat(tgChatId, newChat(linked.user_id, 'Telegram', now()));
    return send(tgChatId, 'New conversation started.');
  }
  const model = /^\/model(?:@\w+)?(?:\s+(.+))?$/.exec(text);
  if (model) {
    if (model[1]) { setModel(tgChatId, model[1].trim()); return send(tgChatId, `Model: ${model[1].trim()}`); }
    return send(tgChatId, `Model: ${linked.model || accountDefaultModel(linked.user_id) || '(none set)'}`);
  }
  if (/^\/unlink(?:@\w+)?$/.test(text)) {
    unlink(linked.user_id, tgChatId);
    return send(tgChatId, 'Unlinked. The conversation stays in the web UI.');
  }
  if (!text) return send(tgChatId, 'Only text messages are understood here for now.');
  if (text.startsWith('/')) return send(tgChatId, 'Commands: /new, /model <name>, /unlink');

  await typing(tgChatId);
  const result = await turn({
    owner: linked.user_id,
    chatId: linked.chat_id,
    prompt: text,
    model: linked.model || accountDefaultModel(linked.user_id),
    extraSystem: accountContext(linked.user_id, text),
    origin: 'telegram',
    env,
    beforeInference,
  });
  if (!result.ok && !result.answer) return send(tgChatId, `Could not answer: ${result.error}`);
  for (const piece of splitMessage(forMessenger(result.answer) || '(empty answer)')) await send(tgChatId, piece);
};

/**
 * Start polling, when TELEGRAM_BOT_TOKEN is set. Returns a stop function.
 * Started by server/index.js, not by createApiRoutes, for the same reason as
 * the schedule runner: tests must not leave a poller behind.
 */
export const startTelegramBot = (env = {}, { beforeInference, log = console.log, fetchImpl = fetch } = {}) => {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token || bot) return () => {};
  const call = async (method, body, timeoutMs = 20000) => {
    const res = await fetchImpl(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.description || `Telegram HTTP ${res.status}`);
    return data.result;
  };
  const send = (chatId, text) => call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true })
    .catch(e => log(`[telegram] send failed: ${e.message}`));
  const typing = (chatId) => call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

  // One conversation answers one message at a time, in order.
  const queues = new Map();
  const enqueue = (chatId, job) => {
    const next = (queues.get(chatId) || Promise.resolve()).then(job, job).catch(e => log(`[telegram] ${e.message}`));
    queues.set(chatId, next);
    next.finally(() => { if (queues.get(chatId) === next) queues.delete(chatId); });
  };

  let stopped = false;
  let offset = 0;
  bot = { username: null, send };

  (async () => {
    try {
      const me = await call('getMe');
      bot.username = me.username;
      log(`[telegram] polling as @${me.username}`);
    } catch (e) {
      log(`[telegram] could not start: ${e.message}`);
      bot = null;
      return;
    }
    while (!stopped) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] }, 65000);
        for (const update of updates) {
          offset = update.update_id + 1;
          const message = update.message;
          if (!message) continue;
          enqueue(message.chat.id, () => handleMessage(message, {
            send, typing, turn: runServerTurn, env, beforeInference,
          }));
        }
      } catch (e) {
        if (stopped) break;
        log(`[telegram] polling: ${e.message}`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  })();

  return () => { stopped = true; bot = null; };
};

/** The running bot's @username, for the settings screen. Null when off. */
export const botUsername = () => bot?.username || null;

/**
 * Send text to every Telegram chat linked to an account. Used when a
 * scheduled answer lands, so it arrives as a message rather than only as a
 * push that says "an answer is ready".
 */
export const notifyTelegram = async (userId, text) => {
  if (!bot) return 0;
  let sent = 0;
  for (const { tgChatId } of linksOf(userId)) {
    for (const piece of splitMessage(forMessenger(text))) await bot.send(tgChatId, piece);
    sent++;
  }
  return sent;
};
