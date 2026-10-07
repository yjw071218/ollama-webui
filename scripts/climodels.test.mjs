// Claude, GPT and Gemini through the CLIs signed in on this machine.
//
// server/cliModels.js turns one Ollama chat request into one headless CLI run
// and reads the CLI's JSON lines back into Ollama frames. Every piece of that
// is a silent failure when wrong -- a transcript that drops the last question,
// a Codex delta counted twice, an image sent to a CLI that refuses it -- and
// none of it can be exercised here by running the CLIs, which need an account.
// So the translation is pure and this file is its second caller.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const C = await import(pathToFileURL(path.join(ROOT, 'server/cliModels.js')).href);
/* These tests describe the sandboxed CLIs, which is CLI_FULL_ACCESS=false;
   full access is the default and is checked on its own (see fullAccessOf). */
const sandboxed = (provider, model, request, options = {}) => C.buildInvocation(provider, model, request,
  { ...options, env: { CLI_FULL_ACCESS: 'false', ...(options.env || {}) } });


// agy's chat agents are written here, never into the real ~/.gemini.
const AGY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'climodels-agyagents-'));
const AGY_ENV = { AGY_AGENTS_DIR: AGY_DIR };

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const deep = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------- names */

deep('a Claude Code name', C.parseCliModel('claude-code:opus'), { provider: C.PROVIDERS['claude-code'], model: 'opus' });
eq('a model with its own dots and dashes', C.parseCliModel('agy:gemini-3.1-pro-high')?.model, 'gemini-3.1-pro-high');
eq('an Ollama name is not ours', C.parseCliModel('qwen3.8:latest'), null);
eq('an Ollama cloud name is not ours', C.parseCliModel('glm-5.1:cloud'), null);
eq('a bare prefix names no model', C.parseCliModel('codex:'), null);
eq('no name at all', C.parseCliModel(undefined), null);
eq('on by default', C.enabledOf({}), true);
eq('CLI_MODELS=false turns them off', C.enabledOf({ CLI_MODELS: 'False' }), false);
deep('CLI_MODELS=false offers none', C.availableProviders({ CLI_MODELS: 'false' }), []);

/* ------------------------------------------------------ messages -> prompt */

{
  const one = C.toPrompt([{ role: 'user', content: 'hello' }]);
  eq('one question is sent as itself', one.prompt, 'hello');
  eq('with no system prompt', one.system, '');
}
{
  const many = C.toPrompt([
    { role: 'system', content: 'Be a pirate.' },
    { role: 'user', content: 'My name is Minsu.' },
    { role: 'assistant', content: 'Ahoy, Minsu!' },
    { role: 'user', content: 'What is my name?' },
  ]);
  eq('the system message is kept apart', many.system, 'Be a pirate.');
  check('the system message is not in the transcript', !many.prompt.includes('pirate'));
  check('every turn is in the transcript, in order',
    /\[User\]\nMy name is Minsu\.\n\n\[Assistant\]\nAhoy, Minsu!\n\n\[User\]\nWhat is my name\?/.test(many.prompt), many.prompt);
  check('and it asks for the next assistant message', /next \[Assistant\] message/.test(many.prompt));
  check('which is not a continuation', !/Continue the last/.test(many.prompt));
}
{
  const cont = C.toPrompt([
    { role: 'user', content: 'Tell a story.' },
    { role: 'assistant', content: 'Once upon a' },
  ]);
  check('a trailing assistant turn asks to continue it', /Continue the last \[Assistant\] message/.test(cont.prompt));
}
{
  const history = [
    { role: 'user', content: 'Fix the build.' },
    { role: 'assistant', content: 'I will check the files first.' },
    { role: 'user', content: '알겠어' },
  ];
  const agent = C.toPrompt(history, { agentic: true });
  check('with tools, the transcript asks for the work, not only text', /do that work now with your tools/.test(agent.prompt), agent.prompt);
  check('and says earlier tool calls are not shown', /tool calls and results behind them are not shown/.test(agent.prompt));
  check('not "only its text"', !/only its text/.test(agent.prompt));
  check('without tools it stays a plain chat', /only its text/.test(C.toPrompt(history).prompt));
  check('a continuation with tools still continues',
    /Continue the last \[Assistant\] message/.test(C.toPrompt(history.slice(0, 2), { agentic: true }).prompt));
  eq('a single message is still sent as itself', C.toPrompt([history[0]], { agentic: true }).prompt, 'Fix the build.');
}
{
  const img = C.toPrompt([
    { role: 'user', content: 'old', images: ['OLD'] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'new', images: ['data:image/png;base64,iVBORw0KGgoAAA'] },
  ]);
  deep('images come from the last user turn only, without a data-URL prefix', img.images, ['iVBORw0KGgoAAA']);
}
eq('multimodal content parts become text', C.toPrompt([{ role: 'user', content: [{ type: 'text', text: 'a' }, 'b'] }]).prompt, 'ab');
check('format: json asks for JSON', /single valid JSON value/.test(C.toPrompt([{ role: 'user', content: 'x' }], { format: 'json' }).prompt));
check('a schema is spelled out', C.toPrompt([{ role: 'user', content: 'x' }], { format: { type: 'object' } }).prompt.includes('{"type":"object"}'));
eq('a fenced JSON answer is unwrapped', C.unfence('```json\n{"a":1}\n```'), '{"a":1}');
eq('an unfenced one is left alone', C.unfence('{"a":1}'), '{"a":1}');

/* ---------------------------------------------------------------- effort */

{
  const tail = 'POST_HISTORY: 한국어로 캐릭터의 대사만 이어서 작성하세요.';
  const messages = [
    { role: 'system', content: 'CHARACTER: 등대지기' },
    { role: 'developer', content: 'STYLE: 짧은 대사와 행동 묘사' },
    { role: 'user', content: '문을 두드린다.' },
    { role: 'assistant', content: '문이 열리며' },
    { role: 'system', content: tail },
  ];
  const converted = C.toPrompt(messages);
  check('preset developer instructions retain their instruction role', converted.system.includes('STYLE:'));
  check('post-history instructions retain their position after the assistant prefix', converted.prompt.indexOf(tail) > converted.prompt.indexOf('문이 열리며'));
  check('post-history instructions are labeled distinctly from user dialogue', converted.prompt.includes('[System instruction]\n' + tail));
  check('a trailing instruction does not disable assistant continuation', converted.prompt.includes('Continue the last [Assistant]'));
  const long = '긴 프리셋 문장\n'.repeat(20000);
  eq('long preset instructions are not truncated', C.toPrompt([{ role: 'system', content: long }, { role: 'user', content: '시작' }]).system, long);
}

