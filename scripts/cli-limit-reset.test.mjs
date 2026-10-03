import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleResets, backAt } from '../server/cliModels.js';

const H = 3600 * 1000;
const now = Date.UTC(2026, 9, 4, 12);

test('5-hour window reset clears "limit reached" while the weekly window still has room', () => {
  // The reported case: 5h was full and refused, weekly at 93%, 5h has since reset.
  const entry = {
    status: 'rejected', updatedAt: now - 3 * H,
    windows: [
      { id: 'five_hour', usedPercent: 100, resetsAt: now - 10 * 60 * 1000 },
      { id: 'seven_day', usedPercent: 93, resetsAt: now + 80 * H, forecast: { perHour: 1.1 } },
    ],
  };
  const out = settleResets(entry, now);
  assert.equal(out.status, 'allowed_warning');
  assert.equal(out.windows[0].reset, true);
  assert.equal(out.windows[0].usedPercent, 0);
  assert.equal(out.windows[1].reset, undefined);
  assert.equal(out.windows[1].forecast.perHour, 1.1);
  assert.equal(backAt(out, now), null);
});

test('stays blocked while another window is still full', () => {
  const out = settleResets({
    status: 'rejected', updatedAt: now - 3 * H,
    windows: [
      { id: 'five_hour', usedPercent: 100, resetsAt: now - H },
      { id: 'seven_day', usedPercent: 100, resetsAt: now + 50 * H },
    ],
  }, now);
  assert.equal(out.status, 'rejected');
});

test('a refusal heard only as an error waits for a reset after it', () => {
  const windows = [
    { id: 'five_hour', usedPercent: 60, resetsAt: now + 2 * H },
    { id: 'seven_day', usedPercent: 40, resetsAt: now + 90 * H },
  ];
  assert.equal(settleResets({ status: 'rejected', updatedAt: now - H, windows }, now).status, 'rejected');
  // A window that reset *before* the refusal does not end it.
  const before = [{ id: 'five_hour', usedPercent: 0, resetsAt: now - 2 * H }, windows[1]];
  assert.equal(settleResets({ status: 'rejected', updatedAt: now - H, windows: before }, now).status, 'rejected');
  // One that reset after it does.
  const after = [{ id: 'five_hour', usedPercent: 60, resetsAt: now - 1000 }, windows[1]];
  assert.equal(settleResets({ status: 'rejected', updatedAt: now - H, windows: after }, now).status, 'allowed');
});

test('a top-level reset time still in the future keeps the block', () => {
  const out = settleResets({
    status: 'rejected', updatedAt: now - 3 * H, resetsAt: now + H,
    windows: [{ id: 'five_hour', usedPercent: 100, resetsAt: now - 1000 }],
  }, now);
  assert.equal(out.status, 'rejected');
});

test('all windows reset still clears it, and non-refused entries are untouched', () => {
  const out = settleResets({
    status: 'rejected', updatedAt: now - 9 * H,
    windows: [{ id: 'five_hour', usedPercent: 100, resetsAt: now - H }],
  }, now);
  assert.equal(out.status, 'allowed');
  assert.equal(settleResets({ status: 'allowed_warning', windows: [] }, now).status, 'allowed_warning');
});
