/**
 * One prompt, many pictures: `{red|blue|silver} hair` and `__poses__`.
 *
 * The Studio could already vary a number across a batch -- the sweep, and the
 * seed lock that makes one word's effect visible. What it could not do is vary
 * a *word*, which is most of what anybody exploring a prompt wants: the same
 * character in four hair colours, the same scene at four times of day. That
 * meant four prompts typed by hand, or one prompt and four edits.
 *
 * Two forms, both what other Stable Diffusion tools have taught people to type:
 *
 *   * `{a|b|c}` -- one of these, written inline. Nothing to set up.
 *   * `__name__` -- one line of a named list, for choices too long to write out
 *     every time (twenty poses, a palette of outfits). Lists are kept as one
 *     setting, one list per line: `poses: standing | sitting | lying on side`.
 *
 * Expanded once per picture, on the server just before the prompt is used, so
 * each picture of a batch draws its own choices and the prompt recorded beside
 * a picture is the one it was actually drawn from.
 *
 * Pure: `pick` is injected so a test can say which choice is made.
 */

/* Deep enough for `{a|{b|c}}`, shallow enough that a prompt which is mostly
   braces cannot spin: every pass either removes a group or stops. */
const MAX_PASSES = 8;

// The innermost group: braces with no braces inside them.
const INLINE = /\{([^{}]*)\}/;
const NAMED = /__([A-Za-z0-9_-]+?)__/g;

/**
 * `poses: standing | sitting` lines into `{ poses: ['standing', 'sitting'] }`.
 *
 * Forgiving on purpose: this is typed into a text box. Blank lines, spaces
 * around the colon and the bars, and a trailing bar are all fine; a line with
 * no name is ignored rather than breaking every other list.
 */
export const parseWildcardLists = (text) => {
  const lists = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(name)) continue;
    const choices = line.slice(at + 1).split('|').map(c => c.trim()).filter(Boolean);
    if (choices.length) lists[name] = choices;
  }
  return lists;
};

/** Whether a prompt has anything to expand, so the common case costs nothing. */
export const hasWildcards = (prompt) => /\{[^{}]*\|[^{}]*\}|__[A-Za-z0-9_-]+?__/.test(String(prompt || ''));

/**
 * The prompt with every choice made.
 *
 * A name with no list is left exactly as typed rather than removed: `__poses__`
 * surviving into a picture's prompt says "that list does not exist" far more
 * plainly than a silent gap would. A group with no bar in it -- `{sic}` -- is
 * not a choice and is left alone too; braces mean other things in prompts.
 */
export const expandWildcards = (prompt, {
  lists = {},
  pick = (n) => Math.floor(Math.random() * n),
  /* The same choice for the same group, across several strings of one request.
     A prompt from a conversation travels twice -- whole, and as the subject in
     the middle of it -- and choosing independently for each would draw a
     picture with red hair recorded as blue. */
  memo = null,
} = {}) => {
  let text = String(prompt ?? '');
  if (!hasWildcards(text)) return text;
  const choose = (key, choices) => {
    if (memo?.has(key)) return memo.get(key);
    const made = choices[pick(choices.length)];
    memo?.set(key, made);
    return made;
  };

  text = text.replace(NAMED, (whole, name) => {
    const choices = lists[String(name).toLowerCase()];
    return Array.isArray(choices) && choices.length ? choose(whole.toLowerCase(), choices) : whole;
  });

  // Braces that are not choices are set aside so the loop cannot trip on them.
  const kept = [];
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const match = INLINE.exec(text);
    if (!match) break;
    const choices = match[1].split('|');
    let replacement;
    if (choices.length < 2) {
      kept.push(match[0]);
      replacement = `\u0000${kept.length - 1}\u0000`;
    } else {
      replacement = String(choose(match[0], choices)).trim();
    }
    text = text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length);
  }
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
};
