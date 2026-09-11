/**
 * A tool result, as something the reader should see.
 *
 * ## What was wrong with showing it raw
 *
 * The text a tool returns is addressed to the *model*. It says things like
 *
 *     The image was generated and is already displayed to the user beneath
 *     your reply. Do not describe it, do not link to it, and do not repeat the
 *     prompt. Say at most one short sentence about it, or nothing.
 *
 *     You have 9 tool call(s) left. Use another only if you still need it;
 *     otherwise answer now, citing any URLs you used.
 *
 * — and all of that went on screen in a monospace box under the answer. None of
 * it is for the person reading. It is instructions, addressed to somebody else,
 * about a picture they can already see.
 *
 * So the block becomes a receipt: what ran, whether it worked, and the part of
 * the answer that is actually information. The instructions are stripped, and a
 * tool whose result is entirely instructions — drawing — gets no body at all,
 * because the picture is directly underneath it.
 *
 * ## Why this is a separate file
 *
 * It is a parser, and the thing it parses is a format this app writes itself
 * (`--- TOOL_NAME ---`, then the body). That is exactly the kind of code that
 * drifts from its producer silently, so it is pure and tested against the real
 * strings.
 */

/* Sentences the tool loop appends for the model's benefit. Matched at the end
 * of a result, where they are always added — a search result that happens to
 * contain the phrase in a snippet is not a footer. */
const FOOTERS = [
  /\n*You have \d+ tool call\(s\) left\.[\s\S]*$/,
  /\n*This was your last tool call\.[\s\S]*$/,
  /\n*The picture is made and the reader can see it\.[\s\S]*$/,
  /\n*Tool budget for this turn is used up[\s\S]*$/,
];

/* And the standing instruction the drawing tools return, which is the whole of
   their result. Removing it leaves nothing, which is the right amount. */
const INSTRUCTIONS = [
  /(?:The (?:image|video)|\d+ images) (?:was|were) generated and (?:is|are) already displayed[\s\S]*$/,
  /The (?:background was removed|picture was enlarged|picture was extended)[\s\S]*$/,
  /^Do not describe it[\s\S]*$/m,
];

export const stripInstructions = (text) => {
  let out = String(text || '');
  for (const pattern of [...FOOTERS, ...INSTRUCTIONS]) out = out.replace(pattern, '');
  return out.trim();
};

/** Did this tool fail? The tools say so in their first line, in capitals. */
export const failedResult = (body) =>
  /^(SEARCH FAILED|IMAGE GENERATION FAILED|VIDEO GENERATION FAILED|IMAGE TOOL FAILED|Error\b|.*\bFAILED\b)/.test(
    String(body || '').trim().split('\n')[0] || '',
  );

/**
 * One result block, split into the tools that produced it.
 *
 * The loop writes `--- TOOL_NAME ---` before each, which is also what makes the
 * budget countable. A block with no marker at all is one of the loop's own
 * messages — the budget notice — and comes back as a single unnamed entry
 * rather than being dropped, because something did happen and saying nothing
 * would be worse.
 */
export const parseToolResults = (text) => {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const parts = raw.split(/^--- ([A-Z_]+) ---$/m);
  // `split` with one capturing group gives [before, name, body, name, body, …].
  if (parts.length === 1) {
    const body = stripInstructions(raw);
    return body ? [{ name: '', body, failed: failedResult(raw) }] : [];
  }

  const out = [];
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i];
    const body = stripInstructions(parts[i + 1] || '');
    out.push({ name, body, failed: failedResult(parts[i + 1] || '') });
  }
  return out;
};

/* What each tool is called, for a reader. The keys are the i18n names; a tool
 * with no entry falls back to the generic one rather than showing `TOOL_FOO`,
 * which is the sort of thing that reaches a screenshot. */
const VERBS = {
  TOOL_WEB_SEARCH: 'tool.did.search',
  TOOL_FETCH_URL: 'tool.did.fetch',
  TOOL_NEWS: 'tool.did.news',
  TOOL_READ_FILE: 'tool.did.read',
  TOOL_WRITE_FILE: 'tool.did.write',
  TOOL_LIST_DIR: 'tool.did.list',
  TOOL_SEARCH_FILES: 'tool.did.grep',
  TOOL_TIME: 'tool.did.time',
  TOOL_LIST_MODELS: 'tool.did.models',
  TOOL_SYSTEM_INFO: 'tool.did.system',
  TOOL_GENERATE_IMAGE: 'tool.did.image',
  TOOL_GENERATE_VIDEO: 'tool.did.video',
  TOOL_REMOVE_BACKGROUND: 'tool.did.rmbg',
  TOOL_UPSCALE_IMAGE: 'tool.did.upscale',
  TOOL_EXTEND_IMAGE: 'tool.did.extend',
  SKIPPED: 'tool.did.skipped',
};

export const verbKey = (name) => VERBS[name] || 'tool.result';

/* Tools whose body is never worth showing. Drawing returns instructions and
 * nothing else, and the picture is directly below the block — a caption saying
 * "the image was generated" under an image is noise. */
const WORDLESS = new Set([
  'TOOL_GENERATE_IMAGE', 'TOOL_GENERATE_VIDEO', 'TOOL_REMOVE_BACKGROUND', 'TOOL_UPSCALE_IMAGE', 'TOOL_EXTEND_IMAGE',
]);

/** Should this entry show its body, or only say that it happened? */
export const showsBody = (entry) =>
  !!entry.body && (entry.failed || !WORDLESS.has(entry.name));
