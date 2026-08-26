// Reading and editing a .env file in place, preserving comments and order.
//
// The obvious regex for this is wrong in a way that is easy to miss:
//
//   /^\s*KEY\s*=\s*(.*)$/m
//
// `\s` matches newlines, so on an empty `KEY=` the `\s*` after the `=` walks
// forward over the blank line and captures a *later* line's text. An unset key
// then reads as set. Matching horizontal whitespace only is the whole fix.

const HORIZONTAL = '[^\\S\\r\\n]*';

const lineMatcher = (key) =>
  new RegExp(`^${HORIZONTAL}${key}${HORIZONTAL}=(.*)$`, 'm');

const unquote = (value) =>
  String(value ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');

/** The value of `key`, or '' when it is absent, empty, or only a comment. */
export const readEnvValue = (text, key) => {
  const match = String(text ?? '').match(lineMatcher(key));
  if (!match) return '';
  // A trailing `# note` is a comment, not part of the value — but only when it
  // is separated, so a token containing '#' survives.
  return unquote(match[1].replace(/\s+#.*$/, ''));
};

/** `text` with `key` set to `value`, replacing the line if it already exists. */
export const writeEnvValue = (text, key, value) => {
  const source = String(text ?? '');
  const line = `${key}=${value}`;
  if (lineMatcher(key).test(source)) return source.replace(lineMatcher(key), line);
  return `${source.replace(/\s*$/, '')}\n${line}\n`;
};

/**
 * Fills in the settings a launcher needs, without touching anything already
 * set. Returns the new text and a note for each thing it decided.
 *
 * `forNetwork` is what the desktop launcher passes: a value of 127.0.0.1 is a
 * sensible default in the example file and exactly wrong when the point is to
 * open the page on a phone, so it is the one existing value that gets replaced.
 */
export const prepareEnv = (text, { forNetwork = false, makeToken } = {}) => {
  let next = String(text ?? '');
  const notes = [];

  const host = readEnvValue(next, 'HOST');
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!host || (forNetwork && loopback)) {
    next = writeEnvValue(next, 'HOST', '0.0.0.0');
    notes.push({ key: 'HOST', value: '0.0.0.0', why: 'reachable from other devices' });
  }

  if (!readEnvValue(next, 'PORT')) {
    next = writeEnvValue(next, 'PORT', '8080');
    notes.push({ key: 'PORT', value: '8080', why: '' });
  }

  if (!readEnvValue(next, 'ACCESS_TOKEN')) {
    // Only asked for from outside this network, but it has to exist before the
    // server will bind anywhere but loopback.
    next = writeEnvValue(next, 'ACCESS_TOKEN', makeToken());
    notes.push({ key: 'ACCESS_TOKEN', value: null, why: 'generated, for access from outside' });
  }

  return { text: next, notes };
};
