// Tool calls the model makes as data, rather than as text it has to spell.
//
// The old protocol was a page of system prompt telling the model to emit
// `<TOOL_WEB_SEARCH>…</TOOL_WEB_SEARCH>` and stop. It works, until it does
// not: the tag must be spelled exactly, closed exactly, and written alone, and
// a model that produces `<tool_web_search>` or adds a sentence after it has
// silently done nothing at all. There is no error — the text simply reads as
// prose, the tool never runs, and the answer is a confident guess.
//
// Ollama takes a `tools` array and returns `tool_calls`, and the models worth
// running here advertise `tools` in /api/show. What is checked here is the
// bridge: a structured call is rendered back into the tag the existing
// executor already understands, so there is one implementation of the ten
// tools rather than two that drift apart.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundle = await rolldown({ input: path.resolve(HERE, '../src/tools.js'), platform: 'neutral' });
const out = path.resolve(HERE, '../node_modules/.tools-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const {
  TOOL_SCHEMAS, toolNames, parseToolArgs, nativeCallToTag, supportsTools, toolCallsIn,
} = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ----------------------------------------------------------- the schemas */

check('there are schemas', TOOL_SCHEMAS.length >= 10, String(TOOL_SCHEMAS.length));
for (const schema of TOOL_SCHEMAS) {
  const fn = schema.function || {};
  check(`${fn.name || '?'} is a well-formed function schema`,
    schema.type === 'function'
    && typeof fn.name === 'string' && /^[a-z][a-z0-9_]*$/.test(fn.name)
    && typeof fn.description === 'string' && fn.description.length > 20
    && fn.parameters && fn.parameters.type === 'object'
    && typeof fn.parameters.properties === 'object',
    JSON.stringify(fn).slice(0, 120));

  // Every required argument has to be declared, or the model is being asked
  // for a field the schema never mentions.
  for (const req of fn.parameters?.required || []) {
    check(`${fn.name} declares its required '${req}'`, req in fn.parameters.properties);
  }
}

const schemaNames = TOOL_SCHEMAS.map(s => s.function.name).sort();
check('every schema can be rendered as a tag',
  schemaNames.every(n => nativeCallToTag(n, {}) !== null),
  schemaNames.filter(n => nativeCallToTag(n, {}) === null).join(','));
check('and every renderable name has a schema',
  toolNames().sort().join(',') === schemaNames.join(','),
  `${toolNames().sort().join(',')}\n      ${schemaNames.join(',')}`);

/* ------------------------------------------------------- the arguments */

eq('an object is taken as it is', parseToolArgs({ query: 'cats' }).query, 'cats');
// Some models hand the arguments back as a JSON string rather than an object.
eq('a JSON string is parsed', parseToolArgs('{"query":"cats"}').query, 'cats');
eq('broken JSON is not a crash', JSON.stringify(parseToolArgs('{oh no')), '{}');
eq('an array is not arguments', JSON.stringify(parseToolArgs([1, 2])), '{}');
eq('nothing is not arguments', JSON.stringify(parseToolArgs(undefined)), '{}');
eq('a bare string is not arguments', JSON.stringify(parseToolArgs('cats')), '{}');

/* -------------------------------------------------------- the rendering */

eq('a search', nativeCallToTag('web_search', { query: 'hash tables' }),
  '<TOOL_WEB_SEARCH>hash tables</TOOL_WEB_SEARCH>');
eq('a fetch', nativeCallToTag('fetch_url', { url: 'https://example.com' }),
  '<TOOL_FETCH_URL>https://example.com</TOOL_FETCH_URL>');
eq('news with a topic', nativeCallToTag('get_news', { topic: 'seoul' }),
  '<TOOL_NEWS>seoul</TOOL_NEWS>');
eq('news with none', nativeCallToTag('get_news', {}), '<TOOL_NEWS></TOOL_NEWS>');
eq('a file read', nativeCallToTag('read_file', { path: 'C:\\notes.txt' }),
  '<TOOL_READ_FILE>C:\\notes.txt</TOOL_READ_FILE>');
eq('a directory listing', nativeCallToTag('list_dir', { path: '/tmp' }),
  '<TOOL_LIST_DIR>/tmp</TOOL_LIST_DIR>');
eq('the ones that take nothing', nativeCallToTag('get_time', {}), '<TOOL_TIME></TOOL_TIME>');
eq('and system info', nativeCallToTag('system_info', {}), '<TOOL_SYSTEM_INFO></TOOL_SYSTEM_INFO>');

