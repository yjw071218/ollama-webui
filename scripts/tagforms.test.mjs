// Tool calls written the way a model writes HTML, and the one refusal.
//
// Reported as: the video was never made, and this sat in the answer instead:
//
//   <TOOL_GENERATE_VIDEO from="last_image" duration=5 prompt="[0s-2s] …
//     [2s-5s] …" />
//
// Self-closing, the prompt as an attribute, a value without quotes -- three
// departures from the documented form, any one of which was enough for no
// pattern to match. Every reader of tool tags now reads them in the documented
// form whatever form was written.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const load = (file) => import(pathToFileURL(path.join(ROOT, file)).href);
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const REPORTED = 'I will animate her now.\n\n<TOOL_GENERATE_VIDEO from="last_image" duration=5 prompt="[0s-2s] A woman looks at the viewer, blinking slowly.\n  [2s-5s] She smiles and waves as the camera zooms in." />';
const CANON = '<TOOL_GENERATE_VIDEO from="last_image" duration="5">[0s-2s] A woman looks at the viewer, blinking slowly.\n  [2s-5s] She smiles and waves as the camera zooms in.</TOOL_GENERATE_VIDEO>';

const T = await load('src/tools.js');
eq('the reported call is read in the documented form', T.canonicalToolTags(REPORTED), `I will animate her now.\n\n${CANON}`);
eq('the documented form is left as it is', T.canonicalToolTags(CANON), CANON);
check('and reading twice changes nothing', T.canonicalToolTags(T.canonicalToolTags(REPORTED)) === T.canonicalToolTags(REPORTED));
eq('a self-closing call with no arguments', T.canonicalToolTags('<TOOL_REMOVE_BACKGROUND/>'), '<TOOL_REMOVE_BACKGROUND></TOOL_REMOVE_BACKGROUND>');
eq('a bare value against the closing slash', T.canonicalToolTags('<TOOL_UPSCALE_IMAGE factor=4/>'), '<TOOL_UPSCALE_IMAGE factor="4"></TOOL_UPSCALE_IMAGE>');
eq('single quotes and lower case', T.canonicalToolTags("<tool_generate_image style='anime' prompt='a cat'/>"),
  '<TOOL_GENERATE_IMAGE style="anime">a cat</TOOL_GENERATE_IMAGE>');
eq('a quote inside a single-quoted value survives',
  T.tagAttrs(T.canonicalToolTags(`<TOOL_GENERATE_IMAGE negative='a "logo"' prompt='x'/>`).match(/<TOOL_GENERATE_IMAGE([^>]*)>/)[1]).negative,
  'a "logo"');
eq('a body already written is kept over an attribute',
  T.canonicalToolTags('<TOOL_GENERATE_IMAGE prompt="ignored">the body</TOOL_GENERATE_IMAGE>'),
  '<TOOL_GENERATE_IMAGE prompt="ignored">the body</TOOL_GENERATE_IMAGE>');
eq('a search\'s query stays where search_files wants it',
  T.canonicalToolTags('<TOOL_SEARCH_FILES path="C:\\x" query="todo"/>'), '<TOOL_SEARCH_FILES path="C:\\x" query="todo"></TOOL_SEARCH_FILES>');
eq('while a web search\'s becomes its body', T.canonicalToolTags('<TOOL_WEB_SEARCH query="cats" />'), '<TOOL_WEB_SEARCH>cats</TOOL_WEB_SEARCH>');
eq('a tag still being written is left alone', T.canonicalToolTags('<TOOL_GENERATE_VIDEO from="la'), '<TOOL_GENERATE_VIDEO from="la');
eq('and so is one that opens and never closes', T.canonicalToolTags('Write <TOOL_TIME> to ask.'), 'Write <TOOL_TIME> to ask.');
eq('a tool result is not a call', T.canonicalToolTags('<TOOL_RESULT>x</TOOL_RESULT>'), '<TOOL_RESULT>x</TOOL_RESULT>');

// Read as a call, and run as one.
const { parseAssistantMessage } = await load('src/messageParts.js');
{
  const blocks = parseAssistantMessage(REPORTED);
  eq('it shows as a step, not as text', blocks.map(b => b.type), ['text', 'tool_call']);
  eq('  with its attributes', [blocks[1].tool, blocks[1].attrs.from, blocks[1].attrs.duration], ['TOOL_GENERATE_VIDEO', 'last_image', '5']);
  check('  and the prompt as its body', /^\[0s-2s\]/.test(blocks[1].content));
}
{
  const app = read('src/App.jsx');
  check('the executor reads the documented form', /const toolSource = canonicalToolTags\(nativeText \|\| answerText\);/.test(app));
  const pattern = new RegExp(`<TOOL_GENERATE_VIDEO${T.TAG_ATTRS}\\s*>([\\s\\S]*?)<\\/TOOL_GENERATE_VIDEO>`);
  const hit = pattern.exec(T.canonicalToolTags(REPORTED));
  check('which the video pattern then matches', !!hit && T.tagAttrs(hit[1]).duration === '5' && /\[2s-5s\]/.test(hit[2]));
  check('the model is told the form in so many words', /not as a prompt="…" attribute and not in a self-closing/.test(app));
  check('speech and export read it the same way',
    /const cleanForExport = \(content\) => canonicalToolTags\(content \|\| ''\)/.test(app)
    && /const stripForSpeech = \(text\) => stripAttachments\(\s*\n\s*canonicalToolTags\(text \|\| ''\)/.test(app));
}
{
  const { sessionToMarkdown } = await load('src/htmlExport.js');
  const md = sessionToMarkdown({ title: 't', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: `${REPORTED}\n\nDone!` }] });
  check('an export drops the call and keeps what came after it', md.includes('Done!') && !md.includes('TOOL_'), md);
  check('as does a share link', /canonicalToolTags\(String\(content \|\| ''\)\)/.test(read('src/shareLink.js')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
