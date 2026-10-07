import { useEffect, useState } from 'react';

/**
 * KaTeX and highlight.js, fetched after the first paint rather than with it.
 *
 * Together they were over a megabyte of the main bundle -- every grammar
 * highlight.js ships and all of KaTeX -- parsed before a phone showed its
 * first chat, though most screens have neither a formula nor a code block on
 * them yet. Until they arrive an answer renders as plain Markdown; when they
 * do, every answer re-renders once with them (AnswerMarkdown is memoised on
 * the plugin list, so that is one pass, not one per token).
 */
const EMPTY = Object.freeze([]);
let plugins = null;
let pending = null;
const listeners = new Set();

export const loadRichRehype = () => {
  if (plugins) return Promise.resolve(plugins);
  pending ||= Promise.all([
    import('rehype-katex'),
    import('rehype-highlight'),
    import('katex/dist/katex.min.css'),
  ]).then(([katex, highlight]) => {
    plugins = Object.freeze([katex.default, highlight.default]);
    listeners.forEach(fn => fn(plugins));
    listeners.clear();
    return plugins;
  }).catch((e) => { pending = null; throw e; });
  return pending;
};

/** The rich rehype plugins once loaded, an empty list until then. */
export const useRichRehype = () => {
  const [value, setValue] = useState(plugins || EMPTY);
  useEffect(() => {
    if (plugins) { setValue(plugins); return undefined; }
    listeners.add(setValue);
    // Soon, but not ahead of the first paint.
    const start = () => loadRichRehype().catch(() => {});
    const idle = typeof window !== 'undefined' && 'requestIdleCallback' in window
      ? window.requestIdleCallback(start, { timeout: 1500 })
      : setTimeout(start, 300);
    return () => {
      listeners.delete(setValue);
      if (typeof window !== 'undefined' && 'cancelIdleCallback' in window) window.cancelIdleCallback(idle);
      else clearTimeout(idle);
    };
  }, []);
  return value;
};