eq('"off" is the lowest effort', C.effortOf(false), 'low');
eq('a level is passed through', C.effortOf('high'), 'high');
eq('"auto" leaves the CLI to decide', C.effortOf(undefined), null);
eq('true leaves it to decide too', C.effortOf(true), null);

/* ----------------------------------------------------------- invocations */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'climodels-test-'));
try {
  const roleplay = C.toPrompt([{ role: 'system', content: '캐릭터 설정' }, { role: 'user', content: 'ROLEPLAY_TURN' }, { role: 'system', content: 'POST_HISTORY_TEST' }]);
  for (const provider of Object.values(C.PROVIDERS)) {
    const invocation = sandboxed(provider, provider.defaultModels[0], roleplay, { files: scratch, env: AGY_ENV });
    let text = invocation.stdin;
    if (provider.id === 'codex') {
      invocation.session.open();
      invocation.session.accept({ id: 1, result: {} });
      text = JSON.stringify(invocation.session.accept({ id: 2, result: { thread: { id: 'ROLEPLAY' } } }).write);
    }
    check(`${provider.id} receives roleplay post-history text after its turn`, text.indexOf('POST_HISTORY_TEST', text.indexOf('ROLEPLAY_TURN')) > text.indexOf('ROLEPLAY_TURN'));
  }
  const request = { system: 'Be brief.', prompt: 'Hi & "bye"', images: ['iVBORw0KGgoAAA'] };

  const claude = sandboxed(C.PROVIDERS['claude-code'], 'haiku', request, { think: 'medium', files: scratch });
  const tools = claude.args.indexOf('--tools');
  eq('Claude Code runs with no tools', claude.args[tools + 1], '');
  check('and no MCP servers', claude.args.includes('--strict-mcp-config'));
  eq('the model', claude.args[claude.args.indexOf('--model') + 1], 'haiku');
  eq('the effort', claude.args[claude.args.indexOf('--effort') + 1], 'medium');
  const systemFile = claude.args[claude.args.indexOf('--system-prompt-file') + 1];
  eq('the system prompt goes in a file, not on the command line', fs.readFileSync(systemFile, 'utf8'), 'Be brief.');
  check('the prompt is not on the command line', !claude.args.some(a => a.includes('bye')));
  const claudeIn = JSON.parse(claude.stdin);
  eq('the prompt goes in on stdin', claudeIn.message.content[0].text, 'Hi & "bye"');
  deep('with the image as a base64 block of the right type', claudeIn.message.content[1],
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAA' } });

  const codex = sandboxed(C.PROVIDERS.codex, 'gpt-5.5', request, { think: false, files: scratch });
  deep('Codex runs its app server', codex.args, ['app-server']);
  const opened = codex.session.open();
  eq('which is greeted first', opened[0].method, 'initialize');
  const started = codex.session.accept({ id: 1, result: {} }).write;
  eq('then told it is initialized', started[0].method, 'initialized');
  const thread = started[1].params;
  eq('and asked for a thread', started[1].method, 'thread/start');
  eq('sandboxed read-only', thread.sandbox, 'read-only');
  eq('never asking for approval', thread.approvalPolicy, 'never');
  eq("whose system prompt replaces Codex's own", thread.baseInstructions, 'Be brief.');
  eq('on the model asked for', thread.model, 'gpt-5.5');
  const turn = codex.session.accept({ id: 2, result: { thread: { id: 'T' } } }).write[0];
  eq('then a turn on that thread', `${turn.method} ${turn.params.threadId}`, 'turn/start T');
  eq('"off" is low reasoning effort', turn.params.effort, 'low');
  eq('the question is the text input', turn.params.input[0].text, 'Hi & "bye"');
  const image = turn.params.input.find(i => i.type === 'localImage');
  check('the image is a file it can open', image && fs.existsSync(image.path), JSON.stringify(image));

  const agy = sandboxed(C.PROVIDERS.agy, 'gemini-3.1-pro-high', request, { files: scratch, env: AGY_ENV });
  eq('agy reads stdin with an empty --print', agy.args[agy.args.length - 1], '--print=');
  const agyIn = JSON.parse(agy.stdin);
  eq('as an `event: user` line', agyIn.event, 'user');
  deep('with text blocks only, which is all it takes', agyIn.message.content.map(b => b.type), ['text']);
  check('carrying the system prompt and the question', agyIn.message.content[0].text.includes('Be brief.') && agyIn.message.content[0].text.includes('Hi & "bye"'));
  eq('agy says it can see images, so the app asks for no separate vision model', C.toShow(C.PROVIDERS.agy, 'x').capabilities.includes('vision'), true);
  const agyText = agyIn.message.content[0].text;
  const saved = path.join(scratch, 'image-1.png');
  check('the picture is saved as a file it can open', fs.existsSync(saved) && fs.readFileSync(saved).equals(Buffer.from('iVBORw0KGgoAAA', 'base64')));
  check('named to it by absolute path, with leave to view it', agyText.includes(saved) && agyText.includes('view_file'), agyText);
  check('and no leave to use any other tool', agyText.includes('Apart from viewing these images: Do not use any tools'), agyText);

  /* With the tools toggle on, the app's tags are how agy reaches MCP -- and
     it must not be told in the same breath to use no tools at all. */
  const withAppTools = JSON.parse(sandboxed(C.PROVIDERS.agy, 'x', { system: 'TOOLS: <TOOL_MCP server="files" tool="read_text_file">{}</TOOL_MCP>', prompt: 'read it', images: [] },
    { files: scratch, env: { ...AGY_ENV, CLI_AGY_MCP: 'off' }, tools: C.toolsFor(C.PROVIDERS.agy, { CLI_AGY_MCP: 'off' }, { wanted: true }) }).stdin).message.content[0].text;
  check('with the toggle on, agy is not told to use no tools', !withAppTools.includes('Do not use any tools'), withAppTools);
  check('but to use the tags its instructions describe', withAppTools.includes('use the tool tags your instructions describe'));
  check("and still not agy's own tools", withAppTools.includes("Do not use agy's own tools"));
  const body = C.agyAgentFile({ name: 'x', vision: false });
  check('the agent no longer says it has no tools at all, which made it refuse the tags', !body.includes('do not try to use any') && body.includes('<TOOL_MCP'), body);
  eq('it runs where the picture is', agy.cwd, scratch);
  const agyPlain = sandboxed(C.PROVIDERS.agy, 'gemini-3.1-pro-high', { system: '', prompt: 'hi', images: [] }, { files: scratch, env: AGY_ENV });

  /* Its own agent: without the coding agent's prompt and tool definitions,
     which were most of the 8,000 tokens a "hello" cost. */
  eq('agy runs as the chat agent', agyPlain.args[agyPlain.args.indexOf('--agent') + 1], 'ollama-webui-chat');
  eq('or, with a picture, the one that may open it', agy.args[agy.args.indexOf('--agent') + 1], 'ollama-webui-vision');
  const chatAgent = fs.readFileSync(path.join(AGY_DIR, 'ollama-webui-chat', 'agent.md'), 'utf8');
  const visionAgent = fs.readFileSync(path.join(AGY_DIR, 'ollama-webui-vision', 'agent.md'), 'utf8');
  check('which leaves out the default prompt and tools', chatAgent.includes('\nexcludeDefaultComponents: true\n'));
  check("and the reader's own coding rules", chatAgent.includes('\ninheritCustomizations: false\n'));
  check('and has no tools and no shell', chatAgent.includes('\ntools: []\n') && chatAgent.includes('\ncommandExecutionPolicy: off\n'));
  check('and is hidden from their /agents list', chatAgent.includes('\nhidden: true\n'));
  check('the vision one may use view_file and nothing else', visionAgent.includes('\ntools:\n  - view_file\n---\n'), visionAgent);
  check('the body is its system prompt, under an H1', chatAgent.startsWith('---\n') && chatAgent.includes('\n# System Prompt\n'));
  const agentPath = path.join(AGY_DIR, 'ollama-webui-chat', 'agent.md');
  const mtime = fs.statSync(agentPath).mtimeMs;
  await new Promise(r => setTimeout(r, 30));
  C.ensureAgyAgent(AGY_ENV);
  eq('an unchanged agent is not rewritten', fs.statSync(agentPath).mtimeMs, mtime);
  check('CLI_AGY_AGENT=off runs agy as itself',
    !sandboxed(C.PROVIDERS.agy, 'x', { system: '', prompt: 'hi', images: [] }, { files: scratch, env: { ...AGY_ENV, CLI_AGY_AGENT: 'off' } }).args.includes('--agent'));
  check('without a picture, no tools at all, as before', JSON.parse(agyPlain.stdin).message.content[0].text.includes('Do not use any tools') && !agyPlain.cwd);
  eq('Claude Code says it can', C.toShow(C.PROVIDERS['claude-code'], 'x').capabilities.includes('vision'), true);
  eq('and neither claims tool calls it cannot make', C.toShow(C.PROVIDERS['claude-code'], 'x').capabilities.includes('tools'), false);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

/* ----------------------------------------------- agy and a long message

   agy keeps the first 192,000 bytes of a message and silently drops the rest:
   the end, which is the newest message and the instructions after the history.
   A roleplay with a long preset and first message lost what had just been said
   by its second turn and wrote its first answer again. Past the limit the head
   goes into a one-run agent's system prompt (which has no such limit). */
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'climodels-agylong-'));
  const filler = (tag) => Array.from({ length: 2500 }, (_, i) => `${tag} 문단 ${i}: 길이를 채우는 한국어 문장입니다.`).join('\n');
  const request = { system: '너는 이야기꾼이다.', prompt: `${filler('가')}\n${filler('나')}\n[마지막 입력] 초록고래77`, images: [] };
  const short = sandboxed(C.PROVIDERS.agy, 'gemini-3.1-pro-high', { system: 'x', prompt: 'hi', images: [] }, { files: scratch, env: AGY_ENV });
  check('a short message is sent as it is, with no extra agent', !short.cleanupDirs && !JSON.parse(short.stdin).message.content[0].text.includes('message_part'));
  const long = sandboxed(C.PROVIDERS.agy, 'gemini-3.1-pro-high', request, { files: scratch, env: AGY_ENV });
  const sent = JSON.parse(long.stdin).message.content[0].text;
  check('a long message is cut down below agy\'s limit', Buffer.byteLength(sent) < 160000, String(Buffer.byteLength(sent)));
  check('  keeping its end -- the newest input -- in the message', sent.includes('[마지막 입력] 초록고래77'));
  const name = long.args[long.args.indexOf('--agent') + 1];
  check('  and run as an agent made for this run', name.startsWith('ollama-webui-long-') && long.cleanupDirs?.length === 1);
  const agentText = fs.readFileSync(path.join(long.cleanupDirs[0], 'agent.md'), 'utf8');
  check('  whose system prompt holds the start, instructions included', agentText.includes('<message_part_1>') && agentText.includes('너는 이야기꾼이다.') && agentText.includes('가 문단 0:'));
  check('  and nothing is lost between the two parts', (agentText + sent).includes('나 문단 2499:') && (agentText.match(/나 문단 1200:/g) || []).length + (sent.match(/나 문단 1200:/g) || []).length === 1);
  check('  which cannot be resumed later', long.unresumable === true);
  fs.rmSync(scratch, { recursive: true, force: true });
}

