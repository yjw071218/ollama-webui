// Silences one specific warning, and nothing else.
//
// `node:sqlite` prints an ExperimentalWarning every time it is loaded, which
// lands in the middle of the startup banner and looks like something is wrong.
// It is not: the API this uses — DatabaseSync, prepare, run, transactions — has
// been stable across releases, and the alternative is a native dependency that
// has to be rebuilt for every Node version.
//
// The filter matches that one message and passes everything else through, so a
// real warning is still a real warning. Blanket `--no-warnings` would hide
// deprecations and unhandled rejections too, which is how a warning nobody
// wanted to see becomes a bug nobody saw.
//
// This must be imported before anything that pulls in node:sqlite. ES modules
// are evaluated in import order, so it goes first in the file that needs it.

const original = process.emitWarning.bind(process);

process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === 'string' ? warning : (warning?.message || '');
  if (/SQLite is an experimental feature/i.test(text)) return undefined;
  return original(warning, ...rest);
};
