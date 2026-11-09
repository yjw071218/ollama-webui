// The sidebar shows when a chat was last touched. Intl does the wording, so
// twelve UI languages come for free instead of twelve more translation keys.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// Anything older than a week reads better as a date than as "43 days ago".
const ABSOLUTE_AFTER = WEEK;

const UNITS = [
  [DAY, 'day'],
  [HOUR, 'hour'],
  [MINUTE, 'minute'],
];

/* Formatters are made once per locale and options, not per call.

   Constructing an Intl formatter is expensive -- it loads and resolves locale
   data -- and the sidebar calls both functions below for every row on every
   render. Profiled on a real 536-chat account, that was 3.5 s of main-thread
   time across three sent messages: half of everything the app did. */
const formatters = new Map();
const formatter = (Kind, locale, options) => {
  const key = `${Kind.name}|${locale}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) { f = new Kind(locale, options); formatters.set(key, f); }
  return f;
};

/* And results, because the same rows render again and again with the same
   inputs. Keyed to the minute for the relative form, which is its precision. */
const results = new Map();
const remember = (key, make) => {
  let v = results.get(key);
  if (v === undefined) {
    if (results.size > 5000) results.clear();
    v = make(); results.set(key, v);
  }
  return v;
};

export const relativeTime = (timestamp, locale = 'en', now = Date.now()) => {
  const at = Number(timestamp);
  if (!Number.isFinite(at) || at <= 0) return '';
  return remember(`r|${locale}|${at}|${Math.floor(now / MINUTE)}`, () => relativeUncached(at, locale, now));
};

const relativeUncached = (at, locale, now) => {

  const elapsed = now - at;

  // A clock that is a little behind, or a chat saved a moment ago, should not
  // read as being in the future.
  if (elapsed < MINUTE) {
    try {
      return formatter(Intl.RelativeTimeFormat, locale, { numeric: 'auto' }).format(0, 'second');
    } catch (e) {
      return 'just now';
    }
  }

  if (elapsed >= ABSOLUTE_AFTER) {
    const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
    try {
      return formatter(Intl.DateTimeFormat, locale, {
        month: 'short', day: 'numeric',
        ...(sameYear ? {} : { year: 'numeric' }),
      }).format(at);
    } catch (e) {
      return new Date(at).toISOString().slice(0, 10);
    }
  }

  for (const [size, unit] of UNITS) {
    if (elapsed >= size) {
      try {
        return formatter(Intl.RelativeTimeFormat, locale, { numeric: 'auto' })
          .format(-Math.floor(elapsed / size), unit);
      } catch (e) {
        return `${Math.floor(elapsed / size)} ${unit}s ago`;
      }
    }
  }

  return '';
};

// The full timestamp, for the row's tooltip.
export const absoluteTime = (timestamp, locale = 'en') => {
  const at = Number(timestamp);
  if (!Number.isFinite(at) || at <= 0) return '';
  return remember(`a|${locale}|${at}`, () => {
    try {
      return formatter(Intl.DateTimeFormat, locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
    } catch (e) {
      return new Date(at).toISOString();
    }
  });
};