/* ------------------------------------------------------------- reading back */

{
  const r = new C.ClaudeReader();
  deep('the message start carries no text, only that the model began', r.accept({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 5 } } } }), { started: true });
  eq('and says so once', r.accept({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 5 } } } }), null);
  deep('a thinking delta', r.accept({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } } }), { thinking: 'hm', reasoning: true });
  deep('a text delta', r.accept({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }), { content: 'hi' });
  eq('the whole message again is ignored', r.accept({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }), null);
  r.accept({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 7 } } });
  deep('the result ends it, with the usage', r.accept({ type: 'result', subtype: 'success', result: 'hi', stop_reason: 'end_turn' }),
    { done: true, usage: { prompt: 15, context: 15, contextEval: 7, eval: 7 }, reason: 'stop' });
  const e = new C.ClaudeReader().accept({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in' });
  eq('an error result is an error', e.error, 'Not logged in');
  eq('with no partials, the result is the answer', new C.ClaudeReader().accept({ type: 'result', subtype: 'success', result: 'whole' }).content, 'whole');
}
{
  const r = new C.CodexSession({ thread: {}, turn: {} });
  deep('a started turn is when the model began', r.accept({ method: 'turn/started', params: { turn: {} } }), { started: true });
  eq('a config warning is not the answer', r.accept({ method: 'configWarning', params: { summary: 'ignoring settings' } }), null);
  deep('a reasoning summary is thinking', r.accept({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r', delta: 'plan' } }), { thinking: 'plan', reasoning: true });
  eq('and the raw text of the same thought is not shown twice', r.accept({ method: 'item/reasoning/textDelta', params: { itemId: 'r', delta: 'plan' } }), null);
  deep('a delta is passed on as it comes', r.accept({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'Hel' } }), { content: 'Hel' });
  deep('and the next', r.accept({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'lo' } }), { content: 'lo' });
  eq('the finished item repeats nothing', r.accept({ method: 'item/completed', params: { item: { id: 'a', type: 'agentMessage', text: 'Hello' } } }), null);
  deep('a message that came only whole still arrives, set apart', r.accept({ method: 'item/completed', params: { item: { id: 'b', type: 'agentMessage', text: 'Again' } } }), { content: '\n\nAgain' });
  r.accept({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: { inputTokens: 3, outputTokens: 4 } } } });
  deep('the completed turn ends it, with the usage', r.accept({ method: 'turn/completed', params: { turn: { status: 'completed' } } }), { done: true, usage: { prompt: 3, eval: 4, fresh: 3, context: 3, contextEval: 4 }, reason: 'stop' });
  const multi = new C.CodexSession({ thread: {}, turn: {} });
  multi.accept({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: { inputTokens: 900, cachedInputTokens: 800, outputTokens: 30 }, total: { inputTokens: 2500, cachedInputTokens: 2000, outputTokens: 90 } } } });
  deep('Codex: the context is the last call, the sums are the turn', multi.accept({ method: 'turn/completed', params: { turn: { status: 'completed' } } }).usage,
    { prompt: 2500, eval: 90, cached: 2000, fresh: 500, context: 900, contextEval: 30 });
  const ask = r.accept({ id: 9, method: 'item/commandExecution/requestApproval', params: {} });
  eq('an approval request is declined, not left waiting', ask.write[0].id, 9);
  const f = new C.CodexSession({ thread: {}, turn: {} });
  eq('an error being retried is not the end', f.accept({ method: 'error', params: { error: { message: 'usage limit' }, willRetry: false } }), null);
  eq('a failed turn is', f.accept({ method: 'turn/completed', params: { turn: { status: 'failed', error: null } } }).error, 'usage limit');
  eq('a refused thread is too', new C.CodexSession({}).accept({ id: 2, error: { message: 'bad model' } }).error, 'bad model');
}
{
  const r = new C.AgyReader();
  deep('the user step is not the answer, only the agent beginning', r.accept({ event: 'step_update', step_update: { step_type: 'user_input', state: 'DONE' } }), { started: true });
  eq('which is said once', r.accept({ event: 'step_update', step_update: { step_type: 'planner_response', state: 'RUNNING' } }), null);
  deep('an agent response delta', r.accept({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'hi' } }), { content: 'hi' });
  deep('the result ends it', r.accept({ event: 'result', result: { status: 'SUCCESS', response: 'hi', usage: { input_tokens: 1, output_tokens: 2 } } }),
    { done: true, usage: { prompt: 1, eval: 2 }, reason: 'stop' });
  eq('an error status is an error', new C.AgyReader().accept({ event: 'result', result: { status: 'ERROR', error: 'nope' } }).error, 'nope');
}

