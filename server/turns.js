/**
 * A turn answered by the server, with no browser open.
 *
 * ## Why
 *
 * Every turn in this app is assembled in the browser: the system prompt, the
 * persona, the memories, the retrieved passages, the tool table. Which is right
 * for a conversation somebody is having, and means nothing at all happens while
 * no tab is open -- the schedules in src/schedules.js said as much, and fired
 * only while the app was up.
 *
 * An account's chats are on this server anyway (the sync records), so the
 * server can answer one itself: read the chat, build the request, ask the
 * model, write the answer back as an ordinary record change, and ring the
 * doorbell so every open device pulls it in.
 *
 * ## What it does not do, said plainly
 *
 * A server turn is the plain part of a turn. It uses the chat's own system
 * prompt (or its persona's, or the account's), its model, its thinking level
 * and temperature, and the recent history. It does **not** search the web,
 * read the knowledge library, recall memories, call tools or draw pictures --
 * each of those lives in the browser, and bringing them here is a rewrite of
 * the turn rather than an addition to it. The answer says so in the log, and
 * the schedule list says so beside every schedule that runs here.
 *
 * ## Why one account at a time is enough
 *
 * Signed-in accounts only. A guest has no records on this server, so there is
 * no chat here to answer in; a guest's schedules stay in their browser.
 */

import { database } from './db.js';
import { applyChanges } from './records.js';
import { publishRev } from './liveSync.js';
import { stripAttachments } from '../src/attachMarkers.js';

/* How much history travels. A server turn has no context budgeting of its own
   -- the browser's lives in App.jsx -- so it takes a conservative slice rather
   than risk a request the model truncates from the front. */
const HISTORY_MESSAGES = 30;
const HISTORY_CHARS = 24000;

/* The browser's thinking levels, as the request field. `auto` sends nothing,
   which is the only value under which a model's own default survives. */
const THINK_WIRE = { auto: undefined, off: false, low: 'low', medium: 'medium', high: 'high' };

const readRecord = (owner, kind, id) => {
  const row = database()
    .prepare('SELECT payload, deleted FROM records WHERE user_id = ? AND kind = ? AND id = ?')
    .get(String(owner), kind, String(id));
  if (!row || row.deleted || !row.payload) return null;
  try { return JSON.parse(row.payload); } catch (e) { return null; }
};

/* A whole-list record is stored as the JSON text the browser keeps in
   localStorage, so its payload is a string to be parsed a second time. */
const readList = (owner, kind) => {
  const payload = readRecord(owner, kind, 'all');
  if (Array.isArray(payload)) return payload;
  if (typeof payload === 'string') {
    try { const parsed = JSON.parse(payload); return Array.isArray(parsed) ? parsed : []; } catch (e) { return []; }
  }
  return [];
};

const readSetting = (owner, key) => {
  const value = readRecord(owner, 'setting', key);
  return typeof value === 'string' ? value : null;
};

/** What a message says to the model, without the scaffolding around it. */
export const plainContent = (content) => stripAttachments(String(content || ''))
  .replace(/<think>[\s\S]*?(<\/think>|$)/gi, '')
  .replace(/<TOOL_RESULT>[\s\S]*?(<\/TOOL_RESULT>|$)/gi, '')
  .replace(/<TOOL_[A-Z_]+(\s+[^>]*)?>[\s\S]*?(<\/TOOL_[A-Z_]+>|$)/gi, '')
  .trim();

/**
 * The request a server turn sends, from a chat and what the account knows.
 *
 * The system prompt follows the browser's own order: the chat's override, then
 * its persona, then the account's setting. Pure apart from what it is handed,
 * so the order can be tested.
 */
