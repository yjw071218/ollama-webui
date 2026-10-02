/**
 * An account's schedules, answered by this server.
 *
 * The browser's own runner (src/schedules.js, in App.jsx) fires while a tab is
 * open and says so. This is the half that does not need one: a signed-in
 * account's schedules live here, the server checks them on a timer, and each
 * due one is answered by `runServerTurn` -- a plain text answer, written into
 * the chat as a record change every open device then pulls in.
 *
 * The rules of *when* are not repeated here. `isDue` in src/schedules.js is the
 * one definition -- the slot, the catch-up grace, never twice for one slot --
 * and this imports it, so a schedule means the same thing wherever it runs.
 *
 * ## One runner per slot, even with two processes
 *
 * `npm run dev` and `npm start` can both be up against one database. A slot is
 * claimed by moving `last_run_at` forward *only if it still holds the value
 * that was read*; the database answers that atomically, and the process whose
 * update changed nothing does not run it.
 */

import crypto from 'node:crypto';
import { database } from './db.js';
import { isDue, EVERY, minutesOf } from '../src/schedules.js';
import { runServerTurn } from './turns.js';
import { noteFinished, sendPush } from './push.js';
import { notifyTelegram } from './telegram.js';

const rowToSchedule = (row) => ({
  id: row.id,
  chat: row.chat,
  prompt: row.prompt,
  every: row.every,
  at: row.at,
  model: row.model,
  enabled: !!row.enabled,
  createdAt: row.created_at,
  lastRunAt: row.last_run_at,
  lastError: row.last_error || '',
  project: row.project || '',
  projectMode: row.project_mode === 'edit' ? 'edit' : 'plan',
  runsOn: 'server',
});

export const listSchedules = (owner) => database()
  .prepare('SELECT * FROM server_schedules WHERE user_id = ? ORDER BY created_at ASC')
  .all(String(owner))
  .map(rowToSchedule);

/** A new schedule, or an error saying which field is wrong. */
export const createSchedule = (owner, { chat, prompt, every = 'day', at = '08:00', model = '', project = '', projectMode = 'plan' } = {}, now = Date.now()) => {
  if (!owner) return { error: 'Schedules that run on the server need an account' };
  if (!String(chat || '').trim()) return { error: 'A schedule needs a conversation' };
  if (!String(prompt || '').trim()) return { error: 'A schedule needs something to ask' };
  if (!EVERY.includes(every)) return { error: `every must be one of ${EVERY.join(', ')}` };
  if (minutesOf(at) === null) return { error: 'at must be a time, HH:MM' };
  const id = `srv-${crypto.randomBytes(6).toString('hex')}`;
  // The folder is checked against CLI_PROJECT_ROOTS when it runs, not here:
  // .env may change in between, and the run is where it matters.
  if (project && !String(model || '').includes(':')) return { error: 'A folder needs a CLI model (claude-code:…, codex:…, agy:…)' };
  database().prepare(`
    INSERT INTO server_schedules (id, user_id, chat, prompt, every, at, model, enabled, created_at, last_run_at, project, project_mode)
    VALUES (?,?,?,?,?,?,?,1,?,0,?,?)
  `).run(id, String(owner), String(chat), String(prompt).trim().slice(0, 4000), every, at, String(model || ''), now,
    String(project || '').slice(0, 500), projectMode === 'edit' ? 'edit' : 'plan');
  return { schedule: listSchedules(owner).find(s => s.id === id) };
};

/** Switched on or off. Only the account that made it can touch it. */
export const setScheduleEnabled = (owner, id, enabled) => database()
  .prepare('UPDATE server_schedules SET enabled = ? WHERE id = ? AND user_id = ?')
  .run(enabled ? 1 : 0, String(id), String(owner)).changes > 0;

export const deleteSchedule = (owner, id) => database()
  .prepare('DELETE FROM server_schedules WHERE id = ? AND user_id = ?')
  .run(String(id), String(owner)).changes > 0;

/**
 * The schedules due now, each claimed for this process.
 *
 * Returned only when this process's claim won. See the note at the top.
 */
export const claimDue = (now = Date.now()) => {
  const db = database();
  const rows = db.prepare('SELECT * FROM server_schedules WHERE enabled = 1').all();
  const claim = db.prepare('UPDATE server_schedules SET last_run_at = ? WHERE id = ? AND last_run_at = ?');
  const claimed = [];
  for (const row of rows) {
    const schedule = rowToSchedule(row);
    if (!isDue(schedule, now)) continue;
    if (claim.run(now, row.id, row.last_run_at).changes === 1) claimed.push({ ...schedule, owner: row.user_id });
  }
  return claimed;
};

const noteError = (id, error) => database()
  .prepare('UPDATE server_schedules SET last_error = ? WHERE id = ?')
  .run(String(error || '').slice(0, 300), String(id));

/**
 * Check every thirty seconds, for the life of the process.
 *
 * Started by whichever server is serving -- server/index.js, and the dev
 * server in vite.config.js -- rather than by `createApiRoutes`, which the tests
 * call dozens of times and which must not leave timers behind that could
 * answer somebody's schedule from inside a test run.
 */
let started = false;
export const startScheduleRunner = (env = {}, { beforeInference, intervalMs = 30000, log = console.log } = {}) => {
  if (started || String(env.SERVER_SCHEDULES ?? 'true').toLowerCase() === 'false') return () => {};
  started = true;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const schedule of claimDue()) {
        const result = await runServerTurn({
          owner: schedule.owner, chatId: schedule.chat, prompt: schedule.prompt, model: schedule.model,
          project: schedule.project ? { dir: schedule.project, mode: schedule.projectMode } : null,
          env, beforeInference,
        });
        noteError(schedule.id, result.ok ? '' : result.error);
        if (result.ok) {
          log(`[schedule] answered in ${schedule.chat}`);
          noteFinished(schedule.owner, 'answer');
          sendPush(schedule.owner).catch(() => {});
          // And the answer itself, to any Telegram chat linked to the account.
          notifyTelegram(schedule.owner, result.answer).catch(() => {});
        } else {
          log(`[schedule] ${schedule.id} did not run: ${result.error}`);
        }
      }
    } catch (e) {
      log(`[schedule] runner: ${e.message}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => { clearInterval(timer); started = false; };
};