/* ---------------------------------------------------------------- tools */

eq('a level only Claude has goes to Claude', C.effortOf('max', C.PROVIDERS['claude-code']), 'max');
eq('and not to Codex', C.effortOf('max', C.PROVIDERS.codex), null);
eq("Codex's minimal goes to Codex", C.effortOf('minimal', C.PROVIDERS.codex), 'minimal');
eq('CLI_EFFORT decides when the reader did not', C.effortOf(undefined, C.PROVIDERS.codex, { CLI_EFFORT: 'high' }), 'high');
eq('but not over "off"', C.effortOf(false, C.PROVIDERS.codex, { CLI_EFFORT: 'high' }), 'low');

{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'climodels-mcp-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climodels-home-'));
  fs.writeFileSync(path.join(work, 'mcp.json'), JSON.stringify({
    mcpServers: {
      files: { command: 'npx', args: ['-y', 'fs-server', 'C:/data'], allow: ['read_file'], env: { K: '${CLI_TEST_TOKEN:-v}' } },
      web: { url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer x' }, deny: ['delete'] },
      old: { url: 'http://127.0.0.1:9/sse' },
      off: { command: 'x', disabled: true },
      'bad name': { command: 'x' },
    },
  }));
  const opts = { wanted: true, cwd: work, home };

  eq('no tools unless the reader turned them on', C.toolsFor(C.PROVIDERS['claude-code'], {}, { ...opts, wanted: false }), null);
  const claudeTools = C.toolsFor(C.PROVIDERS['claude-code'], {}, opts);
  deep('Claude Code takes every transport, not a disabled server or an unsafe name',
    Object.keys(claudeTools.servers), ['files', 'web', 'old']);
  eq('and the web', claudeTools.web, true);
  deep('Codex has no SSE client', Object.keys(C.toolsFor(C.PROVIDERS.codex, {}, opts).servers), ['files', 'web']);
  eq('nor Claude\'s web tools', C.toolsFor(C.PROVIDERS.codex, {}, opts).web, false);
  deep('Antigravity takes them too, minus SSE', Object.keys(C.toolsFor(C.PROVIDERS.agy, {}, opts).servers), ['files', 'web']);
  deep('  but none with CLI_AGY_MCP=off', Object.keys(C.toolsFor(C.PROVIDERS.agy, { CLI_AGY_MCP: 'off' }, opts).servers), []);
  deep('CLI_MCP=false hands over no servers', Object.keys(C.toolsFor(C.PROVIDERS['claude-code'], { CLI_MCP: 'false' }, opts).servers), []);
  eq('CLI_WEB=false keeps Claude off the web', C.toolsFor(C.PROVIDERS['claude-code'], { CLI_WEB: 'false' }, opts).web, false);

  const mcp = C.claudeMcpConfig(claudeTools.servers);
  deep('an allow-list is allowed tool by tool, a whole server by its prefix',
    mcp.allowed, ['mcp__files__read_file', 'mcp__web', 'mcp__old']);
  deep('a deny-list is disallowed', mcp.denied, ['mcp__web__delete']);
  eq('a variable in the config is expanded', mcp.config.mcpServers.files.env.K, 'v');
  eq('an HTTP server keeps its headers', mcp.config.mcpServers.web.headers.Authorization, 'Bearer x');
  eq('the SSE one says so', mcp.config.mcpServers.old.type, 'sse');
  eq('a stdio server is started through the roots-stripping proxy', mcp.config.mcpServers.files.args[0], C.PROXY);
  deep('from this app\'s directory, with its own command after --',
    mcp.config.mcpServers.files.args.slice(3), ['--', 'npx', '-y', 'fs-server', 'C:/data']);

  /* The proxy for real, against the stub server: a client offering roots --
     as Claude Code does, with its empty scratch directory -- must not reach
     the server, or the filesystem server trades mcp.json's directories for it. */
  {
    const { spawn } = await import('node:child_process');
    const stub = path.join(ROOT, 'scripts/fixtures/mcp-stub-server.mjs');
    const run = C.launcher({ command: process.execPath, args: [stub] }, ROOT);
    const child = spawn(run.command, run.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const replies = new Map();
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let cut;
      while ((cut = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
        try { const m = JSON.parse(line); if (m.id !== undefined) replies.set(m.id, m); } catch { /* not ours */ }
      }
    });
    const ask = async (id, method, params) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      for (let i = 0; i < 100 && !replies.has(id); i++) await new Promise(r => setTimeout(r, 20));
      return replies.get(id);
    };
    const hello = await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: { roots: { listChanged: true }, sampling: {} }, clientInfo: { name: 'claude-code' } });
    check('the server still answers through the proxy', hello?.result?.serverInfo?.name === 'stub', JSON.stringify(hello));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' })}\n`);
    const seen = JSON.parse((await ask(2, 'tools/call', { name: 'client_caps', arguments: {} }))?.result?.content?.[0]?.text || '{}');
    check('the client\'s roots never reach the server', seen.capabilities && !('roots' in seen.capabilities), JSON.stringify(seen));
    check('everything else it offered does', 'sampling' in (seen.capabilities || {}));
    eq('and the server runs from the app\'s directory', path.resolve(seen.cwd || ''), path.resolve(ROOT));
    child.stdin.end();
    await new Promise(resolve => { child.on('exit', resolve); setTimeout(resolve, 2000); });
  }

  const scratch2 = fs.mkdtempSync(path.join(os.tmpdir(), 'climodels-inv-'));
  const withTools = sandboxed(C.PROVIDERS['claude-code'], 'opus', { system: '', prompt: 'hi', images: [] },
    { files: scratch2, tools: claudeTools });
  eq('Claude Code gets only web search and fetch as built-in tools', withTools.args[withTools.args.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  check('still strict about which MCP servers', withTools.args.includes('--strict-mcp-config'));
  const executionRules = fs.readFileSync(withTools.args[withTools.args.indexOf('--system-prompt-file') + 1], 'utf8');
  check('MCP execution does not end with a promise', executionRules.includes('A promise or plan is not execution'));
  check('MCP execution preserves approval and plan-only boundaries', executionRules.includes('plan-only requests, cancellations and required approvals'));
  for (const resume of ['', 'existing-thread']) {
    const run = sandboxed(C.PROVIDERS.codex, 'test-model', { system: 'Be brief.', prompt: '진행해줘', images: [] },
      { files: scratch2, tools: C.toolsFor(C.PROVIDERS.codex, {}, opts), resume });
    check('Codex execution rules survive ' + (resume || 'new thread'),
      run.session.thread.baseInstructions.includes('A promise or plan is not execution'));
    eq('execution rules do not widen the built-in sandbox', run.session.thread.sandbox, 'read-only');
    eq('execution rules do not change approval policy', run.session.thread.approvalPolicy, 'never');
  }
  const configFile = withTools.args[withTools.args.indexOf('--mcp-config') + 1];
  check('the servers are handed over in a file', fs.existsSync(configFile) && JSON.parse(fs.readFileSync(configFile, 'utf8')).mcpServers.files);
  eq('and allowed', withTools.args[withTools.args.indexOf('--allowedTools') + 1],
    'WebSearch,WebFetch,mcp__files__read_file,mcp__web,mcp__old');
  eq('a denied tool is disallowed', withTools.args[withTools.args.indexOf('--disallowedTools') + 1], 'mcp__web__delete');
  const without = sandboxed(C.PROVIDERS['claude-code'], 'opus', { system: '', prompt: 'hi', images: [] }, { files: scratch2 });
  check('without the toggle, no config and nothing allowed', !without.args.includes('--mcp-config') && !without.args.includes('--allowedTools'));

  const codexTools = C.toolsFor(C.PROVIDERS.codex, {}, opts);
  const codexRun = sandboxed(C.PROVIDERS.codex, 'gpt-5.5', { system: '', prompt: 'hi', images: [] }, { files: scratch2, tools: codexTools });
  eq('Codex still runs its app server, last', codexRun.args[codexRun.args.length - 1], 'app-server');
  const overrides = codexRun.args.filter((a, i) => codexRun.args[i - 1] === '-c' && a.startsWith('mcp_servers.'));
  eq('one -c per server', overrides.length, 2);
  check('a whole server table, as TOML', /^mcp_servers\.files=\{ "command" = /.test(overrides[0]), overrides[0]);
  check('with its allow-list as enabled_tools', overrides[0].includes('"enabled_tools" = ["read_file"]'), overrides[0]);
  check('an HTTP server as a url and headers', overrides[1].includes('"url" = "http://127.0.0.1:9/mcp"') && overrides[1].includes('"http_headers" = { "Authorization" = "Bearer x" }'), overrides[1]);
  check('and its deny-list as disabled_tools', overrides[1].includes('"disabled_tools" = ["delete"]'), overrides[1]);

  check('Claude Code says it takes MCP itself', C.toShow(C.PROVIDERS['claude-code'], 'x').capabilities.includes('mcp'));
  check('so does Antigravity', C.toShow(C.PROVIDERS.agy, 'x').capabilities.includes('mcp'));
  check('  unless CLI_AGY_MCP=off', !C.toShow(C.PROVIDERS.agy, 'x', { CLI_AGY_MCP: 'off' }).capabilities.includes('mcp'));
  check('nor anyone, with CLI_MCP=false', !C.toShow(C.PROVIDERS.codex, 'x', { CLI_MCP: 'false' }).capabilities.includes('mcp'));

  for (const dir of [work, home, scratch2]) fs.rmSync(dir, { recursive: true, force: true });
}

{
  const r = new C.ClaudeReader();
  r.accept({ type: 'stream_event', event: { type: 'message_start', message: { usage: {} } } });
  r.accept({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Let me look.' } } });
  r.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'mcp__files__read_file' } } });
  r.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"C:\\\\a.js"}' } } });
  const note = r.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
  check('a tool call is shown as thinking, by server and tool', /\[tool: files \/ read_file · C:\\a\.js\]/.test(note?.thinking || ''), JSON.stringify(note));
  // Not reasoning: it is still shown with thinking switched off.
  check('and is not marked as reasoning', note && !note.reasoning, JSON.stringify(note));
  r.accept({ type: 'stream_event', event: { type: 'message_start', message: { usage: {} } } });
  deep('text after the tool is set apart from text before it',
    r.accept({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Found it.' } } }),
    { content: '\n\nFound it.' });
  const end = r.accept({ type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 20 }, total_cost_usd: 0.01 });
  deep("the run's own totals and cost are kept", end.usage, { prompt: 100, eval: 20, fresh: 100, cacheWrite: 0, costUsd: 0.01 });
}
{
  /* Claude Code's own Edit: its patch comes beside the result, and becomes the
     same diff in the answer a workbench edit does. */
  const r = new C.ClaudeReader();
  const out = r.accept({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'The file C:\\x\\a.js has been updated successfully.' }] },
    tool_use_result: { filePath: 'C:\\x\\a.js', structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a', '-b', '+c'] }] },
  });
  check("Claude's own edit is shown as its diff", /📝 \*\*`C:\\x\\a\.js`\*\* \(\+1 −1\)\n```diff\n[\s\S]*\n-b\n\+c\n```/.test(out?.content || ''), JSON.stringify(out));
  check('a new file is all added', /\(\+2 -0\)[\s\S]*\n\+1\n\+2\n```$/.test(C.nativeChangeText({ type: 'create', filePath: 'C:\\x\\n.txt', content: '1\n2\n', structuredPatch: [] })));
  eq('a result with no file is no change', C.nativeChangeText({ stdout: 'ok' }), '');
}
{
  /* Three calls in one run: the context is the last call's, not the sum. */
  const r = new C.ClaudeReader();
  const call = (input, read, out) => {
    r.accept({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: input, cache_read_input_tokens: read } } } });
    r.accept({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: out } } });
  };
  call(1000, 0, 50); call(100, 1050, 40); call(80, 1190, 60);
  const end = r.accept({ type: 'result', subtype: 'success', usage: { input_tokens: 1180, cache_read_input_tokens: 2240, cache_creation_input_tokens: 0, output_tokens: 150 } });
  deep('Claude: context is the last call, totals are the run', end.usage,
    { prompt: 3420, eval: 150, cached: 2240, fresh: 1180, cacheWrite: 0, context: 1270, contextEval: 60 });
}
{
  const r = new C.CodexSession({ thread: {}, turn: {} });
  check('a Codex MCP call is shown',
    /\[tool: files \/ read_file\]/.test(r.accept({ method: 'item/started', params: { item: { type: 'mcpToolCall', server: 'files', tool: 'read_file' } } })?.thinking || ''));
  check('and a web search, with its query',
    /\[web search: weather\]/.test(r.accept({ method: 'item/started', params: { item: { type: 'webSearch', query: 'weather' } } })?.thinking || ''));
}

/* ------------------------------------------------------------- thinking */

{
  const scratch3 = fs.mkdtempSync(path.join(os.tmpdir(), 'climodels-think-'));
  const req = { system: '', prompt: 'hi', images: [] };
  const claudeOn = sandboxed(C.PROVIDERS['claude-code'], 'opus', req, { files: scratch3 });
  eq('Claude Code is asked for its reasoning summarized', claudeOn.args[claudeOn.args.indexOf('--thinking-display') + 1], 'summarized');
  check('not when the chat switched thinking off',
    !sandboxed(C.PROVIDERS['claude-code'], 'opus', req, { files: scratch3, think: false }).args.includes('--thinking-display'));
  check('nor with CLI_THINKING_DISPLAY=off',
    !sandboxed(C.PROVIDERS['claude-code'], 'opus', req, { files: scratch3, env: { CLI_THINKING_DISPLAY: 'off' } }).args.includes('--thinking-display'));
  const codexOn = sandboxed(C.PROVIDERS.codex, 'gpt-5.5', req, { files: scratch3 });
  check('Codex is asked for a detailed reasoning summary', codexOn.args.includes('model_reasoning_summary="detailed"'), JSON.stringify(codexOn.args));
  check('not when thinking is off', !sandboxed(C.PROVIDERS.codex, 'gpt-5.5', req, { files: scratch3, think: false }).args.some(a => a.startsWith('model_reasoning_summary')));
  deep('agy passes its reasoning on', { ...new C.AgyReader().accept({ event: 'step_update', step_update: { step_type: 'planner_response', thinking_delta: 'hmm' } }), started: undefined }, { thinking: 'hmm', reasoning: true });
  fs.rmSync(scratch3, { recursive: true, force: true });
}

/* --------------------------------------------------------------- limits */

{
  const event = {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: 1790662612, utilization: 0.82,
      unifiedWindows: { five_hour: { utilization: 0.82, resetsAt: 1790662612 }, seven_day: { utilization: 0.4, resetsAt: 1791114094 } },
    },
  };
  const got = new C.ClaudeReader().accept(event).limits;
  eq("Claude's status is kept", got.status, 'allowed_warning');
  deep('each window as a percentage, with its reset in milliseconds', got.windows.map(w => [w.id, w.usedPercent, w.resetsAt, w.windowMins]),
    [['five_hour', 82, 1790662612000, 300], ['seven_day', 40, 1791114094000, 10080]]);
  const bare = C.claudeLimitsOf({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1791114094 });
  deep('without per-window detail, the window the event is about', bare.windows.map(w => [w.id, w.resetsAt]), [['seven_day', 1791114094000]]);

  const codex = new C.CodexSession({ thread: {}, turn: {} }).accept({
    method: 'account/rateLimits/updated',
    params: { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1790662612 }, secondary: { usedPercent: 56, windowDurationMins: 10080, resetsAt: 1791114094 } } },
  }).limits;
  deep("Codex's windows, named by their length", codex.windows.map(w => [w.id, w.usedPercent]), [['five_hour', 100], ['seven_day', 56]]);
  eq('a full window is a refusal', codex.status, 'rejected');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climodels-codexhome-'));
  const day = path.join(home, '.codex', 'sessions', '2026', '09', '29');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), [
    JSON.stringify({ timestamp: '2026-09-29T01:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: 1790000000 } } } }),
    JSON.stringify({ timestamp: '2026-09-29T02:00:00Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 30, window_minutes: 300, resets_at: 1790662612 }, secondary: { used_percent: 56, window_minutes: 10080, resets_at: 1791114094 }, credits: { has_credits: false, unlimited: false, balance: '0' } } } }),
    '{"cut off',
  ].join('\n'));
  const fromLogs = C.codexLimitsFromLogs({ home });
  deep("Codex's session log gives its latest figures", fromLogs?.windows.map(w => [w.id, w.usedPercent]), [['five_hour', 30], ['seven_day', 56]]);
  eq('dated by the log line', fromLogs?.updatedAt, Date.parse('2026-09-29T02:00:00Z'));
  eq('with its credits', fromLogs?.credits?.has, false);
  eq('no log is no figures', C.codexLimitsFromLogs({ home: path.join(home, 'nobody') }), null);
  fs.rmSync(home, { recursive: true, force: true });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climodels-data-'));
  const before = process.env.WEBUI_DATA_DIR;
  process.env.WEBUI_DATA_DIR = dataDir;
  try {
    C.noteLimits('claude-code', { status: 'allowed', windows: [{ id: 'five_hour', usedPercent: 20, resetsAt: Date.now() + 3600e3 }, { id: 'seven_day', usedPercent: 5, resetsAt: Date.now() + 86400e3 }] });
    C.noteLimits('claude-code', { status: 'allowed', windows: [{ id: 'five_hour', usedPercent: 25, resetsAt: Date.now() + 3600e3 }] });
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'cli-limits.json'), 'utf8'))['claude-code'];
    deep('an event about one window keeps the other', saved.windows.map(w => [w.id, w.usedPercent]), [['five_hour', 25], ['seven_day', 5]]);
    C.noteLimitError('claude-code', 'Claude AI usage limit reached|1790662612');
    eq('a run refused for the limit marks it', C.allLimits({ CODEX_HOME: path.join(dataDir, 'none') })['claude-code'].status, 'rejected');
    C.noteLimits('codex', { status: 'rejected', windows: [{ id: 'five_hour', usedPercent: 100, resetsAt: Date.now() - 1000 }] });
    const after = C.allLimits({ CODEX_HOME: path.join(dataDir, 'none') }).codex;
    check('a window whose reset has passed reads as empty, and usable', after.windows[0].usedPercent === 0 && after.status === 'allowed', JSON.stringify(after));
  } finally {
    if (before === undefined) delete process.env.WEBUI_DATA_DIR; else process.env.WEBUI_DATA_DIR = before;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------ what the tools changed

   A CLI running the workbench's tools in its own loop: the reader saw only
   "[tool: workbench / edit_file]" go by. Each change is put into the answer
   as its diff; a command goes into the thinking with its exit code. */
{
  const W = await import(pathToFileURL(path.join(ROOT, 'server/workbench.js')).href);
  const editResult = W.changeReport('C:\\proj\\src\\App.jsx', 'const a = 1;\n', 'const a = 2;\n', 'Edited');
  const cmdResult = W.commandReport('npm test', 'C:\\proj', { code: 1, output: 'ok 1\nFAIL something\n', ms: 1200, timedOut: false });

  const r = new C.ClaudeReader();
  r.accept({ type: 'stream_event', event: { type: 'message_start', message: { usage: {} } } });
  r.accept({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Changing it.' } } });
  const shown = r.accept({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: editResult }] },
    { type: 'tool_result', tool_use_id: 't2', content: cmdResult },
  ] } });
  check('a file change is put into the answer, as a diff', /📝 \*\*`C:\\proj\\src\\App\.jsx`\*\* \(\+1 −1\)\n```diff\n[\s\S]*-const a = 1;\n\+const a = 2;\n```/.test(shown?.content || ''), shown?.content);
  check('a command goes to the thinking, with its exit code and output', /\[command: npm test → exit 1\]\nok 1\nFAIL something/.test(shown?.thinking || ''), shown?.thinking);
  r.accept({ type: 'stream_event', event: { type: 'message_start', message: { usage: {} } } });
  const after = r.accept({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } } });
  check('and the text after it starts a new paragraph', after.content.startsWith('\n\n'), JSON.stringify(after));
  const plain = r.accept({ type: 'user', message: { content: [{ type: 'tool_result', content: 'just text' }] } });
  check('a result that changed nothing adds only its start, to the thinking',
    !plain?.content && plain?.thinking === '\n[result]\njust text\n[/output]\n', JSON.stringify(plain));

  const codex = new C.CodexSession({ thread: {}, turn: {} });
  const codexShown = codex.accept({ method: 'item/completed', params: { item: { type: 'mcpToolCall', server: 'workbench', tool: 'edit_file', status: 'completed', result: { content: [{ type: 'text', text: editResult }] } } } });
  check('Codex\'s tool changes are shown the same way', (codexShown?.content || '').includes('```diff'), JSON.stringify(codexShown));
}

