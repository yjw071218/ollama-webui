// The CLI hardening and the chat around a CLI turn: what counts as a limit or
// a missing session, the time limits, agy's secrets kept out of its agent file
// and its read-only plan agent, what a chat may change per request, carrying
// on after a timeout, undoing a project run file by file (bytes intact), and
// the browser's pure helpers (src/cliTurn.js). No real CLI is run.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
process.env.WEBUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clihardening-data-'));

const load = (file) => import(pathToFileURL(path.join(ROOT, file)).href);
const C = await load('server/cliModels.js');
const F = await load('server/cliFallback.js');
const P = await load('server/cliProject.js');
const T = await load('src/cliTurn.js');

let pass = 0, fail = 0;
const ok = (cond, what) => {
  if (cond) pass++; else { fail++; console.error(`FAIL ${what}`); }
};

/* ---- limits: phrases, not single words */
for (const s of ['You have hit your usage limit', 'Error: 429 Too Many Requests', 'status: 429', 'insufficient_quota',
  'You exceeded your current quota', 'RESOURCE_EXHAUSTED', 'rate limit exceeded', 'weekly limit reached', 'limit reached · resets at 5pm']) {
  ok(F.isLimitError(s), `limit: ${s}`);
}
for (const s of ['line 429 of server.js', 'the quota field in config.yaml', 'see issue #4290', 'resets the counter in the loop']) {
  ok(!F.isLimitError(s), `not a limit: ${s}`);
}

/* ---- a resume that found no session, and nothing else */
for (const s of ['No conversation found with session ID abc', 'Error: session abc not found', 'thread does not exist', 'Could not resume session']) {
  ok(C.isSessionMissingError(s), `session missing: ${s}`);
}
for (const s of ['Claude Code did not finish within 180s', 'exited with code 1 before answering', 'You have hit your usage limit']) {
  ok(!C.isSessionMissingError(s), `not session missing: ${s}`);
}

/* ---- time limits by mode */
ok(C.cliTimeoutMs({}, {}) === 0, 'chat: no limit');
ok(C.cliTimeoutMs({}, { tools: {} }) === 0, 'tools: no limit');
ok(C.cliTimeoutMs({}, { project: {} }) === 0, 'project: no limit');
ok(C.cliTimeoutMs({ CLI_TIMEOUT_MS: '1000' }, { project: {} }) === 1000, 'CLI_TIMEOUT_MS sets all');
ok(C.cliTimeoutMs({ CLI_TIMEOUT_MS: '1000', CLI_TIMEOUT_CHAT_MS: '2000' }, {}) === 2000, 'per-mode wins');
ok(C.cliTimeoutMs({ CLI_TIMEOUT_CHAT_MS: 'nonsense' }, {}) === 0, 'nonsense falls back');

/* ---- agy: tokens through the environment, not the agent file */
const servers = { gh: { transport: 'stdio', command: 'node', args: ['x.js'], env: { GH_TOKEN: 'secret-123' } } };
const yaml = JSON.stringify(C.agyMcpServers(servers));
ok(!yaml.includes('secret-123'), 'agent file holds no token');
ok(yaml.includes('--env-from') && yaml.includes(C.agyEnvPrefix('gh')), 'proxy told where to look');
const env = C.agyServerEnv(servers);
ok(env[`${C.agyEnvPrefix('gh')}GH_TOKEN`] === 'secret-123', 'token in the process env under a prefix');

/* ---- agy: the plan agent cannot run commands */
const plan = C.agyPlanAgentFile({ name: 'ollama-webui-plan', tools: ['view_file', 'list_dir'] });
ok(/commandExecutionPolicy: off/.test(plan), 'plan agent: commands off');
const toolBlock = plan.split('tools:')[1].split('---')[0];
ok(/view_file/.test(toolBlock) && !/(write|edit|replace|run_command)/i.test(toolBlock), 'plan agent: read-only tools only');

/* ---- what a chat may change for one request */
const base = { CLI_EFFORT: 'low', CLI_MCP: 'false', CLI_WEB: 'false' };
const over = C.envForRequest(base, { 'x-cli-effort': 'HIGH', 'x-cli-mcp': 'on', 'x-cli-web': 'on' });
ok(over.CLI_EFFORT === 'high', 'effort from the chat');
ok(over.CLI_MCP === 'false' && over.CLI_WEB === 'false', 'a chat cannot switch on what .env switched off');
ok(C.envForRequest({}, { 'x-cli-mcp': 'off' }).CLI_MCP === 'off', 'a chat can switch MCP off');
ok(C.envForRequest(base, { 'x-cli-effort': 'ludicrous' }).CLI_EFFORT === 'low', 'unknown effort ignored');

