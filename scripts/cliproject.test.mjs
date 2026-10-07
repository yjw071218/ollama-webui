/**
 * Project mode and the rest of server/cliProject.js, against a real git
 * repository in a temp folder and fake CLI output -- no CLI is run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliproject-test-'));
process.env.WEBUI_DATA_DIR = path.join(tmp, 'data');

const P = await import('../server/cliProject.js');
const M = await import('../server/cliModels.js');
/* These tests describe the sandboxed CLIs, which is CLI_FULL_ACCESS=false;
   full access is the default and is checked on its own (see fullAccessOf). */
const sandboxed = (provider, model, request, options = {}) => M.buildInvocation(provider, model, request,
  { ...options, env: { CLI_FULL_ACCESS: 'false', ...(options.env || {}) } });


let passed = 0, failed = 0;
// The server's timers are unref'd; a test awaiting one needs something alive.
const alive = setInterval(() => {}, 1000);
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`); passed++; } catch (e) { console.log(`FAIL  ${name}\n      ${e.stack || e}`); failed++; }
};
const eq = (a, b, what = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, what = 'expected truthy') => { if (!v) throw new Error(what); };

const root = path.join(tmp, 'projects');
const repo = path.join(root, 'repo');
fs.mkdirSync(repo, { recursive: true });
const g = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'pipe' }).toString();
g('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n');
g('add', '-A'); g('commit', '-q', '-m', 'init');
const env = { CLI_PROJECT_ROOTS: root };

/* ---------------------------------------------------------- folders */

await check('project mode is off without CLI_PROJECT_ROOTS', () => {
  try { P.resolveProject(repo, {}); throw new Error('allowed'); } catch (e) { ok(/CLI_PROJECT_ROOTS/.test(e.message), e.message); }
});
await check('a folder under a root is allowed', () => {
  eq(P.resolveProject(repo, env).toLowerCase(), fs.realpathSync(repo).toLowerCase());
});
await check('a folder outside every root is refused', () => {
  try { P.resolveProject(tmp, env); throw new Error('allowed'); } catch (e) { ok(/not under/.test(e.message), e.message); }
});
await check('.. cannot climb out of a root', () => {
  try { P.resolveProject(path.join(repo, '..', '..'), env); throw new Error('allowed'); } catch (e) { ok(/not under/.test(e.message), e.message); }
});
await check('the headers name the folder and the mode', () => {
  const p = P.projectFromHeaders({ 'x-cli-project': encodeURIComponent(repo), 'x-cli-project-mode': 'plan' }, { ...env, CLI_MAX_TURNS: '12' });
  eq([p.mode, p.maxTurns], ['plan', 12]);
  eq(P.projectFromHeaders({}, env), null);
});

/* ------------------------------------------------ snapshot, diff, undo */

await check('a snapshot leaves the index and HEAD alone', async () => {
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged\n');
  g('add', 'staged.txt');
  const head = g('rev-parse', 'HEAD');
  const status = g('status', '--porcelain');
  const snap = await P.snapshotTree(repo);
  ok(/^[0-9a-f]{40}$/.test(snap.tree), 'a tree');
  eq(g('rev-parse', 'HEAD'), head, 'HEAD');
  eq(g('status', '--porcelain'), status, 'status');
});

let before, after, run;
await check('the diff of a run names each file with its counts', async () => {
  before = await P.snapshotTree(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'fresh\n');
  fs.writeFileSync(path.join(repo, 'ignored.txt'), 'never\n');
  after = await P.snapshotTree(repo);
  const d = await P.diffTrees(before.root, before.tree, after.tree);
  eq(d.files.map(f => f.file).sort(), ['a.txt', 'new.txt']);
  eq(d.files.find(f => f.file === 'a.txt'), { file: 'a.txt', added: 1, removed: 0 });
  const md = P.changesMarkdown(d, 'run-x');
  ok(md.includes('📝 **`a.txt`** (+1 −0)') && md.includes('+two') && md.includes('<!-- cli-run:run-x -->'), md);
  run = P.noteRun({ owner: 'u1', root: before.root, before: before.tree, after: after.tree, files: d.files });
});
await check('a run is undone: changed files back, added files gone', async () => {
  await P.revertRun('u1', run.id);
  eq(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r/g, ''), 'one\n');
  ok(!fs.existsSync(path.join(repo, 'new.txt')), 'new.txt removed');
  ok(fs.existsSync(path.join(repo, 'ignored.txt')), 'ignored files are not the run\'s to remove');
  const status = g('status', '--porcelain');
  ok(/^A. staged\.txt$/m.test(status), `still staged: ${status}`);
});
await check('only its owner can undo it, and only once', async () => {
  try { await P.revertRun('u2', run.id); throw new Error('allowed'); } catch (e) { ok(/No such run/.test(e.message)); }
  try { await P.revertRun('u1', run.id); throw new Error('allowed'); } catch (e) { ok(/Already/.test(e.message)); }
});
await check('not a repository: no snapshot, no error', async () => {
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  eq(await P.snapshotTree(plain), null);
});

/* ---------------------------------------------------------- approvals */

await check('an approval waits for its owner\'s answer', async () => {
  const waiting = P.requestApproval({ owner: 'u1', provider: 'codex', kind: 'command', title: 'npm test' });
  const [one] = P.listApprovals('u1');
  eq([one.title, P.listApprovals('u2').length], ['npm test', 0]);
  eq(P.decideApproval('u2', one.id, 'accept'), false, 'another account');
  eq(P.decideApproval('u1', one.id, 'acceptForSession'), true);
  eq(await waiting, 'acceptForSession');
  eq(P.listApprovals('u1').length, 0);
});
await check('nobody answering is a no', async () => {
  eq(await P.requestApproval({ owner: 'u1', kind: 'x', title: 'x', timeoutMs: 20 }), 'decline');
});
await check('Codex\'s approval requests become questions and replies', () => {
  const m = { id: 7, method: 'item/commandExecution/requestApproval', params: { command: ['git', 'push'], cwd: '/r' } };
  eq(P.codexApprovalOf(m).title, 'git push');
  eq(P.codexApprovalReply(m, 'decline'), { id: 7, result: { decision: 'decline' } });
  eq(P.codexApprovalReply({ id: 8, method: 'execCommandApproval' }, 'accept'), { id: 8, result: { decision: 'approved' } });
});
await check('a Codex session in project mode asks; in chat mode declines', () => {
  const req = { id: 9, method: 'item/fileChange/requestApproval', params: {} };
  const asking = new M.CodexSession({ thread: { approvalPolicy: 'on-request' }, turn: {} });
  const out = asking.accept(req);
  ok(out.ask && out.reply('accept').result.decision === 'accept', JSON.stringify(out));
  const chat = new M.CodexSession({ thread: { approvalPolicy: 'never' }, turn: {} });
  ok(chat.accept(req).write[0].error, 'declined');
});
await check('Claude Code\'s approvals come through files', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ap-'));
  const stop = P.watchApprovalDir(dir, async (q) => (q.title === 'Bash' ? 'accept' : 'decline'));
  fs.writeFileSync(path.join(dir, '1.req.json'), JSON.stringify({ tool_name: 'Bash', input: { command: 'ls' } }));
  fs.writeFileSync(path.join(dir, '2.req.json'), JSON.stringify({ tool_name: 'Write', input: {} }));
  const read = async (n) => {
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(path.join(dir, `${n}.res.json`))) return JSON.parse(fs.readFileSync(path.join(dir, `${n}.res.json`), 'utf8'));
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('no answer');
  };
  eq(await read(1), { behavior: 'allow', updatedInput: { command: 'ls' } });
  eq((await read(2)).behavior, 'deny');
  stop();
});

await check('the approval MCP server asks through the folder and returns the answer', async () => {
  const { spawn } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(tmp, 'mcp-'));
  const stop = P.watchApprovalDir(dir, async () => 'accept');
  const child = spawn(process.execPath, [M.APPROVAL_SERVER, '--dir', dir], { stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = [];
  let buf = '';
  child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  send({ id: 1, method: 'initialize', params: {} });
  send({ id: 2, method: 'tools/list' });
  send({ id: 3, method: 'tools/call', params: { name: 'ask', arguments: { tool_name: 'Bash', input: { command: 'npm test' } } } });
  for (let i = 0; i < 100 && !replies.some(r => r.id === 3); i++) await new Promise(r => setTimeout(r, 50));
  child.kill(); stop();
  eq(replies.find(r => r.id === 2).result.tools[0].name, 'ask');
  eq(JSON.parse(replies.find(r => r.id === 3).result.content[0].text), { behavior: 'allow', updatedInput: { command: 'npm test' } });
});

/* ------------------------------------------------- the CLI command lines */

const files = fs.mkdtempSync(path.join(tmp, 'req-'));
const project = { dir: repo, mode: 'edit', maxTurns: 20 };
await check('Claude Code in a folder: its own prompt kept, edits allowed, the rest asked', () => {
  const inv = sandboxed(M.PROVIDERS['claude-code'], 'opus', { system: 'Be brief.', prompt: 'fix it' }, { files, project, env });
  const a = inv.args.join(' ');
  ok(a.includes('--permission-mode acceptEdits') && a.includes('--permission-prompt-tool mcp__webui_approval__ask'), a);
  ok(a.includes('--append-system-prompt-file') && !a.includes('--system-prompt-file ') && !a.includes('--tools'), a);
  ok(a.includes('--max-turns 20'), a);
  eq(inv.cwd, repo);
  const config = JSON.parse(fs.readFileSync(path.join(files, 'mcp.json'), 'utf8'));
  ok(config.mcpServers.webui_approval.args.includes(inv.approvalDir), 'approval server');
});
await check('plan mode is Claude Code\'s plan mode', () => {
  const inv = sandboxed(M.PROVIDERS['claude-code'], 'opus', { prompt: 'x' }, { files, project: { ...project, mode: 'plan' }, env });
  ok(inv.args.join(' ').includes('--permission-mode plan'));
});
await check('Codex in a folder writes there and asks for the rest; plan is read-only', () => {
  const edit = sandboxed(M.PROVIDERS.codex, 'gpt-5.5', { system: 'S', prompt: 'x' }, { files, project, env });
  eq([edit.session.thread.cwd, edit.session.thread.sandbox, edit.session.thread.approvalPolicy, edit.session.thread.developerInstructions], [repo, 'workspace-write', 'on-request', 'S']);
  ok(!('baseInstructions' in edit.session.thread), 'Codex keeps its own');
  const plan = sandboxed(M.PROVIDERS.codex, 'gpt-5.5', { prompt: 'x' }, { files, project: { ...project, mode: 'plan' }, env });
  eq(plan.session.thread.sandbox, 'read-only');
});
await check('agy plans unless CLI_AGY_PROJECT_EDIT is on', () => {
  const text = (e) => JSON.parse(sandboxed(M.PROVIDERS.agy, 'g', { prompt: 'x' }, { files, project, env: e }).stdin).message.content[0].text;
  ok(/Plan only/.test(text(env)));
  ok(/may read and edit/.test(text({ ...env, CLI_AGY_PROJECT_EDIT: 'on' })));
});
/* Full access, the default (fullAccessOf): every folder writable, nothing asked. */
await check('full access is on unless CLI_FULL_ACCESS=false', () => {
  ok(M.fullAccessOf({}) && M.fullAccessOf({ CLI_FULL_ACCESS: 'on' }));
  ok(!M.fullAccessOf({ CLI_FULL_ACCESS: 'false' }) && !M.fullAccessOf({ CLI_FULL_ACCESS: '0' }));
  eq(M.allRoots('linux'), ['/']);
  eq(M.allRoots('win32', (root) => root === 'C:\\' || root === 'D:\\'), ['C:\\', 'D:\\']);
});
await check('with full access, chat CLIs can write anywhere and are never stopped to ask', () => {
  const full = { ...env, CLI_FULL_ACCESS: 'true' };
  const claude = M.buildInvocation(M.PROVIDERS['claude-code'], 'opus', { system: 'Be brief.', prompt: '이어서 진행해줘' }, { files, env: full });
  const a = claude.args.join(' ');
  ok(a.includes('--permission-mode bypassPermissions') && a.includes('--add-dir') && !claude.args.includes('--tools'), a);
  const codex = M.buildInvocation(M.PROVIDERS.codex, 'gpt-5.5', { system: 'Be brief.', prompt: 'x' }, { files, env: full });
  eq([codex.session.thread.sandbox, codex.session.thread.approvalPolicy], ['danger-full-access', 'never']);
  ok(/full read and write access/.test(codex.session.thread.baseInstructions) && !/read-only sandbox/.test(codex.session.thread.baseInstructions));
});
await check('with full access, project runs write anywhere without asking -- but plan still only plans', () => {
  const full = { ...env, CLI_FULL_ACCESS: 'true' };
  const claude = M.buildInvocation(M.PROVIDERS['claude-code'], 'opus', { prompt: 'x' }, { files, project, env: full }).args.join(' ');
  ok(claude.includes('--permission-mode bypassPermissions') && claude.includes('--add-dir'), claude);
  const codex = M.buildInvocation(M.PROVIDERS.codex, 'gpt-5.5', { prompt: 'x' }, { files, project, env: full });
  eq([codex.session.thread.sandbox, codex.session.thread.approvalPolicy], ['danger-full-access', 'never']);
  const plan = M.buildInvocation(M.PROVIDERS.codex, 'gpt-5.5', { prompt: 'x' }, { files, project: { ...project, mode: 'plan' }, env: full });
  eq([plan.session.thread.sandbox, plan.session.thread.approvalPolicy], ['read-only', 'on-request']);
  ok(M.buildInvocation(M.PROVIDERS['claude-code'], 'opus', { prompt: 'x' }, { files, project: { ...project, mode: 'plan' }, env: full }).args.join(' ').includes('--permission-mode plan'));
  const agy = JSON.parse(M.buildInvocation(M.PROVIDERS.agy, 'g', { prompt: 'x' }, { files, project, env: full }).stdin).message.content[0].text;
  ok(/full read and write access/.test(agy), agy);
});
await check('without a folder nothing changes', () => {
  const inv = sandboxed(M.PROVIDERS['claude-code'], 'opus', { prompt: 'x' }, { files, env });
  ok(inv.args.includes('--system-prompt-file') && inv.args.includes('--tools') && !inv.cwd);
});

/* ------------------------------------------------ budget and forecast */

await check('the budget counts today and says when it is spent', () => {
  const now = new Date(2026, 8, 30, 15).getTime();
  const lines = [{ at: now - 3600e3, costUsd: 3 }, { at: now - 2 * 3600e3, costUsd: 2.5 }, { at: now - 20 * 3600e3, costUsd: 99 }];
  eq(P.budgetState(lines, { CLI_DAILY_BUDGET_USD: '5' }, { now }), { cap: 5, spent: 5.5, over: true });
  eq(P.budgetState(lines, {}, { now }).over, false);
});
await check('a window is forecast to run out at the rate it is used', () => {
  const t0 = Date.UTC(2026, 8, 30, 0);
  const resetsAt = t0 + 5 * 3600e3;
  const samples = [{ at: t0, id: 'five_hour', used: 10, resetsAt }, { at: t0 + 3600e3, id: 'five_hour', used: 40, resetsAt }];
  const f = P.forecastWindow(samples, { id: 'five_hour', usedPercent: 40, resetsAt }, t0 + 3600e3);
  eq(f, { exhaustsAt: t0 + 3 * 3600e3, perHour: 30 });
  const slow = P.forecastWindow([samples[0], { ...samples[1], used: 12 }], { id: 'five_hour', usedPercent: 12, resetsAt }, t0 + 3600e3);
  eq(slow.exhaustsAt, null, 'resets first');
  eq(P.forecastWindow([samples[0]], { id: 'five_hour' }), null);
});
await check('the history is kept per window', () => {
  const file = path.join(tmp, 'hist.jsonl');
  P.noteLimitHistory('codex', { windows: [{ id: 'five_hour', usedPercent: 5, resetsAt: 1 }] }, { file, at: 10 });
  eq(P.readLimitHistory({ file }), [{ at: 10, provider: 'codex', id: 'five_hour', used: 5, resetsAt: 1 }]);
});
await check('agy is estimated from its runs against what a window held', () => {
  const now = Date.now();
  const lines = Array.from({ length: 6 }, (_, i) => ({ provider: 'agy', at: now - i * 600e3 }));
  eq(P.learnAgyCapacity(lines, now), 6);
  const e = P.agyEstimate(lines.slice(0, 3), {}, { now, learned: 6 });
  eq([e.windows[0].usedPercent, e.windows[0].estimated, e.status], [50, true, 'allowed']);
  eq(P.agyEstimate(lines, { CLI_AGY_5H_RUNS: '4' }, { now }).status, 'rejected');
  eq(P.agyEstimate(lines, {}, { now }), null, 'nothing to count against');
});

/* ------------------------------------------ skills, agents, sessions */

const home = path.join(tmp, 'home');
await check('skills, agents and prompts are listed and switched by renaming', () => {
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'pdf'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: Read PDFs\n---\nbody');
  fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'agents', 'reviewer.md'), '---\ndescription: "Reviews"\n---');
  fs.mkdirSync(path.join(home, '.codex', 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'prompts', 'fix.md'), 'no front matter');
  const list = P.listExtensions({}, home);
  eq(list.map(x => `${x.provider}/${x.kind}/${x.name}/${x.description}`).sort(), ['claude-code/agent/reviewer/Reviews', 'claude-code/skill/pdf/Read PDFs', 'codex/prompt/fix/']);
  const skill = list.find(x => x.name === 'pdf');
  const off = P.setExtensionEnabled({}, skill.file, false, home);
  ok(!off.enabled && fs.existsSync(`${skill.file}.disabled`));
  eq(P.listExtensions({}, home).find(x => x.name === 'pdf').enabled, false);
  P.setExtensionEnabled({}, off.file, true, home);
  ok(fs.existsSync(skill.file));
  try { P.setExtensionEnabled({}, path.join(repo, 'a.txt'), false, home); throw new Error('allowed'); } catch (e) { ok(/Unknown/.test(e.message)); }
});
await check('terminal sessions are read back as messages', () => {
  const claudeDir = path.join(home, '.claude', 'projects', 'C--x');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 's1.jsonl'), [
    { type: 'user', cwd: 'C:\\x', sessionId: 's1', message: { role: 'user', content: 'Hello there' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }, { type: 'tool_use' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } },
  ].map(l => JSON.stringify(l)).join('\n'));
  const codexDir = path.join(home, '.codex', 'sessions', '2026', '09', '30');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'rollout-1.jsonl'), [
    { type: 'session_meta', payload: { id: 'th1', cwd: '/r' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the bug' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed' }] } },
  ].map(l => JSON.stringify(l)).join('\n'));
  const list = P.listTerminalSessions({}, home);
  eq(list.map(s => s.title).sort(), ['Fix the bug', 'Hello there']);
  const claude = P.readTerminalSession({}, list.find(s => s.provider === 'claude-code').key, home);
  eq(claude.messages, [{ role: 'user', content: 'Hello there' }, { role: 'assistant', content: 'Hi\n\nDone.' }]);
  const codex = P.readTerminalSession({}, list.find(s => s.provider === 'codex').key, home);
  eq([codex.messages.length, codex.sessionId, codex.cwd], [2, 'th1', '/r']);
  try { P.readTerminalSession({}, Buffer.from(path.join(repo, 'a.txt')).toString('base64url'), home); throw new Error('allowed'); } catch (e) { ok(/No such/.test(e.message)); }
});

/* --------------------------------------------------------- the race */

await check('a race runs each model in its own worktree, and merges the winner', async () => {
  g('reset', '-q');
  fs.rmSync(path.join(repo, 'staged.txt'), { force: true });
  const run = async ({ model, dir }) => {
    fs.writeFileSync(path.join(dir, `${model.replace(/\W/g, '_')}.txt`), `${model}\n`);
    return `did it as ${model}`;
  };
  const race = await P.startRace({ owner: 'u1', dir: repo, prompt: 'add a file', models: ['claude-code:opus', 'codex:gpt-5.5'], run });
  let state;
  for (let i = 0; i < 100; i++) {
    state = P.getRace('u1', race.id);
    if (state.entries.every(e => e.status !== 'running')) break;
    await new Promise(r => setTimeout(r, 100));
  }
  eq(state.entries.map(e => [e.status, e.files.length]), [['done', 1], ['done', 1]]);
  ok(state.entries[0].text.includes('did it as claude-code:opus'));
  eq(P.getRace('u2', race.id), null, 'another account');
  const { merged } = await P.finishRace('u1', race.id, 1);
  ok(merged.includes('codex'), merged);
  ok(fs.existsSync(path.join(repo, 'codex_gpt_5_5.txt')) && !fs.existsSync(path.join(repo, 'claude_code_opus.txt')));
  ok(!g('branch', '--list', 'cli-race/*').trim(), 'branches removed');
  ok(!g('worktree', 'list').includes('worktrees'), 'worktrees removed');
});

clearInterval(alive);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* git may still hold a file on Windows */ }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
