// Blocks, splicing and the cleaning of what a model sends back. All pure, so
// none of it needs a browser -- which is the reason it is in its own module
// rather than inline in the panel.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../node_modules/.canvas-test-bundle.mjs');

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/canvas.js'),
  platform: 'neutral',
});
await bundle.write({ file: OUT, format: 'esm' });
await bundle.close();

const {
  splitBlocks, blocksInRange, snapToBlocks, buildRewritePrompt,
  cleanRewrite, spliceSpan, spanLabel, looksLikeDocument,
} = await import(pathToFileURL(OUT).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

// ------------------------------------------------------------------- blocks
const DOC = `# Title

First paragraph, which is about one thing.

Second paragraph, about another.

- item one
- item two

\`\`\`js
const a = 1;

const b = 2;
\`\`\`

Last paragraph.`;

const blocks = splitBlocks(DOC);
const texts = blocks.map(b => b.text.trim());

check('the heading is its own block', texts[0] === '# Title', JSON.stringify(texts[0]));
check('paragraphs are separate', texts.includes('First paragraph, which is about one thing.')
  && texts.includes('Second paragraph, about another.'));
// Rewriting the third item of a list must not mean rewriting all five.
check('each list item stands alone',
  texts.includes('- item one') && texts.includes('- item two'), JSON.stringify(texts));

// The one rule that needs state. Without it a snippet with a blank line in it
// becomes two blocks, the second beginning with a closing fence.
const code = texts.find(t => t.startsWith('```'));
check('a fenced block survives a blank line inside it',
  code && code.includes('const a = 1;') && code.includes('const b = 2;') && code.endsWith('```'),
  JSON.stringify(code));
check('and the fence did not swallow the rest', texts[texts.length - 1] === 'Last paragraph.');

// Offsets, not text search: a document that repeats itself must still splice
// into the right place.
check('every block is located by offset',
  blocks.every(b => DOC.slice(b.start, b.end) === b.text));
check('blocks are in order and do not overlap',
  blocks.every((b, i) => i === 0 || b.start >= blocks[i - 1].end));

check('an empty document has no blocks', splitBlocks('').length === 0);
check('whitespace alone has no blocks', splitBlocks('\n\n   \n').length === 0);
check('a single line is one block', splitBlocks('just this').length === 1);

const unclosed = splitBlocks('para\n\n```js\nnever closed');
check('an unclosed fence takes the rest rather than breaking', unclosed.length === 2,
  JSON.stringify(unclosed.map(b => b.text)));

// ---------------------------------------------------------------- selection
const para = blocks.find(b => b.text.includes('Second paragraph'));
const inside = snapToBlocks(blocks, para.start + 5, para.start + 10);
check('a selection of three words snaps to its paragraph',
  inside.text.trim() === 'Second paragraph, about another.', JSON.stringify(inside.text));
check('and reports one block', inside.count === 1);

// A click with no drag is somebody pointing at a paragraph.
const caret = snapToBlocks(blocks, para.start + 3, para.start + 3);
check('a caret with no selection still picks a block', caret?.count === 1);

const across = snapToBlocks(blocks, blocks[1].start + 2, blocks[2].start + 2);
check('a selection across two blocks takes both whole', across.count === 2);
check('and spans from the first edge to the last', across.start === blocks[1].start
  && across.end === blocks[2].end);

check('a selection in empty space picks nothing', snapToBlocks([], 0, 5) === null);
check('blocksInRange ignores blocks it does not touch',
  blocksInRange(blocks, blocks[1].start, blocks[1].end).length === 1);

// ------------------------------------------------------------------ prompt
const span = { start: para.start, end: para.end, text: para.text };
const messages = buildRewritePrompt(DOC, span, 'make it shorter');
check('the prompt is a system rule and a user task', messages.length === 2
  && messages[0].role === 'system' && messages[1].role === 'user');
check('the block is marked in place', messages[1].content.includes('[[SELECTED]]Second paragraph'),
  messages[1].content.slice(0, 200));
check('the rest of the document is context', messages[1].content.includes('First paragraph'));
check('the instruction is carried', messages[1].content.includes('make it shorter'));
check('the model is told to return only the part', /ONLY the replacement/.test(messages[0].content));
check('a language can be pinned',
  /Write in Korean/.test(buildRewritePrompt(DOC, span, 'x', { language: 'Korean' })[0].content));

// A chapter in the prompt is minutes of prefill on a local model, so the
// document is trimmed to the neighbourhood -- but never the part being asked
// about.
const huge = `${'filler '.repeat(4000)}TARGET${'filler '.repeat(4000)}`;
const hugeSpan = { start: huge.indexOf('TARGET'), end: huge.indexOf('TARGET') + 6, text: 'TARGET' };
const trimmed = buildRewritePrompt(huge, hugeSpan, 'x', { windowChars: 1000 })[1].content;
check('a long document is trimmed around the span', trimmed.length < 3000, String(trimmed.length));
check('and the span itself is never trimmed away', trimmed.includes('[[SELECTED]]TARGET[[/SELECTED]]'));
check('the trim is marked as one', trimmed.includes('…'));

// ----------------------------------------------------------------- cleaning
check('a plain reply is left alone', cleanRewrite('A better paragraph.') === 'A better paragraph.');
check('a preamble is removed',
  cleanRewrite("Sure! Here's the revised paragraph:\n\nA better one.") === 'A better one.');
check('so is a bare "Here is"',
  cleanRewrite('Here is the rewritten version:\nThe text.') === 'The text.');
check('but a paragraph that begins like one survives',
  cleanRewrite('Here is where Rome was founded, and it matters.')
    === 'Here is where Rome was founded, and it matters.');

check('a fence around the whole reply is unwrapped',
  cleanRewrite('```\nThe paragraph.\n```') === 'The paragraph.');
check('a fence with a language too',
  cleanRewrite('```markdown\nThe paragraph.\n```') === 'The paragraph.');
// A rewritten paragraph may legitimately contain a code sample.
check('a fence inside the reply is kept',
  cleanRewrite('Use this:\n\n```js\nx()\n```\n\nand then stop.').includes('```js'));

check('markers the model repeated are stripped',
  cleanRewrite('[[SELECTED]]The text.[[/SELECTED]]') === 'The text.');
check('reasoning emitted inline is stripped',
  cleanRewrite('<think>hmm</think>The text.') === 'The text.');
check('surrounding quotes are removed', cleanRewrite('"The text."') === 'The text.');
check('but dialogue inside is not', cleanRewrite('She said "no" and left.') === 'She said "no" and left.');

// The rule that matters most: a rewrite must never silently delete a paragraph.
check('an empty reply keeps the original', cleanRewrite('', 'original') === 'original');
check('a reply that was only a preamble keeps the original',
  cleanRewrite('Sure! Here is the revised paragraph:', 'original') === 'original');
check('whitespace alone keeps the original', cleanRewrite('   \n  ', 'original') === 'original');

// ----------------------------------------------------------------- splicing
const spliced = spliceSpan(DOC, span, 'Replaced.');
check('the replacement is in place', spliced.includes('Replaced.'));
check('the old text is gone', !spliced.includes('Second paragraph, about another.'));
check('the neighbours are untouched', spliced.includes('First paragraph, which is about one thing.')
  && spliced.includes('Last paragraph.'));
// Getting this wrong glues two paragraphs together, which reads as the model
// failing rather than the splice.
check('the blank lines around it are kept', /\n\nReplaced\.\n\n/.test(spliced), JSON.stringify(spliced));
check('a reply arriving with its own padding is trimmed to fit',
  /\n\nReplaced\.\n\n/.test(spliceSpan(DOC, span, '\n\n  Replaced.  \n\n')));

// Splicing the first block has no leading whitespace to preserve.
const first = { start: blocks[0].start, end: blocks[0].end, text: blocks[0].text };
check('the first block splices cleanly', spliceSpan(DOC, first, '# New').startsWith('# New'));

// -------------------------------------------------------------------- misc
check('a label is one line', spanLabel('two\nlines here') === 'two lines here');
check('and is cut when long', spanLabel('x'.repeat(200)).endsWith('…'));

check('a long prose answer is a document', looksLikeDocument('word '.repeat(200)));
check('a short answer is not', !looksLikeDocument('Yes, that is right.'));
// Four hundred words of code with a sentence round it is the artifact panel's
// job, and offering both would be two buttons doing different things.
check('an answer that is mostly code is not',
  !looksLikeDocument(`Here you go:\n\n\`\`\`js\n${'const x = 1;\n'.repeat(200)}\`\`\`\n\nThat is it.`));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
