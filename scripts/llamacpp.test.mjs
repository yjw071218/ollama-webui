// Talking to llama.cpp as though it were Ollama.
//
// The browser half of this app speaks one dialect everywhere — `/api/chat`
// NDJSON, `capabilities` from `/api/show`, `eval_count` and `eval_duration`
// under every answer — and thousands of tests below it depend on that shape. So
// the client was not touched: the dialect became the app's internal protocol,
// and server/llamacpp.js makes llama.cpp speak it.
//
// Which means every bug in that file is a silent one. A dropped `repeat_penalty`
// is a model that loops. A tool call whose arguments arrive as an object instead
// of a JSON string is a tool that never runs. Timings read from the wrong field
// are a footer that says nothing. None of it throws; all of it just quietly
// stops working, in an app whose owner has no llama.cpp to notice it on yet.
//
// So the translation is pure and this file is the second caller.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const L = await import(pathToFileURL(path.join(ROOT, 'server/llamacpp.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const deep = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------- choosing a backend */

eq('the default backend is ollama', L.backendOf({}), 'ollama');
eq('and stays ollama for anything unrecognised', L.backendOf({ LLM_BACKEND: 'vllm' }), 'ollama');
eq('llamacpp is opt-in', L.backendOf({ LLM_BACKEND: 'llamacpp' }), 'llamacpp');
eq('spelled however it was typed', L.backendOf({ LLM_BACKEND: '  LlamaCpp ' }), 'llamacpp');

/* ------------------------------------------------------------- the sampling

   These have no OpenAI equivalent, so a translator written against the OpenAI
   spec alone drops all three — and a dropped repeat_penalty is not a subtle
   difference in output, it is a model that starts repeating itself. */

const sampled = L.toChatRequest({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'hi' }],
  options: {
    temperature: 0.4, top_p: 0.9, top_k: 30, min_p: 0.05,
    repeat_penalty: 1.15, presence_penalty: 0.2, frequency_penalty: 0.1,
    seed: 42, num_predict: 500, num_ctx: 8192, stop: ['</done>'],
  },
});

eq('temperature survives', sampled.temperature, 0.4);
eq('so does top_k, which OpenAI does not have', sampled.top_k, 30);
eq('and min_p', sampled.min_p, 0.05);
eq('and repeat_penalty, whose loss is a looping model', sampled.repeat_penalty, 1.15);
eq('num_predict becomes max_tokens', sampled.max_tokens, 500);
eq('the seed goes over', sampled.seed, 42);
deep('and the stop sequences', sampled.stop, ['</done>']);

// The one genuine disagreement between the two servers. In llama.cpp the KV
// cache is allocated when the model loads, so context length is not a
// per-request option. Sending it would look honoured and would not be, which is
// worse than dropping it — `/api/show` reports the real figure instead.
eq('num_ctx is dropped rather than sent as a lie', sampled.num_ctx, undefined);
eq('and does not sneak through under another name', sampled.n_ctx, undefined);

// -1 is Ollama for "no limit"; OpenAI has no such value and would read it as a
// request for minus one token.
eq('an unlimited num_predict leaves max_tokens out',
  L.toChatRequest({ options: { num_predict: -1 } }).max_tokens, undefined);
eq('and so does an absent one',
  L.toChatRequest({ options: {} }).max_tokens, undefined);

// Streaming has to ask for the usage chunk, or the footer under every answer
// loses its numbers.
eq('a streaming request asks for usage',
  L.toChatRequest({}, { stream: true }).stream_options?.include_usage, true);
eq('and a non-streaming one does not need to',
  L.toChatRequest({}, { stream: false }).stream_options, undefined);

/* ------------------------------------------------------------- the thinking */

eq('auto sends no thinking field at all',
  'reasoning_effort' in L.toChatRequest({ messages: [] }), false);
deep('off asks the template to stop',
  L.toChatRequest({ think: false }).chat_template_kwargs, { enable_thinking: false });
eq('a level goes over as a level', L.toChatRequest({ think: 'medium' }).reasoning_effort, 'medium');
eq('and turns thinking on while it is at it',
  L.toChatRequest({ think: 'high' }).chat_template_kwargs.enable_thinking, true);

/* ---------------------------------------------------------------- messages */

// Ollama hangs images off the message; OpenAI puts them in the content. The
// media type is the only thing genuinely missing, and base64 keeps the magic
// bytes of what it encodes — a JPEG announced as a PNG is refused by the loader.
eq('a PNG is recognised from its base64', L.imageMime('iVBORw0KGgoAAAA'), 'image/png');
eq('and a JPEG', L.imageMime('/9j/4AAQSkZJRg'), 'image/jpeg');
eq('and a WEBP', L.imageMime('UklGRhoAAABX'), 'image/webp');
eq('anything unrecognised is called a PNG', L.imageMime('zzzzzz'), 'image/png');

