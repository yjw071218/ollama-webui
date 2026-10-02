#!/usr/bin/env node
/* Runs the commands listed in package.json "test:all" (the old && chain),
   showing progress as it goes, in parallel, and keeps going after a failure.
   Any command containing "build" acts as a barrier: everything before it
   finishes first, it runs alone, then the rest continue.

   npm test                 everything
   npm test -- studio       only commands containing "studio"
   TEST_JOBS=8 npm test     concurrency (default: CPU count, max 8) */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const filter = process.argv.slice(2).join(' ').trim();
const all = String(pkg.scripts['test:all'] || '').split('&&').map(s => s.trim()).filter(Boolean);
const commands = filter ? all.filter(c => c.includes(filter)) : all;
const jobs = Math.max(1, Number(process.env.TEST_JOBS) || Math.min(8, cpus().length));

let done = 0;
const failures = [];
const started = Date.now();
const tty = process.stdout.isTTY;

const status = (msg) => {
  if (tty) process.stdout.write(`\r\x1b[K${msg}`);
};
const progress = () => status(`[${done}/${commands.length}] ${failures.length} failed · ${((Date.now() - started) / 1000).toFixed(0)}s`);
const ticker = setInterval(progress, 500);

const run = (command) => new Promise((resolve) => {
  const t0 = Date.now();
  const child = spawn(command, { shell: true, env: { ...process.env, FORCE_COLOR: '0' } });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('close', (code) => {
    done += 1;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    status('');
    if (code === 0) console.log(`${tty ? '\r\x1b[K' : ''}✓ ${command} (${secs}s)`);
    else { failures.push({ command, out }); console.log(`${tty ? '\r\x1b[K' : ''}✗ ${command} (${secs}s, exit ${code})`); }
    progress();
    resolve();
  });
});

const pool = async (list) => {
  const queue = [...list];
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (queue.length) await run(queue.shift());
  }));
};

console.log(`Running ${commands.length} test commands, ${jobs} at a time${filter ? ` (filter: "${filter}")` : ''}`);
let batch = [];
for (const command of commands) {
  if (/\bbuild\b/.test(command)) { await pool(batch); batch = []; await run(command); }
  else batch.push(command);
}
await pool(batch);
clearInterval(ticker);
status('');

for (const f of failures) console.log(`\n──── ✗ ${f.command}\n${f.out.trim().split('\n').slice(-40).join('\n')}`);
console.log(`\n${commands.length - failures.length}/${commands.length} passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(failures.length ? 1 : 0);
