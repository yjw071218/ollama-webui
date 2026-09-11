/**
 * Which model should answer this one.
 *
 * A machine with eight models installed has eight models because no one of
 * them is right for everything: a 3B answers "what's the flag of Peru" in
 * two seconds and writes unusable code; a 30B writes good code and takes four
 * minutes to say "Peru's flag is red and white". The app already lets you
 * change model in one click, which means the cost is not the click — it is
 * *remembering*, every single time, before you have started typing.
 *
 * So: rules. "Code goes to the coder model, images go to the one that can see,
 * everything else goes to the fast one." Written once, applied per message.
 *
 * ## What this deliberately is not
 *
 * It is not a classifier. There is no model deciding what your question is
 * about, because that would be a round trip before every message to answer a
 * question the wording usually settles outright — and when it got it wrong you
 * would have no way to tell. Every condition here is decidable by looking at
 * the message: a fenced block is code, an attached image is vision, a long
 * conversation is long. If none of them fits, nothing routes and the model you
 * chose answers.
 *
 * ## It must never fight you
 *
 * The moment somebody picks a model by hand in a chat, routing stops for that
 * chat. A feature that quietly puts the model back after you changed it is not
 * a convenience, it is a bug you cannot report — and the whole value of this
 * rests on trusting what the selector says.
 */

/**
 * The conditions, in the order they are offered.
 *
 * Deliberately five. Each is decidable from the message itself; a sixth that
 * needed a guess ("is this a translation?", "is this urgent?") would be the
 * one that makes the rest untrustworthy.
 */
export const CONDITIONS = ['vision', 'code', 'long', 'short', 'always'];

/** A conversation past this many tokens is "long". */
export const LONG_TOKENS = 6000;
/** A question under this many is "short" — the case a small model is for. */
export const SHORT_TOKENS = 40;

const CODE_MARKERS = [
  /```/,                                   // a fence, in either direction
  /^\s{4,}\S/m,                            // an indented block
  /\b(function|const|let|var|class|def|import|package|SELECT|INSERT)\b/,
  /[{};]\s*$/m,                            // a line ending in a brace or semicolon
  /\b\w+\([^)]*\)\s*[{:;]/,                // a call or signature
  /<\/?[a-z][\w-]*\s*\/?>/i,               // a tag
];

/**
 * What is true about this message.
 *
 * Counted rather than guessed. `tokens` is the caller's estimate of the whole
 * turn including history, because "long" is a fact about the conversation and
 * not about the sentence just typed — a one-word follow-up in a chat that is
 * already 20k tokens deep is a long request.
 */
export const signalsFor = ({ text = '', images = 0, tokens = 0 } = {}) => {
  const body = String(text || '');
  const code = CODE_MARKERS.some(pattern => pattern.test(body));
  return {
    vision: images > 0,
    code,
    long: tokens >= LONG_TOKENS,
    // A short question that is code is a code question. The fast-model rule
    // should not intercept "why does this segfault" because it was terse.
    short: !code && images === 0 && tokens > 0 && tokens < SHORT_TOKENS,
    tokens,
  };
};

let counter = 0;
export const newRule = (when, model) => ({
  id: `r${Date.now().toString(36)}${(counter++).toString(36)}`,
  when: CONDITIONS.includes(when) ? when : 'always',
  model: String(model || ''),
  enabled: true,
});

export const routingStorageKey = (userId) => (userId ? `modelRules:${userId}` : 'modelRules');

export const loadRules = (userId) => {
  try {
    const raw = JSON.parse(localStorage.getItem(routingStorageKey(userId)) || 'null');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(rule => rule && typeof rule.model === 'string')
      .map(rule => ({
        id: rule.id || newRule(rule.when, rule.model).id,
        when: CONDITIONS.includes(rule.when) ? rule.when : 'always',
        model: rule.model,
        enabled: rule.enabled !== false,
      }));
  } catch (e) {
    return [];
  }
};

export const saveRules = (userId, rules) => {
  try { localStorage.setItem(routingStorageKey(userId), JSON.stringify(rules || [])); }
  catch (e) { /* quota, or storage disabled */ }
};

/**
 * Where a message should go.
 *
 * Returns `null` when nothing applies, which is the common case and the one
 * that has to be cheap: no rules, or a chat whose model was chosen by hand.
 *
 * A rule naming a model that is not installed is skipped rather than honoured.
 * The same library of rules is meant to survive being carried to another
 * machine — a laptop without the 30B on it should fall through to the next
 * rule, not fail to send.
 */
export const routeFor = ({
  rules = [],
  signals = {},
  installed = [],
  current = '',
  manual = false,
  supportsVision = () => true,
} = {}) => {
  // Chosen by hand in this chat. Routing that puts the model back after you
  // changed it is a bug nobody can report.
  if (manual) return null;

  const have = new Set(installed);
  const usable = (rules || []).filter(rule => rule && rule.enabled && have.has(rule.model));

  /* Images first, and not as an ordinary rule.
     A text-only model handed an image does not answer badly, it fails — so
     this is a correctness fix rather than a preference, and it applies even
     when no rule mentions vision. */
  if (signals.vision && !supportsVision(current)) {
    const byRule = usable.find(rule => rule.when === 'vision' && supportsVision(rule.model));
    const anySighted = (installed || []).find(model => supportsVision(model));
    const model = byRule?.model || anySighted;
    if (model && model !== current) {
      return { model, when: 'vision', rule: byRule || null, forced: !byRule };
    }
    return null;
  }

  for (const rule of usable) {
    if (rule.when === 'always' || signals[rule.when]) {
      if (rule.model === current) return null;    // already there; nothing to say
      return { model: rule.model, when: rule.when, rule, forced: false };
    }
  }
  return null;
};

/**
 * Rules worth starting from, guessed from what is installed.
 *
 * Offered as a filled-in form rather than applied: the guesses come from model
 * *names*, which is a real signal (people who ship a coding model say so in
 * the tag) and not a reliable one. Somebody who accepts them gets a working
 * setup in one click and can see exactly what they accepted.
 */
export const suggestRules = (installed = [], { supportsVision = () => false } = {}) => {
  const names = (installed || []).filter(Boolean);
  if (names.length === 0) return [];

  const find = (pattern) => names.find(name => pattern.test(name));
  const coder = find(/coder|code|deepseek|qwen[\w.]*-?coder|starcoder|codestral/i);
  const sighted = names.find(name => supportsVision(name));

  // Size is in the tag far more often than not, and where it is not this
  // simply finds nothing rather than guessing wrongly.
  const sizeOf = (name) => {
    const match = /[:\-_](\d+(?:\.\d+)?)\s*b\b/i.exec(name) || /\b(\d+(?:\.\d+)?)b\b/i.exec(name);
    return match ? parseFloat(match[1]) : null;
  };
  const sized = names.map(name => ({ name, size: sizeOf(name) })).filter(entry => entry.size !== null);
  const smallest = sized.slice().sort((a, b) => a.size - b.size)[0];
  const largest = sized.slice().sort((a, b) => b.size - a.size)[0];

  const rules = [];
  if (sighted) rules.push(newRule('vision', sighted));
  if (coder) rules.push(newRule('code', coder));
  // Only when there is a real spread. Suggesting "long goes to the 8B" on a
  // machine that has one model is advice about nothing.
  if (largest && smallest && largest.size >= smallest.size * 3) {
    rules.push(newRule('long', largest.name));
    rules.push(newRule('short', smallest.name));
  }
  return rules;
};
