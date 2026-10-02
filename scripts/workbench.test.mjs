// The workbench: code tools for the chat's models, over MCP.
//
// A model asked to add a feature to this repository said it could read only
// the head and tail of App.jsx, could not search inside files, and could not
// run the tests -- and stopped. server/workbench.js is what it lacked. This
// checks each tool, then runs the real server through the app's own MCP client.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const W = await import(pathToFileURL(path.join(ROOT, 'server/workbench.js')).href);
const { createMcpPool } = await import(pathToFileURL(path.join(ROOT, 'server/mcp.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-outside-'));
try {
  /* --------------------------------------------------------------- paths */
  eq('a path inside a root is allowed', W.resolveIn([work], path.join(work, 'a.txt')), path.join(work, 'a.txt'));
  eq('a relative path is read against the first root', W.resolveIn([work], 'sub/b.txt'), path.join(work, 'sub', 'b.txt'));
  let refused = null;
  try { W.resolveIn([work], path.join(outside, 'x')); } catch (e) { refused = e.message; }
  check('a path outside every root is refused, naming the roots', /outside the allowed folders/.test(refused || ''), refused);
  let dotted = null;
  try { W.resolveIn([work], path.join(work, '..', path.basename(outside), 'x')); } catch (e) { dotted = e.message; }
  check('and so is one that climbs out with ..', !!dotted);
  check('a sibling whose name starts the same is not inside', !W.within(work, `${work}-evil${path.sep}x`));

  /* ------------------------------------------------------------- reading */
  const big = path.join(work, 'big.js');
  fs.writeFileSync(big, Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n'));
  const middle = W.readLines(big, { offset: 2500, limit: 3 });
  check('the middle of a large file can be read by line', middle.includes('2500\tline 2500') && middle.includes('2502\tline 2502') && !middle.includes('line 2503'), middle);
  check('with the total and where to go on', middle.includes('of 5000') && middle.includes('offset 2503'));
  fs.writeFileSync(path.join(work, 'bin.dat'), Buffer.from([1, 0, 2, 0]));
  check('a binary file is named, not dumped', /binary file/.test(W.readLines(path.join(work, 'bin.dat'))));

  /* ----------------------------------------------------------- searching */
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.mkdirSync(path.join(work, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(work, 'src', 'App.jsx'), 'const a = 1;\nconst TOOLS = [\n  { name: "x" },\n];\n');
  fs.writeFileSync(path.join(work, 'src', 'tools.js'), 'export const TOOLS_LIST = 2;\n');
  fs.writeFileSync(path.join(work, 'node_modules', 'dep', 'index.js'), 'const TOOLS = [];\n');
  const found = W.grep(work, 'const TOOLS\\b', { context: 1 });
  check('grep finds a line inside a file, with its number', found.includes('App.jsx') && found.includes('2: const TOOLS = ['), found);
  check('with context lines marked apart', found.includes('1- const a = 1;') && found.includes('3-   { name: "x" },'), found);
  check('and does not search node_modules', !found.includes('node_modules'));
  check('a glob narrows it', !W.grep(work, 'TOOLS', { glob: '*.jsx' }).includes('tools.js'));
  check('files_only lists files', W.grep(work, 'TOOLS', { filesOnly: true }).includes('(1)'));
  let badRe = null;
  try { W.grep(work, '(unclosed'); } catch (e) { badRe = e.message; }
  check('a broken pattern says so', /Not a valid regular expression/.test(badRe || ''));
  check('find_files by glob', W.findFiles(work, '**/*.jsx').includes(path.join(work, 'src', 'App.jsx')));
  check('a bare name glob matches at any depth', W.globToRegExp('*.js').test('src/deep/tools.js'));
  check('braces are alternatives', W.globToRegExp('*.{js,jsx}').test('a/App.jsx'));

  /* ---------------------------------------------------------------- diffs */
  const d = W.unifiedDiff('a\nb\nc\nd\ne\nf\ng\nh\ni\nj', 'a\nb\nc\nD\ne\nf\ng\nh\ni\nj\nk', { name: 'x.txt' });
  eq('a diff counts additions', d.added, 2);
  eq('and removals', d.removed, 1);
  check('with hunk headers and context', d.diff.includes('@@ -1,') && d.diff.includes('-d') && d.diff.includes('+D') && d.diff.includes('+k'), d.diff);
  check('two changes far apart are two hunks', W.unifiedDiff(
    Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n'),
    Array.from({ length: 40 }, (_, i) => (i === 2 || i === 35 ? `X${i}` : `l${i}`)).join('\n'),
  ).diff.split('\n').filter(l => l.startsWith('@@')).length === 2);
  eq('no change, no diff', W.unifiedDiff('same', 'same').diff, '');
  const { diffLines } = await import(pathToFileURL(path.join(ROOT, 'src/fileChanges.js')).href);
  check('the chat draws each diff line by its kind',
    diffLines('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same').map(l => l.kind).join() === 'file,file,hunk,del,add,ctx');

  /* -------------------------------------------------------------- writing */
  const target = path.join(work, 'src', 'App.jsx');
  const edited = W.editFile(target, 'const a = 1;', 'const a = 2;');
  const changes = W.fileChangesIn(edited);
  eq('an edit reports its change', changes.length, 1);
  check('as a diff of just that line', changes[0].diff.includes('-const a = 1;') && changes[0].diff.includes('+const a = 2;') && changes[0].added === 1, JSON.stringify(changes[0]));
  eq('and the file changed', fs.readFileSync(target, 'utf8').split('\n')[0], 'const a = 2;');
  let ambiguous = null;
  fs.writeFileSync(path.join(work, 'dup.txt'), 'x\nx\n');
  try { W.editFile(path.join(work, 'dup.txt'), 'x', 'y'); } catch (e) { ambiguous = e.message; }
  check('an ambiguous edit is refused, not guessed', /occurs 2 times/.test(ambiguous || ''));
  W.editFile(path.join(work, 'dup.txt'), 'x', 'y', { replaceAll: true });
  eq('unless replace_all', fs.readFileSync(path.join(work, 'dup.txt'), 'utf8'), 'y\ny\n');
  let missing = null;
  try { W.editFile(target, 'not in the file', 'z'); } catch (e) { missing = e.message; }
  check('text that is not there says so', /was not found/.test(missing || ''));

  const crlf = path.join(work, 'win.txt');
  fs.writeFileSync(crlf, 'one\r\ntwo\r\nthree\r\n');
  const crlfEdit = W.editFile(crlf, 'two', 'TWO');
  eq('a CRLF file keeps its line endings', fs.readFileSync(crlf, 'utf8'), 'one\r\nTWO\r\nthree\r\n');
  eq('and only the edited line is a change', W.fileChangesIn(crlfEdit)[0].added, 1);

  const created = W.writeFile(path.join(work, 'new', 'deep', 'file.md'), '# hi\n');
  check('writing a new file creates its folders and says Created', created.startsWith('Created') && fs.existsSync(path.join(work, 'new', 'deep', 'file.md')));
  const overwritten = W.writeFile(path.join(work, 'new', 'deep', 'file.md'), '# hello\n');
  check('overwriting shows what changed', W.fileChangesIn(overwritten)[0]?.diff.includes('+# hello'));

  /* ------------------------------------------------------------- commands */
  const ok = await W.runCommand('echo workbench-ok', { cwd: work });
  eq('a command runs, with its exit code', ok.code, 0);
  check('and its output', ok.output.includes('workbench-ok'), ok.output);
  const failing = await W.runCommand(process.platform === 'win32' ? 'exit /b 3' : 'exit 3', { cwd: work });
  eq('a failing command gives its exit code', failing.code, 3);
  const quoted = await W.runCommand(`node -e "console.log('a&b')"`, { cwd: work });
  check('quotes and & survive the shell', quoted.output.includes('a&b'), quoted.output);
  const slow = await W.runCommand(`node -e "setTimeout(()=>{},10000)"`, { cwd: work, timeoutMs: 1000 });
  check('a command past its time is stopped', slow.timedOut === true);
  const report = W.commandReport('npm test', work, ok);
  const parsed = W.commandIn(report);
  check('a command result names itself for the app', parsed?.command === 'npm test' && parsed.code === 0, report);

  /* ------------------------------------------- the real server, over MCP */
  fs.writeFileSync(path.join(work, 'mcp.json'), JSON.stringify({
    mcpServers: {
      bench: { command: process.execPath, args: [path.join(ROOT, 'server/mcpWorkbench.mjs'), work] },
      safe: { command: process.execPath, args: [path.join(ROOT, 'server/mcpWorkbench.mjs'), '--no-commands', work] },
    },
  }));
  const pool = createMcpPool({}, { cwd: work });
  const listed = await pool.listTools();
  const names = listed.tools.filter(t => t.server === 'bench').map(t => t.name).sort();
  eq('the server offers every tool', names.join(), 'edit_file,find_files,grep,read_file,run_command,write_file');
  check('--no-commands leaves run_command out', !listed.tools.some(t => t.server === 'safe' && t.name === 'run_command'));
  const read = await pool.callTool('bench', 'read_file', { path: big, offset: 10, limit: 2 });
  check('read_file over MCP', read.text.includes('10\tline 10'), read.text);
  const searched = await pool.callTool('bench', 'grep', { pattern: 'TOOLS_LIST', path: work });
  check('grep over MCP', searched.text.includes('tools.js'), searched.text);
  const viaMcp = await pool.callTool('bench', 'edit_file', { path: target, old_string: 'const a = 2;', new_string: 'const a = 3;' });
  check('an edit over MCP returns its diff', W.fileChangesIn(viaMcp.text)[0]?.diff.includes('+const a = 3;'), viaMcp.text);
  const outsideTry = await pool.callTool('bench', 'write_file', { path: path.join(outside, 'x.txt'), content: 'no' });
  check('writing outside its folders is refused, as a tool error', outsideTry.isError && !fs.existsSync(path.join(outside, 'x.txt')), outsideTry.text);
  const cmd = await pool.callTool('bench', 'run_command', { command: 'echo over-mcp', cwd: work });
  check('run_command over MCP', cmd.text.includes('over-mcp') && W.commandIn(cmd.text)?.code === 0, cmd.text);
  pool.close();
  await new Promise(r => setTimeout(r, 150));
} finally {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
