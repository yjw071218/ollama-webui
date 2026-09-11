// What has been done with the app, as opposed to what the machine is doing.
//
// The traps here are all about honesty. A total that silently mixes Ollama's
// real token counts with a chars-over-four estimate is a number nobody should
// quote. A daily chart drawn only from the days that have data shows constant
// activity no matter how sporadic the use was. A streak that resets at
// midnight tells somebody they have broken it before they have got up.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({ input: path.resolve(ROOT, 'src/usage.js'), platform: 'neutral' });
const out = path.resolve(ROOT, 'node_modules/.usage-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const U = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const DAY = 24 * 60 * 60 * 1000;
// A fixed local noon, so nothing here depends on the hour the suite runs.
const at = (daysAgo, hour = 12) => {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.getTime() - daysAgo * DAY;
};

const chat = (id, messages, extra = {}) => ({
  id, title: `chat ${id}`, createdAt: at(10), updatedAt: at(0),
  messages, lastModel: 'a:8b', ...extra,
});

/* ------------------------------------------------------------ flattening */

const sessions = [
  chat(1, [
    { role: 'user', content: 'hello there', at: at(2) },
    { role: 'assistant', content: 'hi', at: at(2), model: 'a:8b', metrics: { tokensPerSec: 40, evalCount: 120 } },
  ]),
  chat(2, [
    { role: 'user', content: 'second question', at: at(1) },
    { role: 'assistant', content: 'a longer answer here', at: at(1), model: 'b:30b', metrics: { tokensPerSec: 8, evalCount: 400 } },
    { role: 'user', content: 'and a follow-up', at: at(0) },
    { role: 'assistant', content: 'more', at: at(0), model: 'b:30b', metrics: { tokensPerSec: 10, evalCount: 90 } },
  ]),
];

eq('every message is counted', U.allMessages(sessions).length, 6);
// A draft has never been sent. Counting it would make "chats" a count of
// times the New Chat button was pressed.
eq('a draft is not a conversation',
  U.allMessages([...sessions, chat(3, [{ role: 'user', content: 'x' }], { draft: true })]).length, 6);
eq('and neither is a malformed one', U.allMessages([null, { id: 4 }]).length, 0);
// Messages predate timestamps. Dropping them would lose the oldest history,
// which is exactly what a trend needs.
eq('an undated message inherits the chat date',
  U.allMessages([chat(5, [{ role: 'user', content: 'old' }])])[0].at, at(10));

/* -------------------------------------------------------------- the totals */

const summary = U.usageSummary(sessions, at(0));
eq('chats are counted', summary.chats, 2);
eq('questions and answers separately', `${summary.asks}/${summary.answers}`, '3/3');
eq('output tokens come from the real counts', summary.outTokens, 120 + 400 + 90);
// Half measured and half guessed is a number nobody should quote, so the panel
// is told which it is holding.
eq('and the panel is told they were all measured', summary.measuredShare, 1);
eq('an answer with no metrics is estimated instead',
  U.usageSummary([chat(9, [{ role: 'assistant', content: 'x'.repeat(400), at: at(0) }])]).measuredShare, 0);
check('with a plausible figure',
  U.usageSummary([chat(9, [{ role: 'assistant', content: 'x'.repeat(400), at: at(0) }])]).outTokens === 100);
eq('speed is the median, not the mean', summary.medianSpeed, 10);
eq('active days are days, not messages', summary.activeDays, 3);
eq('nothing at all is zeroes, not NaN', U.usageSummary([]).messages, 0);
eq('and no dates rather than a 1970 one', U.usageSummary([]).firstAt, null);

/* ---------------------------------------------------------------- by day */

const week = U.activityByDay(sessions, 7, at(0));
eq('a week is seven rows', week.length, 7);
// The gaps are the point: a chart drawn only from the days that have data
// shows steady use no matter how sporadic it was.
eq('including the empty days', week.filter(d => d.messages === 0).length, 4);
eq('today is last', week[6].messages, 2);
eq('and two days ago is where it belongs', week[4].messages, 2);
eq('chats are counted once per day, not once per message', week[5].chats, 1);

/* -------------------------------------------------------------- by model */

const models = U.byModel(sessions);
eq('the most used model is first', models[0].model, 'b:30b');
eq('with its answer count', models[0].answers, 2);
eq('its share', Math.round(models[0].share * 100), 67);
eq('its tokens', models[0].outTokens, 490);
eq('and its median speed', models[0].medianSpeed, 9);
eq('a model that never answered is not a row', models.length, 2);

/* --------------------------------------------------------------- by hour */

const hours = U.byHour([chat(6, [
  { role: 'user', content: 'a', at: at(0, 9) },
  { role: 'assistant', content: 'b', at: at(0, 9) },
  { role: 'user', content: 'c', at: at(0, 23) },
])]);
eq('there are always twenty-four buckets', hours.length, 24);
eq('nine in the morning holds two', hours[9].messages, 2);
eq('and eleven at night holds one', hours[23].messages, 1);
eq('an empty hour is zero, not missing', hours[3].messages, 0);

/* ---------------------------------------------------------------- drift */

// Deliberately conservative: "your machine is degrading" is unwelcome advice
// to receive wrongly, so it wants a real sample and a large difference.
const drifting = chat(7, Array.from({ length: 30 }, (_, i) => ({
  role: 'assistant', content: 'x', at: at(30 - i), model: 'a:8b',
  metrics: { tokensPerSec: i < 15 ? 40 : 12 },
})));
const drift = U.speedDrift([drifting], 'a:8b');
eq('a real slowdown is reported', drift.direction, 'slower');
eq('with both ends named', `${drift.early}->${drift.late}`, '40->12');
eq('a steady machine says nothing',
  U.speedDrift([chat(8, Array.from({ length: 30 }, (_, i) => ({
    role: 'assistant', content: 'x', at: at(30 - i), model: 'a:8b',
    metrics: { tokensPerSec: 40 + (i % 3) },
  })))], 'a:8b'), null);
eq('and neither does too small a sample', U.speedDrift([drifting].slice(0, 0), 'a:8b'), null);
eq('a speed-up is reported as one',
  U.speedDrift([chat(11, Array.from({ length: 30 }, (_, i) => ({
    role: 'assistant', content: 'x', at: at(30 - i), model: 'a:8b',
    metrics: { tokensPerSec: i < 15 ? 10 : 40 },
  })))], 'a:8b').direction, 'faster');

/* --------------------------------------------------------- biggest chats */

const biggest = U.biggestChats(sessions, 5);
eq('the largest conversation is first', biggest[0].id, 2);
eq('measured in tokens rather than turns', biggest[0].tokens > biggest[1].tokens, true);
eq('the list is capped', U.biggestChats(sessions, 1).length, 1);
eq('and a draft is not in it',
  U.biggestChats([...sessions, chat(12, [{ role: 'user', content: 'x'.repeat(9999) }], { draft: true })])[0].id, 2);

/* -------------------------------------------------------------- streaks */

const daily = (days) => [chat(13, days.map(d => ({ role: 'user', content: 'x', at: at(d) })))];
eq('three days running is a streak of three', U.streaks(daily([0, 1, 2]), at(0)).current, 3);
// Not having opened the app yet this morning is not a broken streak.
eq('yesterday still counts as unbroken', U.streaks(daily([1, 2, 3]), at(0)).current, 3);
eq('but the day before does not', U.streaks(daily([2, 3, 4]), at(0)).current, 0);
eq('the longest run is remembered even after a gap',
  U.streaks(daily([0, 5, 6, 7, 8]), at(0)).longest, 4);
eq('nothing at all is zero', U.streaks([], at(0)).current, 0);

/* ------------------------------------------------------------- the wiring */

const panel = fs.readFileSync(path.join(ROOT, 'src/UsagePanel.jsx'), 'utf8').replace(/\r\n/g, '\n');
check('the panel shows the daily chart', /activityByDay\(/.test(panel));
check('which models get used', /byModel\(/.test(panel));
check('when the work happens', /byHour\(/.test(panel));
check('and says when a total was estimated rather than measured',
  /measuredShare/.test(panel));

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
check('the panel is reachable', /<UsagePanel/.test(app));
check('and is given the chats it reports on', /sessions=\{sessions\}/.test(app));

const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8').replace(/\r\n/g, '\n');
for (const key of ['usage.title', 'usage.byModel', 'usage.whenYouWork',
  'usage.estimated', 'usage.streak', 'usage.slowingDown']) {
  eq(`every language has "${key}"`, (i18n.split(`'${key}':`).length - 1), 12);
}

const css = fs.readFileSync(path.join(ROOT, 'src/extras.css'), 'utf8');
for (const cls of ['usage-grid', 'usage-days', 'usage-hours', 'usage-model-row']) {
  check(`.${cls} is styled`, css.includes(`.${cls}`));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
