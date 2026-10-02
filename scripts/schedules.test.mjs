// Asking the same question again, on a clock.
//
// "Every morning, summarise today's news into this chat." Everything needed to
// answer that had been here for a long time -- the tools, the chat it belongs
// in, the model -- and the only missing part was something to say *when*.
//
// The arithmetic is what this file is for, and all of it has a wrong answer
// that looks reasonable: a schedule made at 3pm for 8am must not fire
// immediately, a missed one must be caught up *once* rather than three times,
// and one missed by two days must not answer on the third as though nothing
// had happened. None of that can be seen by looking at the screen.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// The module reaches for localStorage when it stores; the arithmetic does not.
const held = new Map();
globalThis.localStorage = {
  getItem: (k) => (held.has(k) ? held.get(k) : null),
  setItem: (k, v) => held.set(k, String(v)),
  removeItem: (k) => held.delete(k),
};

const S = await import(pathToFileURL(path.join(ROOT, 'src/schedules.js')).href);

/* --------------------------------------------------------------- the clock */

eq('a time is minutes past midnight', S.minutesOf('08:30'), 510);
eq('  written short or long', S.minutesOf('8:05'), 485);
eq('  and anything else is not a time', [S.minutesOf('25:00'), S.minutesOf('08:60'), S.minutesOf('nope')], [null, null, null]);

const at = (text) => new Date(text).getTime();

{
  // Made at 3pm for 8am. The first firing is tomorrow morning, not this
  // instant -- a schedule that answers the moment it is written is a schedule
  // nobody would write a second one of.
  const made = at('2026-03-10T15:00:00');
  const daily = S.newSchedule({ chat: '1', prompt: 'the news', every: 'day', at: '08:00' }, made);
  eq('a new schedule has never run', daily.lastRunAt, 0);
  eq('  and its first firing is the next slot, not now',
    new Date(S.nextDue(daily, made)).toISOString().slice(0, 16),
    new Date(at('2026-03-11T08:00:00')).toISOString().slice(0, 16));
  check('  so it is not due the moment it is made', S.isDue(daily, made) === false);
}

{
  // On the minute named, which is what makes two schedules at the same time
  // actually happen at the same time.
  const hourly = S.newSchedule({ chat: '1', prompt: 'x', every: 'hour', at: '00:15' }, at('2026-03-10T09:00:00'));
  eq('an hourly one is on the minute it names',
    new Date(S.nextDue(hourly, at('2026-03-10T09:20:00'))).getMinutes(), 15);
  eq('  and the next one is an hour later',
    new Date(S.nextDue(hourly, at('2026-03-10T09:20:00'))).getHours(), 10);
}

/* ------------------------------------------------------------ being due */

{
  const daily = {
    ...S.newSchedule({ chat: '1', prompt: 'the news', every: 'day', at: '08:00' }, at('2026-03-10T15:00:00')),
  };
  check('it is due just after its time', S.isDue(daily, at('2026-03-11T08:00:30')));
  // The app was closed at 8. Opened at 11, the morning summary is still the
  // morning summary.
  check('  and still due a few hours later, which is the catch-up',
    S.isDue(daily, at('2026-03-11T11:00:00')));
  /* But not at 11pm. A "7am news summary" arriving at bedtime is not what
     anybody asked for, and this is the difference between a schedule and a
     backlog. */
  check('  and not once the day has moved on', S.isDue(daily, at('2026-03-11T23:00:00')) === false);

  const ran = S.noteRun([daily], daily.id, at('2026-03-11T08:01:00'))[0];
  check('once run, it is not due again for that slot', S.isDue(ran, at('2026-03-11T09:00:00')) === false);
  check('  and is due again at the next one', S.isDue(ran, at('2026-03-12T08:00:30')));
  // Two days closed. One answer, not two.
  const stale = S.noteRun([daily], daily.id, at('2026-03-09T08:00:00'))[0];
  const due = S.dueNow([stale], at('2026-03-12T08:30:00'));
  eq('  and a weekend away is one answer, not three', due.length, 1);
}

{
  const off = { ...S.newSchedule({ chat: '1', prompt: 'x' }, at('2026-03-10T15:00:00')), enabled: false };
  check('a schedule that is switched off is never due', S.isDue(off, at('2026-03-11T08:00:30')) === false);
  const empty = S.newSchedule({ chat: '1', prompt: '   ' }, at('2026-03-10T15:00:00'));
  check('  nor is one with nothing to ask', S.isDue(empty, at('2026-03-11T08:00:30')) === false);
  const homeless = S.newSchedule({ chat: '', prompt: 'x' }, at('2026-03-10T15:00:00'));
  check('  nor one with no conversation to ask it in', S.isDue(homeless, at('2026-03-11T08:00:30')) === false);
}

{
  // A backlog comes out oldest first, so the answers land in the order they
  // were meant to.
  const a = { ...S.newSchedule({ chat: '1', prompt: 'a' }, at('2026-03-01T15:00:00')), lastRunAt: at('2026-03-10T08:00:00') };
  const b = { ...S.newSchedule({ chat: '1', prompt: 'b' }, at('2026-03-01T15:00:00')), lastRunAt: at('2026-03-09T08:00:00') };
  eq('the oldest missed one goes first',
    S.dueNow([a, b], at('2026-03-11T08:30:00')).map(s => s.prompt), ['b', 'a']);
}

/* ------------------------------------------------------------- where they live */

S.saveSchedules('user-a', [S.newSchedule({ chat: '1', prompt: 'x' })]);
eq('a schedule is kept for the account that made it', S.loadSchedules('user-a').length, 1);
eq('  and another account has none', S.loadSchedules('user-b').length, 0);
eq('  a store with nothing in it is not an error', S.loadSchedules('nobody'), []);

/* ------------------------------------------------------------------ the wiring */

const app = read('src/App.jsx');
check('the app looks for due schedules on a timer', /const \[due\] = dueNow\(schedules, Date\.now\(\)\);/.test(app));
// One turn at a time, and never over one somebody is in the middle of.
check('  and never over a turn already running',
  /if \(firingRef\.current \|\| isGeneratingRef\.current\) return;/.test(app));
/* Marked as run before it is run: a failure that is retried every thirty
   seconds for the rest of the day is worse than a failure. */
check('  marking it run before running it', /setSchedules\(list => noteRun\(list, due\.id\)\);/.test(app));
// A schedule pointing at a conversation that is gone would try for ever.
check('  and dropping one whose conversation is gone',
  /setSchedules\(list => list\.filter\(s => s\.id !== due\.id\)\);/.test(app));
check('the answer goes to the chat it was scheduled for',
  /setCurrentSessionId\(chat\.id\);\s*\n\s*setInput\(due\.prompt\);/.test(app));

const i18n = read('src/i18n.jsx');
for (const key of ['schedule.title', 'schedule.help', 'schedule.every.day', 'schedule.next']) {
  check(`${key} is translated everywhere`,
    (i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length === 12);
}
// What it cannot do is written down where somebody will read it before
// wondering why Saturday was quiet.
check('and the limit is stated in the module that has it',
  /a schedule fires \*\*when\s*\n \* this app is open\*\*/.test(read('src/schedules.js')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
