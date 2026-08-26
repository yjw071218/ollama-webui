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

export const relativeTime = (timestamp, locale = 'en', now = Date.now()) => {
  const at = Number(timestamp);
  if (!Number.isFinite(at) || at <= 0) return '';

  const elapsed = now - at;

  // A clock that is a little behind, or a chat saved a moment ago, should not
  // read as being in the future.
  if (elapsed < MINUTE) {
    try {
      return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'second');
    } catch (e) {
      return 'just now';
    }
  }

  if (elapsed >= ABSOLUTE_AFTER) {
    const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
    try {
      return new Intl.DateTimeFormat(locale, {
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
        return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
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
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
  } catch (e) {
    return new Date(at).toISOString();
  }
};