// Two attributes, in the order the executor's pattern expects.
eq('a file search', nativeCallToTag('search_files', { path: '/src', query: 'TODO' }),
  '<TOOL_SEARCH_FILES path="/src" query="TODO"></TOOL_SEARCH_FILES>');

// A write puts its content in the body and its path in an attribute.
const write = nativeCallToTag('write_file', { path: '/a.txt', content: 'hello\nthere' });
check('a file write carries both', /^<TOOL_WRITE_FILE path="\/a\.txt">\n?hello\nthere\n?<\/TOOL_WRITE_FILE>$/.test(write), write);

// A quote in a path would close the attribute early and change which file is
// written — the one place this rendering could do damage rather than fail.
const quoted = nativeCallToTag('search_files', { path: '/a" onerror="x', query: 'q' });
check('a quote in an argument cannot break out of the attribute',
  !/path="\/a" onerror=/.test(quoted), quoted);

// A name the model invented is refused rather than run.
eq('an unknown tool renders nothing', nativeCallToTag('rm_rf', { path: '/' }), null);
eq('an empty name renders nothing', nativeCallToTag('', {}), null);

/* ------------------------------------------------------ the capability */

check('a model that lists tools has them', supportsTools({ capabilities: ['completion', 'tools'] }));
check('one that does not, does not', !supportsTools({ capabilities: ['completion', 'vision'] }));
check('no capabilities at all is a no', !supportsTools({}));
check('no answer at all is a no', !supportsTools(null));

/* -------------------------------------------------- reading the frames */

const frame = {
  message: {
    content: '',
    tool_calls: [
      { function: { name: 'web_search', arguments: { query: 'cats' } } },
      { function: { name: 'fetch_url', arguments: '{"url":"https://x.test"}' } },
    ],
  },
};
const calls = toolCallsIn(frame);
eq('both calls are read', calls.length, 2);
eq('the first is named', calls[0].name, 'web_search');
eq('its arguments are an object', calls[0].args.query, 'cats');
eq('and a stringified one is parsed too', calls[1].args.url, 'https://x.test');

eq('an ordinary frame has no calls', toolCallsIn({ message: { content: 'hello' } }).length, 0);
eq('a done frame has none', toolCallsIn({ done: true }).length, 0);
eq('nothing has none', toolCallsIn(null).length, 0);
eq('a call with no name is discarded',
  toolCallsIn({ message: { tool_calls: [{ function: { arguments: {} } }] } }).length, 0);

/* ------------------------------------------------------- the call sites */