const withImage = L.toOpenAiMessage({ role: 'user', content: 'what is this', images: ['/9j/4AAQSkZJRg'] });
check('an image moves into the content', Array.isArray(withImage.content));
eq('the text comes first', withImage.content[0].type, 'text');
eq('and the picture is a data url', withImage.content[1].image_url.url.startsWith('data:image/jpeg;base64,'), true);
// An attachment that already carries its prefix must not get a second one.
const prefixed = L.toOpenAiMessage({ role: 'user', images: ['data:image/png;base64,AAAA'] });
eq('a data url is not wrapped in another one', prefixed.content[0].image_url.url, 'data:image/png;base64,AAAA');

// Arguments as a JSON string, not an object. Getting this wrong is a tool call
// the server rejects.
const calling = L.toOpenAiMessage({
  role: 'assistant',
  content: '',
  tool_calls: [{ function: { name: 'web_search', arguments: { query: 'ollama' } } }],
});
eq('tool arguments become a JSON string', typeof calling.tool_calls[0].function.arguments, 'string');
eq('carrying the same values', calling.tool_calls[0].function.arguments, '{"query":"ollama"}');
eq('and empty content beside a call becomes null', calling.content, null);

// A tool *result* is addressed by the id the assistant used, not by the tool's
// name — and the ids are minted here, because Ollama never had any.
const ids = new Map();
const asked = L.toOpenAiMessage({
  role: 'assistant',
  tool_calls: [{ function: { name: 'get_time', arguments: {} } }],
}, ids);
const answered = L.toOpenAiMessage({ role: 'tool', content: '12:00', tool_name: 'get_time' }, ids);
eq('the tool result quotes the id the call was made with',
  answered.tool_call_id, asked.tool_calls[0].id);
// A transcript restored from storage never had the ids, so the name has to keep
// working rather than being rejected outright.
eq('and falls back to the name when there was no call to quote',
  L.toOpenAiMessage({ role: 'tool', content: 'x', tool_name: 'get_time' }).tool_call_id, 'get_time');

/* -------------------------------------------------------- server-sent events */

const stream = (text) => {
  const { events, rest } = L.sseEvents(text);
  return { events, rest };
};

deep('one event parses', stream('data: {"a":1}\n\n').events, [{ payload: { a: 1 } }]);
eq('a half-arrived event is held back', stream('data: {"a":1}').events.length, 0);
eq('and kept for the next chunk', stream('data: {"a":1}').rest, 'data: {"a":1}');
eq('[DONE] is an end, not a payload', stream('data: [DONE]\n\n').events[0].done, true);
eq('CRLF does not leave a stray return that breaks the parse',
  stream('data: {"a":1}\r\n\r\n').events[0].payload.a, 1);
eq('two events in one chunk are two events', stream('data: {"a":1}\n\ndata: {"a":2}\n\n').events.length, 2);
eq('comments and blank data lines are skipped', stream(': keepalive\n\n').events.length, 0);

/* ------------------------------------------------------------ the whole turn

   Assembled the way it actually arrives: reasoning first, then content, then
   tool-call fragments spread across chunks, then a usage chunk with no choices
   at all. That last one is the shape that catches a translator gated on there
   being a choice — and it is the chunk carrying every number in the footer. */

