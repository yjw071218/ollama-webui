#!/usr/bin/env node
/**
 * Runs one long-lived program with a hidden console, for spawnDetachedHidden.
 *
 *     node hiddenLaunch.mjs <base64 JSON {command, args}>
 *
 * On Windows a `detached: true` child is created with DETACHED_PROCESS: it has
 * no console at all, and `windowsHide` is ignored. Every console program *it*
 * starts then gets a brand-new console window -- Ollama's llama-server runner
 * on each model load, a Python engine's ffmpeg or nvidia-smi -- which flashed
 * on screen. This launcher is the detached one; the real program is its
 * ordinary child with stdio piped, which Node creates with CREATE_NO_WINDOW:
 * a console that exists but is never shown, inherited by everything below it.
 *
 * Output goes to this launcher's stdout/stderr (the log file the caller
 * opened). It exits with the program's exit code, and since the program sits
 * in this process's kill-on-close job, killing the launcher stops it too.
 */
import { spawn } from 'node:child_process';

let spec;
try {
  spec = JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString('utf8'));
} catch {
  process.stderr.write('hiddenLaunch: bad arguments\n');
  process.exit(2);
}

const child = spawn(spec.command, spec.args || [], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('error', (e) => {
  process.stderr.write(`could not start ${spec.command}: ${e.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => { try { child.kill(); } catch { /* gone */ } process.exit(1); });
}