/* ---- carrying on after a timeout */
C.noteContinuable('me', 'chat1', { id: 's1', provider: 'codex', keyModel: 'gpt-5' });
ok(C.takeContinuable('them', 'chat1', { provider: 'codex', keyModel: 'gpt-5' }) === null, 'another owner cannot take it');
ok(C.takeContinuable('me', 'chat1', { provider: 'codex', keyModel: 'gpt-5' })?.id === 's1', 'same chat, CLI and model: resumed');
ok(C.takeContinuable('me', 'chat1', { provider: 'codex', keyModel: 'gpt-5' }) === null, 'taken once');
C.noteContinuable('me', 'chat2', { id: 's2', provider: 'codex', keyModel: 'gpt-5' });
ok(C.takeContinuable('me', 'chat2', { provider: 'claude-code', keyModel: 'gpt-5' }) === null, 'another CLI does not resume it');

/* ---- undoing a project run: its files only, bytes intact */
let gitOk = true;
try { execFileSync('git', ['--version']); } catch { gitOk = false; }
if (gitOk) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clihardening-repo-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'core.autocrlf', 'true');   // Git for Windows' default, which used to turn LF into CRLF on undo
  const w = (f, s) => fs.writeFileSync(path.join(dir, f), s);
  const r = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  w('a.txt', 'A0\n'); w('b.txt', 'B0\r\n'); w('mine.txt', 'M0\n');
  const before = await P.snapshotTree(dir);
  w('a.txt', 'A1\n'); w('b.txt', 'B1\r\n'); w('c.txt', 'C1\n');
  const after = await P.snapshotTree(dir);
  const changes = await P.diffTrees(before.root, before.tree, after.tree);
  ok(changes.files.map(f => f.file).sort().join() === 'a.txt,b.txt,c.txt', 'run: three files');
  const run = P.noteRun({ owner: 'me', root: before.root, before: before.tree, after: after.tree, files: changes.files });
  w('mine.txt', 'M1\n');   // the reader's own edit afterwards

  await P.revertRun('me', run.id, { files: ['a.txt'] });
  ok(r('a.txt') === 'A0\n', 'one file undone, LF kept');
  ok(r('b.txt') === 'B1\r\n', 'the others left');
  ok(!P.getRun('me', run.id).reverted, 'not wholly undone yet');
  await P.revertRun('me', run.id);
  ok(r('b.txt') === 'B0\r\n', 'CRLF kept');
  ok(!fs.existsSync(path.join(dir, 'c.txt')), 'added file removed');
  ok(r('mine.txt') === 'M1\n', "the reader's later edit kept");
  ok(!!P.getRun('me', run.id).reverted, 'wholly undone');
  let refused = false;
  try { await P.revertRun('me', run.id); } catch { refused = true; }
  ok(refused, 'undone twice is refused');
  ok(P.getRun('them', run.id) === null, "another owner's run is not shown");
} else {
  console.log('(git not found: undo tests skipped)');
}

/* ---- the browser's helpers */
ok(JSON.stringify(T.cliHeadersOf({ effort: 'high', web: 'off', mcp: 'on' })) === JSON.stringify({ 'X-Cli-Effort': 'high', 'X-Cli-Web': 'off' }), 'headers: off only');
ok(Object.keys(T.cliHeadersOf(undefined)).length === 0, 'headers: none by default');
ok(T.nextEffort('') === 'low' && T.nextEffort('high') === '', 'effort cycles back to default');
ok(T.nextOffState('') === 'off' && T.nextOffState('off') === '', 'switch: default ↔ off');
ok(T.runIdOf({ content: 'diff…\n<!-- cli-run:run-ab12cd -->\n' }) === 'run-ab12cd', 'run id from the marker');
ok(T.runIdOf({ cliRun: 'run-x', content: '' }) === 'run-x', 'run id from the message');
ok(T.runIdOf({ content: 'nothing' }) === '', 'no run id');
ok(T.clockText(65_000) === '1:05' && T.clockText(3_725_000) === '1:02:05', 'clock text');
ok(T.clockState(170_000, 180_000) === 'near' && T.clockState(10_000, 180_000) === 'ok', 'clock near the limit');
const grouped = T.groupSessions([
  { key: 1, cwd: 'C:/a', title: 'fix build', at: 1 },
  { key: 2, cwd: 'C:/b', title: 'write docs', at: 5 },
  { key: 3, cwd: 'C:/a', title: 'add tests', at: 9 },
], '');
ok(grouped[0].cwd === 'C:/a' && grouped[0].sessions[0].key === 3, 'sessions grouped by folder, newest first');
ok(T.groupSessions(grouped.flatMap(g => g.sessions), 'docs').length === 1, 'sessions searched');

console.log(`clihardening: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
