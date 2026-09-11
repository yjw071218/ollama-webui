/**
 * What an earlier turn looks like when it is sent back to the model.
 *
 * A transcript is written to be read. Retrieved passages, fetched pages and
 * the model's own reasoning are put into it so that a person can open the
 * thinking dropdown and see what an answer was based on — that is a feature,
 * and removing it would make citations unverifiable.
 *
 * Sending all of that back on the next turn is a separate question, and it had
 * never been asked. Every turn wrote its retrieved passages into the answer as
 * a `<think>` block, and every later turn sent that block up again along with
 * its own, so the prompt grew by the size of the retrieval on every turn no
 * matter how short the answers were:
 *
 *     16,253 + 534 tok  ->  24,761 + 468 tok  ->  32,850 + 543 tok
 *
 * Eight thousand tokens a turn to produce five hundred, and a conversation
 * that hits the context limit in a dozen questions. The passages were also
 * stored twice — once as text inside the think block, once as the structured
 * `citations` that make `[1]` pressable — and both copies synced to every
 * device.
 *
 * So: the transcript keeps everything, and the wire gets the conversation.
 *
 * Dropping reasoning from history is not only a saving. Thinking models are
 * meant to be re-prompted without their previous thinking; feeding it back
 * degrades them as well as costing for it.
 */
/* Reasoning, including a block left unterminated by a stopped stream.
 * Unterminated matters: an answer interrupted half-way through thinking is
 * exactly the kind of message that stays in a transcript for ever.
 *
 * This is also where the retrieved passages live. They are written into the
 * reply as a think block so the dropdown can show them, which is why removing
 * reasoning from history is the whole of the fix. */
const THINK = /<think>[\s\S]*?(<\/think>|$)/gi;

/* What a tool returned. What this removes is the result of a search two
 * questions ago, which nothing is going to consult again. The turn in progress
 * is a different matter and does not come through here: see `wireText`. */
const TOOL_RESULT = /<TOOL_RESULT>[\s\S]*?(<\/TOOL_RESULT>|$)/gi;

/* Injected context, if it ever reaches a stored message.
 *
 * Today it cannot: retrieval and grounding are appended to the text that is
 * sent, after the message has been written to the transcript, so the only
 * stored copy is the one inside the think block above. This is here because
 * "the only stored copy" is a fact about the current code and not a property
 * of the format, and the cost of being wrong about it is the bug coming back. */
const INJECTED = /---\s+\[(Knowledge|Grounding|MCP Tool)\][\s\S]*?-------------------/g;

/**
 * One earlier message, as the model should see it.
 *
 * Two things are deliberately kept.
 *
 * **Tool calls the model made.** `<TOOL_WEB_SEARCH>…</TOOL_WEB_SEARCH>` in an
 * old answer is its own action, and a model that cannot see what it did last
 * time does it again.
 *
 * **Attached files.** They look like the same kind of waste — forty kilobytes
 * of CSV riding along on every turn — and they are not, because of where the
 * two come from. Retrieval is redone from the question on every turn, so
 * throwing away last turn's passages loses nothing: this turn fetches what
 * this turn needs. An attachment is supplied once. Strip it from history and
 * "and what about line 200?" is answered from nothing at all. A file too long
 * to inline is indexed into the knowledge library instead, which puts it back
 * under retrieval where it belongs.
 *
 * The rule underneath both: drop what is re-derived each turn, keep what was
 * supplied once.
 */
export const forHistory = (content) => {
  const text = String(content ?? '');
  // Most messages contain none of this, and a message that is already clean
  // should cost nothing to pass through.
  if (!/<think>|<TOOL_RESULT>|---\s+\[/.test(text)) return text;

  return text
    .replace(THINK, '')
    .replace(TOOL_RESULT, '')
    .replace(INJECTED, '')
    // Whatever the removals left behind. Three blank lines where a knowledge
    // block used to be is not free either.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

/** A result the tool loop wrote into the transcript, rather than something a person said. */
export const isToolResult = (message) =>
  message?.role === 'user' && String(message.content ?? '').trimStart().startsWith('<TOOL_RESULT>');

/**
 * Where the turn in progress begins: the index of the question it answers.
 *
 * The tool loop continues a turn by sending the whole transcript again with
 * the result appended, so "this turn" is everything from the last thing a
 * person asked — not the whole chat. Counted over the whole chat, one picture
 * drawn at the start of a conversation withdrew the drawing tool for the rest
 * of it, and the tool budget ran out after ten calls *per chat*.
 *
 * The hidden "continue" instruction is not a question either.
 */
export const turnStart = (messages = []) => {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user' && !m.continuation && !isToolResult(m)) return i;
  }
  return 0;
};

/**
 * One message as it goes on the wire, given whether it belongs to the turn in
 * progress.
 *
 * This turn's tool results are the reason the next leg is being sent at all,
 * so they go up whole. Stripped as history, the leg after a search was the
 * search with no results — and the leg after a picture was a model that had
 * never been told it drew one, saying it cannot draw.
 */
export const wireText = (message, inCurrentTurn) =>
  inCurrentTurn && isToolResult(message)
    ? String(message.content)
    : forHistory(message?.content);

/**
 * Roughly what a turn of history costs, for showing somebody.
 *
 * Characters rather than tokens: there is no tokeniser here, and the number
 * this is for is a ratio between two versions of the same text.
 */
export const historyBytes = (messages) =>
  (messages || []).reduce((n, m) => n + String(m?.content ?? '').length, 0);

/** And what it costs once the scaffolding is out. */
export const sentBytes = (messages) =>
  (messages || []).reduce((n, m) => n + forHistory(m?.content).length, 0);
