// A long attachment that did not look like an attachment.
//
// An attached file is not stored on the message. It is folded into the text
// that goes to the model, wrapped in a marker, and the transcript unwraps it
// again so the reader sees a chip with a filename rather than ten thousand
// lines of CSV.
//
// A file too long to send whole is indexed into the knowledge library instead,
// leaving a note that says so. That note was added at the send site and
// nowhere else — so four hand-written regexes went on looking only for
// `--- Attached File:`, and a long attachment showed up as the raw sentence
//
//     [Attached document: report.pdf, 214 pages. Its full text has been
//     indexed; the relevant passages are supplied below.]
//
// sitting inside the reader's own message, where every other file got a chip.
// The transcript, the HTML export, the sidebar preview and the text-to-speech
// all had the same hole, because they were four copies of one piece of
// knowledge instead of one.
//
// So what is checked here is the round trip — anything written by this module
// is read back by it — and, separately, that no reader has gone back to
// spelling the pattern out for itself.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({
  input: path.resolve(ROOT, 'src/attachMarkers.js'),
  platform: 'neutral',
});
const out = path.resolve(ROOT, 'node_modules/.attachmarkers-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const { fileMarker, indexedMarker, extractAttachments, stripAttachments } =
  await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------ the round trip */

const short = 'What does this do?' + fileMarker('setup.py', 'import os\nprint(os.name)\n');
const readShort = extractAttachments(short);
eq('a small file leaves one chip', readShort.attachments.length, 1);
eq('named after the file', readShort.attachments[0].name, 'setup.py');
eq('and drawn as a file', readShort.attachments[0].type, 'file');
eq('with the contents taken out of the message', readShort.cleanedContent, 'What does this do?');

// The case that was reported.
const long = 'Summarise this.' + indexedMarker({ name: 'report.pdf', pages: 214 });
const readLong = extractAttachments(long);
eq('a long file leaves one chip too', readLong.attachments.length, 1);
eq('named after the file, the same way', readLong.attachments[0].name, 'report.pdf');
eq('and it knows how big it was', readLong.attachments[0].pages, 214);
eq('the sentence does not stay in the message', readLong.cleanedContent, 'Summarise this.');

// The whole point of the report: from the transcript's side these are the
// same thing, and the only difference is a tooltip.
eq('both kinds carry a name to draw',
  [readShort, readLong].every(r => typeof r.attachments[0].name === 'string' && r.attachments[0].name), true);

const noPages = extractAttachments(indexedMarker({ name: 'notes.md' }));
eq('a document with no page count still parses', noPages.attachments.length, 1);
eq('and says it has none', noPages.attachments[0].pages, null);
eq('leaving nothing behind', noPages.cleanedContent, '');

/* --------------------------------------------------------- awkward filenames */

// The pattern is anchored on its fixed tail rather than on the name, because
// a name anchored pattern breaks on the first invoice called `2024.03, final`.
for (const name of ['2024.03, final.pdf', 'a, b, c.txt', 'notes. draft.md', '설정 파일.env']) {
  const parsed = extractAttachments(indexedMarker({ name, pages: 3 }));
  eq(`a name with punctuation survives: ${name}`, parsed.attachments[0]?.name, name);
}

/* ---------------------------------------------------------------- both kinds */

const mixed = 'Compare these.'
  + fileMarker('small.txt', 'hello')
  + indexedMarker({ name: 'big.pdf', pages: 500 });
const readMixed = extractAttachments(mixed);
eq('two files, two chips', readMixed.attachments.length, 2);
eq('in the order they were attached', readMixed.attachments.map(a => a.name).join(','), 'small.txt,big.pdf');
eq('and the message is just the question', readMixed.cleanedContent, 'Compare these.');

const many = 'x' + fileMarker('a.txt', '1') + fileMarker('b.txt', '2') + fileMarker('c.txt', '3');
eq('three files, three chips', extractAttachments(many).attachments.length, 3);

/* --------------------------------------------------------------- the strips */

// The reading voice, the sidebar preview and the HTML export all want the
// blocks gone. A marker one of them does not know is a marker read out loud.
const spoken = stripAttachments(long, ' ').trim();
check('the indexed note is not read out loud', !spoken.includes('Attached document'), spoken);
check('nor is a file body', !stripAttachments(short, ' ').includes('import os'));

const fetched = 'See this.\n\n--- [MCP Tool] Fetched Content from https://example.com ---\nbody\n-------------------';
eq('a fetched page is a chip as well', extractAttachments(fetched).attachments[0].type, 'url');
eq('named by its address', extractAttachments(fetched).attachments[0].name, 'https://example.com');

const grounded = 'Question\n\n--- [Knowledge] ---\npassages\n-------------------';
check('retrieved passages are stripped too', !stripAttachments(grounded).includes('passages'));

eq('nothing in, nothing out', extractAttachments('').attachments.length, 0);
eq('and no message survives as undefined', extractAttachments(null).cleanedContent, '');
eq('a plain message is left exactly alone', extractAttachments('just a question').cleanedContent, 'just a question');

/* ------------------------------------------- opening it after it was sent

   An attachment is folded into the message text and stored nowhere else, so
   the body inside the marker is the only surviving copy of what was attached.
   It used to be skipped by the pattern rather than captured, which is why the
   chip in the composer opened and the same chip in the transcript could not:
   there was nothing left to open. */

const sent = 'Look at this.' + fileMarker('config.toml', '[server]\nport = 5173\n');
const chip = extractAttachments(sent).attachments[0];
eq('a sent file still carries its contents', chip.data, '[server]\nport = 5173\n');
check('so the viewer has something to show', chip.data.includes('port = 5173'));
eq('and the message itself is still just the question',
  extractAttachments(sent).cleanedContent, 'Look at this.');

// A body with the closing rule inside it, which a greedy pattern would run past
// and a careless one would cut short.
const tricky = fileMarker('notes.md', 'before\n----\nafter');
eq('a body containing dashes survives',
  extractAttachments(tricky).attachments[0].data, 'before\n----\nafter');

// Two files, each with its own body -- not the first body twice, and not one
// run spanning both.
const pair = fileMarker('a.txt', 'AAA') + fileMarker('b.txt', 'BBB');
const bodies = extractAttachments(pair).attachments.map(a => a.data);
eq('two files keep two bodies', bodies.join('|'), 'AAA|BBB');

// An indexed document has no body in the message on purpose: its text is in
// the knowledge library, and the viewer looks it up by name instead.
eq('an indexed one carries no body, by design',
  extractAttachments(indexedMarker({ name: 'big.pdf', pages: 9 })).attachments[0].data, undefined);

/* --------------------------------------------- nobody spells it out any more */

const sources = ['src/App.jsx', 'src/htmlExport.js', 'src/chatSearch.js']
  .map(rel => [rel, fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')]);

// Comments quote the marker while explaining why it moved. A check that
// counts the explanation as a recurrence is a check that punishes writing one.
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

for (const [rel, whole] of sources) {
  const text = withoutComments(whole);
  // The `--- Attached File:` pattern, written out by hand. Every copy of it
  // was a reader that had to be taught about the indexed marker separately,
  // and none of them were.
  const copies = (text.match(/Attached File:/g) || []).length;
  eq(`${rel} does not spell the file marker out`, copies, 0);
  const notes = (text.match(/\[Attached document:/g) || []).length;
  eq(`${rel} does not spell the indexed marker out`, notes, 0);
}

const app = sources[0][1];

// The transcript chip is a button now, and the viewer it opens is the one the
// composer already used. Both halves are asserted, because either alone is a
// chip that looks pressable and does nothing.
check('the transcript chip opens the viewer',
  app.includes('onClick={() => canOpen && setViewingAttachment(att)}'));
check('and a sent image opens it too',
  /setViewingAttachment\(\{[^}]*type: 'image'/.test(app));
check('an indexed document is found by name when it has no id',
  app.includes('knowledge.find(d => d.name === att.name)'));

check('the composer writes through the shared writer', app.includes('finalInputText += indexedMarker(att)'));
check('and so does a short file', app.includes('finalInputText += fileMarker(att.name, att.data)'));
check('the module is the only definition', fs.existsSync(path.join(ROOT, 'src/attachMarkers.js')));

/* ------------------------------------------------------- the tooltip's words */

// The chip is identical to an ordinary attachment on purpose; what differs
// goes in the tooltip, and a tooltip in one language is not a tooltip.
const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8').replace(/\r\n/g, '\n');
eq('every language explains an indexed attachment', (i18n.split("'attach.indexedFull':").length - 1), 12);
eq('every language explains a multi-request turn', (i18n.split("'msg.turnLegs':").length - 1), 12);
check('and the turn count has somewhere to go', i18n.includes('{legs}'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
