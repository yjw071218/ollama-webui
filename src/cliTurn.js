/**
 * The pure half of src/CliTurn.jsx: what a chat's CLI choices send, which run
 * an answer made, and how a clock reads. No React, so it is tested in node.
 */

/** The effort levels the composer cycles through; '' is "as .env says". */
export const CLI_EFFORT_STEPS = ['', 'low', 'medium', 'high'];

/** Headers for this chat's CLI options (envForRequest in server/cliModels.js). */
export const cliHeadersOf = (options = {}) => {
  const out = {};
  const o = options || {};
  if (CLI_EFFORT_STEPS.includes(o.effort) && o.effort) out['X-Cli-Effort'] = o.effort;
  // Off only: the server will not let a chat switch on what .env switched off.
  if (o.web === 'off') out['X-Cli-Web'] = 'off';
  if (o.mcp === 'off') out['X-Cli-Mcp'] = 'off';
  // Approvals: skipped unless this chat asked to be asked (the server only lets it get stricter).
  if (o.approvals === 'ask') out['X-Cli-Approvals'] = 'ask';
  return out;
};

/** A switch a chat can only turn off: as .env says ↔ off. */
export const nextOffState = (v) => (v === 'off' ? '' : 'off');

export const nextEffort = (v) => {
  const i = CLI_EFFORT_STEPS.indexOf(v || '');
  return CLI_EFFORT_STEPS[(i + 1) % CLI_EFFORT_STEPS.length];
};

/** The project run an answer made: kept on the message, or else read from the
 *  marker server/cliProject.js leaves at the end of its diffs. */
const RUN_MARK = /<!--\s*cli-run:(run-[\w-]+)\s*-->/;
export const runIdOf = (message) => {
  if (typeof message?.cliRun === 'string' && message.cliRun) return message.cliRun;
  const m = RUN_MARK.exec(String(message?.content || ''));
  return m ? m[1] : '';
};

/** "m:ss" (or "h:mm:ss") for a clock. */
export const clockText = (ms) => {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

/** How the clock should look: 'ok', then 'near' past 80% of the limit. */
export const clockState = (elapsed, limit) => {
  if (!(limit > 0)) return 'ok';
  return elapsed >= limit * 0.8 ? 'near' : 'ok';
};

/** Terminal sessions filtered by a query and grouped by folder, newest first. */
export const groupSessions = (sessions = [], query = '') => {
  const q = String(query || '').trim().toLowerCase();
  const hit = (s) => !q || [s.title, s.cwd, s.provider].some(v => String(v || '').toLowerCase().includes(q));
  const groups = new Map();
  for (const s of sessions.filter(hit)) {
    const key = s.cwd || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return [...groups.entries()]
    .map(([cwd, list]) => ({ cwd, sessions: list.sort((a, b) => (b.at || 0) - (a.at || 0)) }))
    .sort((a, b) => (b.sessions[0]?.at || 0) - (a.sessions[0]?.at || 0));
};