const turn = new L.ChatTranslator('qwen3:8b');
const frames = [];
for (const chunk of [
  { choices: [{ delta: { reasoning_content: 'let me think' } }] },
  { choices: [{ delta: { content: 'The answer' } }] },
  { choices: [{ delta: { content: ' is 4.' } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'web_search', arguments: '{"que' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"x"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
  {
    choices: [],
    usage: { prompt_tokens: 44, completion_tokens: 48 },
    timings: { prompt_n: 44, prompt_ms: 120, predicted_n: 48, predicted_ms: 900 },
  },
]) frames.push(...turn.accept(chunk));

eq('reasoning arrives as thinking, which is where the app renders it',
  frames[0].message.thinking, 'let me think');
eq('and carries no content of its own', frames[0].message.content, '');
eq('content arrives as content', frames[1].message.content, 'The answer');
eq('every streamed frame says it is not the end', frames.every(f => f.done === false), true);
// Tool calls are fragments until the stream ends, so nothing may be emitted for
// them mid-stream.
eq('a half-assembled tool call is not emitted', frames.length, 3);

const done = turn.finish();
eq('the final frame is the end', done.done, true);
eq('the tool call is whole by then', done.message.tool_calls[0].function.name, 'web_search');
eq('with its arguments joined back up', done.message.tool_calls[0].function.arguments, '{"query":"x"}');
eq('prompt tokens come through', done.prompt_eval_count, 44);
eq('so do generated tokens', done.eval_count, 48);
// Nanoseconds, because that is what Ollama reports and what the footer divides.
eq('durations are converted to nanoseconds', done.eval_duration, 900_000_000);
eq('and the total is both halves', done.total_duration, 1_020_000_000);

// `length` is what the continuation button looks for. Anything else reads as a
// finished answer, and getting this wrong means either a Continue button that
// never appears or one that appears on every reply.
eq('a normal finish is a stop', done.done_reason, 'stop');
const cut = new L.ChatTranslator('m');
cut.accept({ choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] });
eq('a truncated one says length', cut.finish().done_reason, 'length');

// The counts have to survive a server that reports usage but no timings, which
// is what the plain OpenAI shape gives.
const usageOnly = L.toDoneFrame('m', { usage: { prompt_tokens: 10, completion_tokens: 20 } });
eq('usage alone still gives the token counts', usageOnly.eval_count, 20);
eq('and leaves the durations out rather than inventing them', usageOnly.eval_duration, undefined);
// The client already estimates from its own clock when these are missing, so
// absent is the honest answer and zero would be a measurement that never
// happened.
eq('a server that says nothing produces no numbers',
  L.toDoneFrame('m', {}).total_duration, undefined);

/* --------------------------------------------------------- what a model can do

   The user asked for vision detection and tool detection to keep working, and
   this is where both live. `/models` knows the modalities without loading
   anything; `/props` knows the chat template, which is the only place the answer
   to "can this take tools" is written down. */

const visionEntry = { id: 'gemma3:4b', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } };
check('an image input is the vision capability',
  L.capabilitiesOf(visionEntry, null).includes('vision'));
check('a text-only model has none',
  !L.capabilitiesOf({ architecture: { input_modalities: ['text'] } }, null).includes('vision'));
check('the running server can say so instead',
  L.capabilitiesOf({}, { modalities: { vision: true } }).includes('vision'));

check('a template with a tool slot is the tools capability',
  L.capabilitiesOf({}, { chat_template_caps: { tools: true } }).includes('tools'));
// Older builds report no caps object at all, so the template itself is read.
check('and a template that mentions tool_calls counts too',
  L.capabilitiesOf({}, { chat_template: '{% for tc in message.tool_calls %}' }).includes('tools'));
check('a plain template does not',
  !L.capabilitiesOf({}, { chat_template: '{{ message.content }}' }).includes('tools'));
check('every model can at least complete',
  L.capabilitiesOf({}, null).includes('completion'));
// Offering an embedding model in the chat picker is offering one that cannot
// answer.
check('a model that emits vectors is marked as an embedder',
  L.capabilitiesOf({ architecture: { output_modalities: ['embedding'] } }, null).includes('embedding'));

/* The context length the model was actually loaded with, off its own argv. This
   is the figure the composer's gauge measures against, and reading it back is
   the only way it can be true on a backend where the client cannot set it. */
eq('the context is read from the launch arguments',
  L.contextOf({ status: { args: ['llama-server', '-c', '16384', '--flash-attn'] } }), 16384);
eq('under either spelling',
  L.contextOf({ status: { args: ['llama-server', '--ctx-size', '4096'] } }), 4096);
eq('and is null when nothing said', L.contextOf({ status: { args: [] } }), null);

/* ------------------------------------------------------------- the lists */

const listed = L.toTags([
  { id: 'ggml-org/gemma-3-4b-it-GGUF:Q4_K_M', meta: { n_params: 4.3e9, size: 2_900_000_000 } },
]);
eq('a model gets the name the app selects it by', listed.models[0].name, 'ggml-org/gemma-3-4b-it-GGUF:Q4_K_M');
eq('the quantisation is read off the tag', listed.models[0].details.quantization_level, 'Q4_K_M');
eq('and the parameter count is rounded to something readable',
  listed.models[0].details.parameter_size, '4B');

const running = L.toPs([
  { id: 'a', status: { value: 'loaded', args: ['-c', '8192'] } },
  { id: 'b', status: { value: 'sleeping' } },
  { id: 'c' },
]);
eq('only what is in memory is running', running.models.length, 1);
eq('and it is the loaded one', running.models[0].name, 'a');
eq('with the context it was loaded at', running.models[0].context_length, 8192);

/* ---------------------------------------------------- download progress

   A young endpoint whose field names are not worth betting a feature on, so
   several plausible spellings are accepted and anything unrecognised degrades
   to a status line. A bar that occasionally shows only a status is a smaller
   failure than a download reported as broken. */

deep('a progress event becomes a progress frame',
  L.toPullFrame({ status: 'downloading', completed: 50, total: 100 }),
  { status: 'downloading', total: 100, completed: 50 });
deep('under another spelling too',
  L.toPullFrame({ state: 'downloading', downloaded: 5, total_bytes: 10 }),
  { status: 'downloading', total: 10, completed: 5 });
eq('an event with no numbers is still a status',
  L.toPullFrame({ status: 'loading' }).status, 'loading');
eq('and an error is carried', L.toPullFrame({ status: 'x', error: 'no space' }).error, 'no space');

check('a finished download is recognised', L.pullFinished({ status: 'loaded' }));
check('however it is spelled', L.pullFinished({ state: 'download_complete' }));
check('but progress is not mistaken for the end', !L.pullFinished({ status: 'downloading' }));

/* --------------------------------------------------------------- the routes */

const routes = L.createLlamaRoutes({});
const paths = routes.map(r => r.path).sort();
// Every endpoint the client actually calls. One missing is a feature that
// 404s on this backend and works on the other, which is the exact drift this
// whole file exists to prevent.
for (const wanted of ['/api/chat', '/api/generate', '/api/embed', '/api/tags', '/api/show', '/api/ps', '/api/pull', '/api/delete']) {
  check(`${wanted} is handled`, paths.includes(wanted));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
