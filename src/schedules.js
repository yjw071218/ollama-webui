/**
 * Asking the same question again, on a clock.
 *
 * "Every morning, summarise today's news into this chat." Everything needed to
 * answer that has been here for a long time -- the tools, the chat it belongs
 * in, the model -- and the only missing part was something to say *when*.
 *
 * ## What this can and cannot do, said plainly
 *
 * A turn is assembled in the browser: the system prompt, the persona, the
 * memories, the retrieved passages, the tool table. So a schedule fires **when
 * this app is open**. On the machine that runs the models that is most of the
 * time, and a missed one is caught up the next time it is opened -- but a
 * browser that is closed all weekend does not answer anything on Saturday, and
 * this file will not pretend otherwise. Moving turn assembly to the server is
 * what would change that, and it is a different piece of work.
 *
 * ## Why they do not sync
 *
 * A schedule belongs to a device, deliberately. Synced, every device signed in
 * would fire the same schedule at the same minute and the chat would get three
 * copies of the answer -- and the obvious fix, electing one device, is a
 * distributed lock in a chat app. The machine that is open is the machine that
 * runs it.
 *
 * ## The catch-up rule
 *
 * A schedule that came due while the app was closed runs once, on the next
 * open, and only if it is still roughly the right time of day -- a "7am news
 * summary" arriving at 11pm is not what anybody asked for, and three days of
 * missed summaries arriving at once is worse. Anything staler than the grace
 * is skipped to the next slot, which is the difference between a schedule and
 * a backlog.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export const EVERY = ['hour', 'day', 'week'];

const period = (every) => (every === 'hour' ? HOUR : every === 'week' ? 7 * DAY : DAY);

/* How late a missed run may be and still be worth doing. A quarter of its own
   period: an hourly job is fifteen minutes, a daily one six hours. */
const graceFor = (every) => period(every) / 4;

/** `HH:MM` as minutes past midnight; null when it is not a time. */
export const minutesOf = (at) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(at || '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

export const newSchedule = ({ chat, prompt, every = 'day', at = '08:00' }, now = Date.now()) => ({
  id: `sch-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
  chat: String(chat || ''),
  prompt: String(prompt || '').trim(),
  every: EVERY.includes(every) ? every : 'day',
  at,
  enabled: true,
  createdAt: now,
  // Never run. The first firing is the next slot, not the moment it is made:
  // a schedule created at 3pm for 8am should not answer immediately.
  lastRunAt: 0,
});

/**
 * When this schedule should next fire, from a given moment.
 *
 * Anchored on the wall clock rather than on when it was created: "every day at
 * 08:00" means 08:00, whatever time the schedule was written at, and an hourly
 * one means on the minute named -- 08:15, 09:15 -- which is what makes two
 * schedules at the same time actually happen at the same time.
 */
export const nextDue = (schedule, from = Date.now()) => {
  if (!schedule?.enabled || !schedule.prompt) return null;
  const wanted = minutesOf(schedule.at);
  const start = new Date(from);

  if (schedule.every === 'hour') {
    const minute = wanted === null ? 0 : wanted % 60;
    const slot = new Date(start);
    slot.setMinutes(minute, 0, 0);
    if (slot.getTime() <= from) slot.setTime(slot.getTime() + HOUR);
    return slot.getTime();
  }

  const slot = new Date(start);
  slot.setHours(Math.floor((wanted ?? 8 * 60) / 60), (wanted ?? 0) % 60, 0, 0);
  if (slot.getTime() <= from) slot.setTime(slot.getTime() + DAY);
  if (schedule.every === 'week') {
    // The same weekday it was made on, which is the only day anybody means by
    // "every week" without saying which.
    const wantedDay = new Date(schedule.createdAt || from).getDay();
    while (slot.getDay() !== wantedDay) slot.setTime(slot.getTime() + DAY);
  }
  return slot.getTime();
};

/**
 * Whether it is time, allowing for the app having been closed.
 *
 * True when the last slot that has already passed is one this schedule has not
 * run, and that slot is not so old that answering it now would be answering
 * yesterday's question.
 */
export const isDue = (schedule, now = Date.now()) => {
  if (!schedule?.enabled || !schedule.prompt || !schedule.chat) return false;
  // The slot before now: the next one measured from a period ago.
  const slot = nextDue(schedule, now - period(schedule.every));
  if (slot === null || slot > now) return false;
  if ((schedule.lastRunAt || 0) >= slot) return false;
  return now - slot <= graceFor(schedule.every);
};

/** The ones to run, oldest slot first so a backlog comes out in order. */
export const dueNow = (schedules, now = Date.now()) => (schedules || [])
  .filter(schedule => isDue(schedule, now))
  .sort((a, b) => (a.lastRunAt || 0) - (b.lastRunAt || 0));

/** Marked as run, whether or not the answer was any good. */
export const noteRun = (schedules, id, now = Date.now()) => (schedules || [])
  .map(schedule => (schedule.id === id ? { ...schedule, lastRunAt: now } : schedule));

/* ------------------------------------------------------------------ storage

   Per device and per account. See the note at the top for why these do not
   travel with the rest of an account's records. */

const keyFor = (scope) => `schedules:${scope || 'guest'}`;

export const loadSchedules = (scope) => {
  try {
    const raw = localStorage.getItem(keyFor(scope));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(s => s && s.id) : [];
  } catch (e) {
    return [];
  }
};

export const saveSchedules = (scope, schedules) => {
  try { localStorage.setItem(keyFor(scope), JSON.stringify(schedules || [])); }
  catch (e) { /* a schedule that cannot be saved is one that does not exist */ }
};
