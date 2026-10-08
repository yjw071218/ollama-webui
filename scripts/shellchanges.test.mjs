// Files changed from a shell command get the same 📝 cards as an Edit (server/shellChanges.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ShellChanges, pathsIn } from '../server/shellChanges.js';
import { ClaudeReader } from '../server/cliModels.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

check('Windows paths are found', pathsIn('python - C:\\a\\b.py "D:/x y"').includes('C:\\a\\b.py'));
check('Git Bash paths are found', pathsIn('cd /c/Artificial_Intelligence/x; sed -i s/a/b/ f').includes('C:/Artificial_Intelligence/x'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellchanges-'));
const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
try {
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'keep\n');
  git('add', '.'); git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'dirty already\n');   // changed before the command

  const t = new ShellChanges();
  t.watch([dir]);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');   // what the "command" does
  fs.writeFileSync(path.join(dir, 'new.txt'), 'hello\n');
  const reports = t.collect().join('\n');
  check('a changed tracked file is reported', /\[file-change\] .*a\.txt \(\+1 -1\)/.test(reports), reports);
  check('a new file is reported', /\[file-change\] .*new\.txt \(\+1 -0\)/.test(reports));
  check('a file that was already dirty and untouched is not', !/b\.txt/.test(reports));
  check('nothing twice', t.collect().length === 0);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\r\nTWO\r\nthree\r\n');
  check('line endings alone are not a change', t.collect().length === 0);

  // Through the reader, as a Claude run streams it.
  const r = new ClaudeReader();
  r.cwd = dir;
  const cmd = `sed -i s/three/THREE/ ${dir.replace(/\\/g, '/')}/a.txt`;
  r.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Bash', id: 't1' } } });
  r.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: cmd }) } } });
  r.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nTHREE\n');
  const out = r.accept({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '' }] } });
  check('a Bash run ends with a card for the file it changed', /📝 \*\*`[^`]*a\.txt`\*\* \(\+1 −1\)/.test(out?.content || ''), JSON.stringify(out));
  r.close();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