/* --------------------------------------------------------------- models */

deep('`agy models` output, banner and labels dropped',
  C.parseAgyModels('Fetching available models...\r\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n'),
  ['gemini-3.1-pro-high', 'claude-sonnet-4-6']);
deep('.env names the list when it says', await C.modelsOf(C.PROVIDERS['claude-code'], { CLI_CLAUDE_MODELS: 'opus, haiku' }), ['opus', 'haiku']);
{
  const tag = C.toTagEntry(C.PROVIDERS.codex, 'gpt-5.5');
  eq('a tag entry is named <cli>:<model>', tag.name, 'codex:gpt-5.5');
  eq('and takes no room on the card', tag.size, 0);
}

/* ------------------------------------------------------------- timing

   A fake agy that behaves as the real one does: takes the question up at
   once, thinks for a while without showing it, then sends the whole answer
   in one burst. Timed from the first visible word, that was 2,700 tokens a
   second. It has to be timed from when the agent began. */

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climodels-fakeagy-'));
  const script = path.join(dir, 'fake-agy.mjs');
  fs.writeFileSync(script, [
    "const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "process.stdin.resume(); process.stdin.on('data', () => {});",
    "out({ event: 'step_update', step_update: { step_type: 'user_input', state: 'DONE' } });",
    "setTimeout(() => {",
    "  out({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Hello there, friend.' } });",
    "  out({ event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 8000, output_tokens: 300 } } });",
    "  process.exit(0);",
    "}, 1200);",
  ].join('\n'));
  let bin = script;
  if (process.platform === 'win32') {
    // What npm writes: a .cmd shim naming the script, which cliModels runs with this Node.
    bin = path.join(dir, 'agy.cmd');
    fs.writeFileSync(bin, '@ECHO off\r\nnode "%dp0%\\fake-agy.mjs" %*\r\n');
  } else {
    fs.chmodSync(script, 0o755);
    fs.writeFileSync(script, `#!${process.execPath}\n${fs.readFileSync(script, 'utf8')}`);
  }
  const t0 = Date.now();
  let startedAt = 0, firstTextAt = 0;
  const result = await C.runCli({
    provider: C.PROVIDERS.agy, model: 'x',
    request: { system: '', prompt: 'hi', images: [] },
    env: { AGY_CLI_PATH: bin, PATH: '', ...AGY_ENV },
    onStart: () => { if (!startedAt) startedAt = Date.now(); },
    onDelta: () => { if (!firstTextAt) firstTextAt = Date.now(); },
  });
  const ended = Date.now();
  eq('the fake agy answered', result.usage.eval, 300);
  check('the start is when the agent took the question up, well before the text', startedAt && firstTextAt - startedAt >= 1000,
    `started ${startedAt - t0}ms, first text ${firstTextAt - t0}ms`);
  const rate = result.usage.eval / ((ended - startedAt) / 1000);
  check('so the rate is a believable one, not thousands a second', rate < 400, `${rate.toFixed(0)} tok/s`);
  fs.rmSync(dir, { recursive: true, force: true });
}

