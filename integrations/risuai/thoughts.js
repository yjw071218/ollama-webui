/**
 * The model's reasoning, taken out of a message for display (the host
 * toolbar's 사고과정 switch, `webuiHideThinking`).
 *
 * It works on the message as stored -- before RisuAI's display scripts run --
 * and not on what they produce, because modules build their own interface out
 * of the same tag: a chapter heading drawn as a `<Thoughts>` box, a box opened
 * at the start of every message and closed at "# 응답". Hiding every box after
 * the scripts had run took those away and, where one was left open, the whole
 * rest of the message with it. Here only what the model itself wrote (or the
 * API returned as thinking) is removed; a module's boxes are added afterwards.
 *
 * An opened block that is never closed is reasoning only when the answer
 * starts after it under a response heading; then everything up to the heading
 * goes. Without one there is no telling where the reasoning ends, so the text
 * is left as it is rather than risk hiding the answer.
 */
const BLOCK = /<(Thoughts|think|thinking)\b[^>]*>[\s\S]*?<\/\1[ \t]*>[ \t]*\n?/gi;
const OPEN = /<(?:Thoughts|think|thinking)\b[^>]*>/i;
// No \b: in JavaScript it is a boundary of ASCII words only, so it never follows "응답".
const ANSWER = /^[ \t]*#{1,4}[*\t ]*(?:Response|응답|応答|响应)(?![\p{L}\p{N}_])/imu;

/**
 * The same switch, after the display scripts: the box a message opens with.
 *
 * Some modules draw the reasoning themselves -- one opens a box at the start of
 * every message and closes it at "# 응답" -- so the reasoning reaches the
 * screen without ever being tagged in the message. Only that leading box is
 * taken, and only when it is closed: boxes further down are a module's
 * interface (chapter headings, panels), and an unclosed one -- a greeting with
 * no response heading -- holds the whole message.
 */
export const hideLeadingThoughts = (html) => {
  const text = String(html ?? '');
  const lead = /^(?:\s|<!--[\s\S]*?-->)*<Thoughts>/.exec(text);
  if (!lead) return text;
  let depth = 1;
  for (let i = lead[0].length; i < text.length; i++) {
    if (text.startsWith('<Thoughts>', i)) { depth++; i += 9; continue; }
    if (text.startsWith('</Thoughts>', i)) {
      depth--;
      if (depth !== 0) { i += 10; continue; }
      // A box holding only a heading is a module's chapter title, not reasoning.
      if (/^\s*#{1,6}[^\n]*\s*$/.test(text.slice(lead[0].length, i))) return text;
      return text.slice(0, lead.index) + text.slice(i + 11).replace(/^[ \t]*\n/, '');
    }
  }
  return text;
};

export const hideThoughts = (text) => {
  let out = String(text ?? '').replace(BLOCK, '');
  const open = OPEN.exec(out);
  if (open) {
    const rest = out.slice(open.index);
    const answer = ANSWER.exec(rest);
    if (answer) out = out.slice(0, open.index) + rest.slice(answer.index);
  }
  return out;
};