const app = fs.readFileSync(path.resolve(HERE, '../src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');

check('the schemas are sent only when the model has tools',
  /useNativeTools \? \{ tools: schemasFor\(\{ web: mcpEnabled, drawing: !drewThisTurn \}\) \} : \{\}/.test(app));
check('and the model is asked rather than assumed',
  /const useNativeTools = modelSupportsTools\(activeModel\);/.test(app));
/* What is *offered* is no longer all-or-nothing. Fetching a page and reading a
   file need permission; making a picture does not, and behind the same switch
   a request to draw was answered with a paragraph describing the picture —
   the model had never been told it could draw. So the drawing schemas go with
   every turn and the rest wait for the switch. */
check('drawing needs no switch and the rest do',
  /tools: schemasFor\(\{ web: mcpEnabled,/.test(app));
/* And a picture ends the turn's tool use. Searching is iterative; drawing is
   not, and being told "you have 9 tool calls left" after a picture reads to a
   model as an invitation — it drew again, and again. Withdrawing the tool is
   the only reliable answer: asking a model not to use something it is still
   being handed is how the first version behaved. */
check('a second picture in one turn is not offered', /drawing: !drewThisTurn/.test(app));
check('and the tag for one is not matched either',
  /!\(drewThisTurn && DRAWING_TAGS\.has\(tool\.name\)\)/.test(app));
/* "This turn" is this turn. Counted over the whole chat, one picture at the
   start of a conversation withdrew drawing for the rest of it, the tag
   instructions vanished after the first tool call anywhere, and the budget of
   ten ran out per chat rather than per question. */
check('a picture is looked for in this turn only',
  /const drewThisTurn = thisTurn\.some\(/.test(app));
check('and so are the calls already spent',
  /const spent = thisTurn\s*\n?\s*\.filter\(isToolResult\)/.test(app)
  && /const mcpToolCallsInTurnForSystem = thisTurn\.filter\(isToolResult\)\.length/.test(app));
/* And a picture that worked ends the turn. The leg after it was allowed one
   sentence, and a model that had drawn a picture it could not see sometimes
   spent it saying it cannot draw — under the picture. */
check('a turn that only drew, and drew, is not handed back to the model',
  /const drewEverything = dropped\.length === 0[\s\S]{0,200}?turnImages\.length - picturesBefore >= running\.length/.test(app)
  && /if \(drewEverything\) \{[\s\S]{0,1400}?\} else \{[\s\S]{0,1800}?handleSend\(null, nextMessages, activeModel\)/.test(app));
check('and "the picture is made" is said only when one was',
  /const drew = turnImages\.length > picturesBefore;/.test(app));
check('which reads the capability /api\\/show already reports',
  /modelSupportsTools = \(name\) => hasCapability\(name, 'tools'\)/.test(app));

// Both protocols at once would give the model two ways to do one thing, and it
// would sometimes do both.
check('the tag instructions are dropped when native tools are in use',
  /if \(mcpEnabled && !useNativeTools && mcpToolCallsInTurnForSystem === 0\)/.test(app));

check('structured calls are collected from the stream', /for \(const call of toolCallsIn\(parsed\)\) nativeCalls\.push\(call\)/.test(app));
check('and routed into the one executor', /const toolSource = canonicalToolTags\(nativeText \|\| answerText\)/.test(app));
check('which still matches on patterns', /toolSource\.matchAll\(new RegExp\(tool\.pattern, 'g'\)\)/.test(app));

/* ------------------------------------------- more than one call in a turn

   Native tool calling returns an *array*, and the executor took `[0]`. "Search
   for this and also tell me the time" therefore came back having done half of
   it, with nothing to say the other half had been dropped. The tag protocol
   only ever produces one, so this changed nothing for a model without them. */

check('every call is collected, not just the first',
  /const invocations = allowed[\s\S]{0,400}?flatMap/.test(app));
// The registry is built whatever the switch says and filtered afterwards.
// Building it conditionally is what made the drawing tools unreachable.
check('and the registry is filtered rather than skipped',
  /const allowed = TOOLS\.filter\(tool => \(mcpEnabled \|\| DRAWING_TAGS\.has\(tool\.name\)\)/.test(app));
check('and they run in the order the model asked for',
  /\.sort\(\(a, b\) => a\.match\.index - b\.match\.index\);/.test(app)
  && !/\.sort\(\(a, b\) => a\.match\.index - b\.match\.index\)\[0\]/.test(app));
check('the budget counts calls rather than messages', /--- TOOL_\[A-Z_\]\+ ---/.test(app));
check('a call the budget cannot afford is named rather than dropped in silence',
  /--- SKIPPED ---/.test(app));
// Three web searches fired at one provider at once is how a free backend
// starts refusing; the second or two saved is not worth that.
check('they run one at a time', /for \(const invoked of running\)/.test(app));

/* ------------------------------------------------------ clickable citations */

check('the passages are kept as data, not only as prompt text', /turnCitations = hits\.map/.test(app));
check('and attached to the finished message', /citations: turnCitations/.test(app));
check('a citation marker becomes a button', /tagName: 'button'[\s\S]{0,400}?citation-mark/.test(app));

// A web result and a document passage are cited the same way and behave
// differently: the page *is* the source, so it opens; a passage has no page,
// so it opens the passage. The two are distinguishable before pressing.
check('a web source opens its page', /if \(passage\.url\) \{[\s\S]{0,140}?window\.open\(passage\.url/.test(app));
check('and looks like a link', /'citation-mark', 'is-link'/.test(app));
// Two independently-numbered lists would both start at [1], and nothing could
// tell which source the model meant.
check('web results continue the document numbering',
  /const base = \(turnCitations \|\| \[\]\)\.length;/.test(app)
  && /formatSearchResults\(results, base\)/.test(app));
// A link in an answer used to replace the app, and a model is very often
// still writing when somebody follows a source it just cited.
check('a link in an answer opens a new tab',
  /a: \(\{ node, \.\.\.props \}\) => \([\s\S]{0,120}?target="_blank" rel="noopener noreferrer"/.test(app));
// `[3]` when two passages came back is the model inventing a source, and
// dressing that up as a link would be the worst outcome available.
check('a number with no passage behind it stays plain text',
  /if \(!\(n >= 1 && n <= count\)\) continue;/.test(app));
// `arr[1]` in a snippet is an index, not a citation.
check('and code is left alone',
  /if \(node\.tagName === 'code' \|\| node\.tagName === 'pre'\) return;/.test(app));
check('pressing one opens the passage', /setOpenCitation\(\{ n, \.\.\.passage \}\)/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