/* agy's quota: only its terminal status line hears it. The script it pipes
   its state to keeps the quota for the app; the setup puts that script into
   agy's settings without disturbing anything else there. */
{
  const { spawnSync } = await import('node:child_process');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'climodels-agyquota-'));
  const payload = {
    model: { display_name: 'Gemini 3.5 Flash (High)' },
    plan_tier: 'Pro',
    quota: {
      'gemini-weekly': { remaining_fraction: 0.9378, reset_time: '2026-10-06T07:50:32Z', reset_in_seconds: 560580 },
      '3p-5h': { remaining_fraction: 0.1, reset_time: '2026-09-29T20:00:00Z' },
    },
  };
  const run = spawnSync(process.execPath, [path.join(ROOT, 'server/agyStatusline.mjs')], {
    input: JSON.stringify(payload), env: { ...process.env, WEBUI_DATA_DIR: data }, encoding: 'utf8',
  });
  eq('the status line script exits cleanly', run.status, 0);
  check('and prints a line for the terminal', run.stdout.includes('gemini-weekly 94% left'), run.stdout);
  const kept = JSON.parse(fs.readFileSync(path.join(data, 'agy-quota.json'), 'utf8'));
  eq('it keeps the quota for the app', kept.quota['3p-5h'].remaining_fraction, 0.1);
  const broken = spawnSync(process.execPath, [path.join(ROOT, 'server/agyStatusline.mjs')], { input: 'not json', encoding: 'utf8' });
  check('rubbish on stdin breaks nothing', broken.status === 0 && broken.stdout === '');

  const limits = C.agyLimitsOf(payload.quota);
  deep('as windows: used share and reset time', limits.windows.map(w => [w.id, w.usedPercent, w.resetsAt, w.windowMins]),
    [['gemini-weekly', 6.2, Date.parse('2026-10-06T07:50:32Z'), 10080], ['3p-5h', 90, Date.parse('2026-09-29T20:00:00Z'), 300]]);
  eq('a nearly spent window is a warning', limits.status, 'allowed_warning');

  const before = process.env.WEBUI_DATA_DIR;
  process.env.WEBUI_DATA_DIR = data;
  try {
    const agy = C.allLimits({ CODEX_HOME: path.join(data, 'none') }).agy;
    eq("the app reads what agy's status line kept", agy?.source, 'agy-statusline');
    eq('with its plan', agy?.plan, 'Pro');
  } finally {
    if (before === undefined) delete process.env.WEBUI_DATA_DIR; else process.env.WEBUI_DATA_DIR = before;
  }

  const settings = path.join(data, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ colorScheme: 'dark', trustedWorkspaces: ['C:\\x'] }));
  const setup = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'server/setupAgyStatusline.mjs'), ...args], {
    env: { ...process.env, AGY_SETTINGS_FILE: settings }, encoding: 'utf8',
  });
  setup();
  const installed = JSON.parse(fs.readFileSync(settings, 'utf8'));
  check('setup points the status line at the script', installed.statusLine?.command?.endsWith('server/agyStatusline.mjs') && installed.statusLine.type === 'command');
  check('stacked under agy\'s own line', installed.statusLine?.stack_with_default === true);
  check('and leaves every other setting as it was', installed.colorScheme === 'dark' && installed.trustedWorkspaces[0] === 'C:\\x');
  check('keeping a copy first', fs.existsSync(`${settings}.bak-ollama-webui`));
  setup('--remove');
  check('--remove takes only it away', !('statusLine' in JSON.parse(fs.readFileSync(settings, 'utf8'))));
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'my-own.sh' } }));
  setup();
  eq("someone's own status line is left alone", JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command, 'my-own.sh');
  fs.writeFileSync(settings, '{ broken');
  check('a settings file that does not parse is not overwritten', setup().status === 1 && fs.readFileSync(settings, 'utf8') === '{ broken');
  fs.rmSync(data, { recursive: true, force: true });
}

