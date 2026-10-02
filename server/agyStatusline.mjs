#!/usr/bin/env node
/**
 * agy's status line, as a way of hearing what is left of its quota.
 *
 * Headless, agy says nothing about its limits -- no event in its stream, and
 * the figures it fetches are not logged. The one place it hands them over is
 * the custom status line: in the terminal, agy pipes a JSON state to this
 * script on stdin, `quota` included:
 *
 *     "quota": { "gemini-weekly": { "remaining_fraction": 0.93,
 *                "reset_time": "2026-07-06T07:50:32Z", "reset_in_seconds": 560580 } }
 *
 * So this keeps the parts the app shows -- quota, plan, when -- in
 * server/data/agy-quota.json, and prints a short line for the terminal (set
 * up with `stack_with_default`, so agy's own line is still there above it).
 * Installed into agy's settings by server/setupAgyStatusline.mjs.
 *
 * It must never break agy's screen: any failure prints nothing and exits 0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.WEBUI_DATA_DIR ? path.resolve(process.env.WEBUI_DATA_DIR) : path.join(HERE, 'data');
export const QUOTA_FILE = path.join(DATA, 'agy-quota.json');

const read = () => new Promise((resolve) => {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { text += chunk; });
  process.stdin.on('end', () => resolve(text));
  // A terminal with nothing piped in: do not wait for ever.
  setTimeout(() => resolve(text), 2000).unref();
});

const pct = (fraction) => `${Math.round(Math.max(0, Math.min(1, Number(fraction))) * 100)}%`;

try {
  const payload = JSON.parse((await read()) || '{}');
  const quota = payload.quota && typeof payload.quota === 'object' ? payload.quota : null;
  if (quota && Object.keys(quota).length) {
    fs.mkdirSync(DATA, { recursive: true });
    const record = { at: Date.now(), quota, plan: payload.plan_tier || '', model: payload.model?.display_name || payload.model?.id || '' };
    const tmp = `${QUOTA_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, QUOTA_FILE);
    const parts = Object.entries(quota)
      .filter(([, b]) => b && Number.isFinite(Number(b.remaining_fraction)))
      .map(([name, b]) => `${name} ${pct(b.remaining_fraction)} left`);
    if (parts.length) process.stdout.write(parts.join(' · '));
  }
} catch {
  /* Nothing on the line is better than a broken one. */
}
process.exit(0);