export const buildServerRequest = ({ chat, prompt, personas = [], globalSystemPrompt = '', model = '', extraSystem = '' }) => {
  const persona = personas.find(p => p?.id === chat?.personaId) || null;
  const base = typeof chat?.systemPrompt === 'string'
    ? chat.systemPrompt
    : (persona?.body || globalSystemPrompt || '');
  // Memories and library passages (server/accountContext.js), after the
  // prompt that says who the assistant is, in the same one system message.
  const system = [base, extraSystem].filter(s => String(s || '').trim()).join('\n\n');

  const history = [];
  let chars = 0;
  const kept = (chat?.messages || [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && !m.continuation)
    .filter(m => !(m.role === 'user' && String(m.content || '').trim().startsWith('<TOOL_RESULT>')))
    .map(m => ({ role: m.role, content: plainContent(m.content) }))
    .filter(m => m.content);
  // Newest first until the budget is spent, then put back in order.
  for (let i = kept.length - 1; i >= 0 && history.length < HISTORY_MESSAGES; i -= 1) {
    chars += kept[i].content.length;
    if (chars > HISTORY_CHARS && history.length > 0) break;
    history.unshift(kept[i]);
  }

  const think = THINK_WIRE[chat?.thinkMode];
  const temperature = Number(chat?.temperature);
  return {
    model: model || chat?.lastModel || '',
    stream: false,
    messages: [
      ...(system.trim() ? [{ role: 'system', content: system }] : []),
      ...history,
      { role: 'user', content: String(prompt || '') },
    ],
    ...(think !== undefined ? { think } : {}),
    ...(Number.isFinite(temperature) ? { options: { temperature } } : {}),
  };
};

/** The chat with the question and its answer appended. */
export const withAnswer = (chat, { prompt, answer, thinking = '', model = '', metrics = null, at, origin = 'schedule' }) => {
  const content = thinking ? `<think>\n${thinking}\n</think>\n\n${answer}` : answer;
  return {
    ...chat,
    messages: [
      ...(chat.messages || []),
      // Marked, so it reads as the machine's own question rather than something
      // the reader is surprised to find they asked. A question that came in
      // from elsewhere (Telegram) is the reader's own, and says where from.
      origin === 'schedule'
        ? { role: 'user', content: String(prompt || ''), at, scheduled: true }
        : { role: 'user', content: String(prompt || ''), at, via: origin },
      { role: 'assistant', content, model, at, ...(metrics ? { metrics } : {}), answeredBy: 'server' },
    ],
    updatedAt: at,
    lastModel: model || chat.lastModel,
  };
};

/**
 * Ask, and write the answer into the chat.
 *
 * Returns `{ ok, error? }`. Never throws for the ordinary failures -- a chat
 * that is gone, a model that is not running -- because the caller is a timer
 * with nobody to catch it.
 */
export const runServerTurn = async ({
  owner, chatId, prompt, model = '', env = {}, extraSystem = '', origin = 'schedule',
  fetchImpl = fetch, now = () => Date.now(), beforeInference = async () => 'idle',
  project = null, askCli = null,
}) => {
  if (!owner) return { ok: false, error: 'A server turn needs an account' };
  const chat = readRecord(owner, 'chat', chatId);
  if (!chat) return { ok: false, error: 'That conversation is not on this server' };

  const request = buildServerRequest({
    chat,
    prompt,
    personas: readList(owner, 'personas'),
    globalSystemPrompt: readSetting(owner, 'systemPrompt') || '',
    model,
    extraSystem,
  });
  if (!request.model) return { ok: false, error: 'No model is set for that conversation' };

  const base = String(env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  let data;
  try {
    // ComfyUI lets go of the card first, as it does for any chat request.
    const state = await beforeInference();
    if (state === 'drawing') return { ok: false, error: 'A picture is being drawn; try again after it' };
    const started = now();
    /* A CLI model (`claude-code:…`) is not Ollama's to answer: straight to
       the CLI, as the chat's own requests are by the interceptor -- in a
       folder, when the schedule names one. */
    if (/^(claude-code|codex|agy):/.test(request.model)) {
      const ask = askCli || (await import('./cliModels.js')).answerOnce;
      // The schedule's folder, or else the chat's own (set in the composer).
      const folder = project || (chat.cliProject ? { dir: chat.cliProject, mode: chat.cliProjectMode === 'edit' ? 'edit' : 'plan' } : null);
      /* A cap over the whole fallback chain, not only one run: several CLIs
         each taking their own timeout could otherwise hold a turn for hours. */
      const capMs = Number(env.CLI_SCHEDULE_TIMEOUT_MS) > 0 ? Number(env.CLI_SCHEDULE_TIMEOUT_MS) : 45 * 60 * 1000;
      data = await ask({ model: request.model, messages: request.messages, env, owner, chat: chatId, project: folder, via: origin, signal: AbortSignal.timeout(capMs) });
    } else {
      const res = await fetchImpl(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
      if (!res.ok) return { ok: false, error: `The model answered HTTP ${res.status}` };
      data = await res.json();
    }
    data.__wall = (now() - started) / 1000;
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const answer = String(data?.message?.content || '').trim();
  if (!answer) return { ok: false, error: 'The model returned nothing' };
  const metrics = {
    totalTime: data.total_duration ? (data.total_duration / 1e9).toFixed(2) : data.__wall.toFixed(2),
    evalCount: data.eval_count ?? null,
    promptTokens: data.prompt_eval_count ?? null,
    tokensPerSec: data.eval_count && data.eval_duration
      ? (data.eval_count / (data.eval_duration / 1e9)).toFixed(2) : null,
    estimated: !data.total_duration,
  };

  const at = now();
  /* Read again just before writing: the model took a while, and somebody may
     have written to this chat in the meantime. Their newer messages are kept
     and the answer goes after them. */
  const latest = readRecord(owner, 'chat', chatId) || chat;
  const payload = withAnswer(latest, {
    prompt, answer, thinking: String(data?.message?.thinking || '').trim(), model: request.model, metrics, at, origin,
  });
  const result = applyChanges(owner, { records: [{ kind: 'chat', id: String(chatId), updatedAt: at, payload }] });
  if (result.applied > 0) publishRev(owner, result.rev, 'server');
  // The answer itself goes back too, for callers that deliver it somewhere
  // (Telegram) as well as writing it into the chat.
  return result.applied > 0
    ? { ok: true, answer, model: request.model }
    : { ok: false, error: 'The answer could not be saved', answer };
};