/* An agy that does not know the chat agent is asked again as itself, once,
   and not asked with it again. Last in the file: it switches the agent off
   for the rest of this process. */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climodels-noagent-'));
  const script = path.join(dir, 'fake-agy.mjs');
  fs.writeFileSync(script, [
    "const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "process.stdin.resume(); process.stdin.on('data', () => {});",
    "if (process.argv.includes('--agent')) {",
    "  process.stderr.write('Error: agent \"ollama-webui-chat\" not found\\n');",
    "  process.exit(1);",
    "}",
    "out({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'as itself' } });",
    "out({ event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 1, output_tokens: 2 } } });",
    "setTimeout(() => process.exit(0), 20);",
  ].join('\n'));
  const bin = path.join(dir, process.platform === 'win32' ? 'agy.cmd' : 'agy');
  if (process.platform === 'win32') fs.writeFileSync(bin, '@ECHO off\r\nnode "%dp0%\\fake-agy.mjs" %*\r\n');
  else { fs.writeFileSync(bin, `#!${process.execPath}\n${fs.readFileSync(script, 'utf8')}`); fs.chmodSync(bin, 0o755); }
  let text = '';
  await C.runCli({
    provider: C.PROVIDERS.agy, model: 'x',
    request: { system: '', prompt: 'hi', images: [] },
    env: { AGY_CLI_PATH: bin, PATH: '', ...AGY_ENV },
    onDelta: (d) => { text += d.content; },
  });
  eq('an agy without the agent is asked again as itself', text, 'as itself');
  check('and later runs do not pass the agent', !sandboxed(C.PROVIDERS.agy, 'x', { system: '', prompt: 'hi', images: [] }, { files: dir, env: AGY_ENV }).args.includes('--agent'));
  fs.rmSync(dir, { recursive: true, force: true });
}

/* --------------------------------------------------- the body read once */

{
  const { readRequestBody } = await import(pathToFileURL(path.join(ROOT, 'server/requestBody.js')).href);
  const req = { rawBody: Buffer.from('{"model":"x"}'), on() { throw new Error('read the spent stream'); } };
  eq('a body already read is handed on, not read again', (await readRequestBody(req)).toString(), '{"model":"x"}');
  let refused = null;
  try { await readRequestBody({ rawBody: Buffer.alloc(10) }, 5); } catch (e) { refused = e.statusCode; }
  eq('and still held to the limit', refused, 413);
}

fs.rmSync(AGY_DIR, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
