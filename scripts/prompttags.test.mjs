// A comma-separated prompt, read as a list of tags.
//
// Every rule here is invisible when it is wrong. A completion that takes the
// token boundary a character too far replaces the word *before* the one being
// typed — which looks like the feature working right up until you read what it
// wrote. A join that gets the order wrong produces a valid prompt that draws
// the wrong emphasis. Nothing throws.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const P = await import(pathToFileURL(path.join(ROOT, 'src/promptTags.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* --------------------------------------------------- which tag is the caret in

   Written with a `|` marking the caret, because reading an index out of a
   sentence is how off-by-ones get past review. */
const at = (marked) => {
  const caret = marked.indexOf('|');
  return { text: marked.replace('|', ''), caret };
};
const tokenOf = (marked) => {
  const { text, caret } = at(marked);
  return P.tokenAt(text, caret).text;
};

eq('the only tag', tokenOf('blue ey|'), 'blue ey');
eq('the last of several', tokenOf('1girl, solo, blue ey|'), 'blue ey');
// Editing in the middle of a prompt is the common case, not the rare one.
eq('one in the middle', tokenOf('1girl, blue ey|, solo'), 'blue ey');
eq('the first of several', tokenOf('blue ey|, solo'), 'blue ey');
// The space after a comma belongs to the separator, not to the tag: without
// this, accepting a suggestion eats it and the prompt closes up.
eq('the space after a comma is not part of the tag', tokenOf('1girl,   blu|'), 'blu');
eq('an empty tag is empty', tokenOf('1girl, |'), '');
eq('nothing at all', tokenOf('|'), '');

/* People write these in paragraphs, so a newline separates tags as firmly as a
   comma does. Without this the token runs back through the line above and a
   completion swallows it. */
eq('a newline ends the tag before it', tokenOf('1girl, solo\nblue ey|'), 'blue ey');
eq('and the one after it', tokenOf('blue ey|\nmore tags'), 'blue ey');

const span = (marked) => {
  const { text, caret } = at(marked);
  const t = P.tokenAt(text, caret);
  return [t.start, t.end];
};
check('the span covers the tag and nothing else',
  JSON.stringify(span('1girl, blu|e, solo')) === JSON.stringify([7, 11]),
  JSON.stringify(span('1girl, blu|e, solo')));

/* ------------------------------------------------------- accepting one */

const accept = (marked, tag) => {
  const { text, caret } = at(marked);
  const out = P.replaceToken(text, caret, tag);
  return out.value.slice(0, out.caret) + '|' + out.value.slice(out.caret);
};

eq('a tag at the end gets a comma after it',
  accept('blue ey|', 'blue eyes'), 'blue eyes, |');
// Typing into the middle should not push a comma into the middle too.
eq('a tag in the middle keeps the comma that is already there',
  accept('1girl, blue ey|, solo', 'blue eyes'), '1girl, blue eyes|, solo');
/* A space is not a separator. `long hair` is one tag with a space in it, so
   `blue ey solo` with no comma between them is one tag too, and completing it
   replaces the whole thing. Written down because the opposite is the obvious
   guess and it would break every two-word tag in the vocabulary. */
eq('a space does not start a new tag',
  accept('1girl, blue ey| solo', 'blue eyes'), '1girl, blue eyes, |');
eq('replacing the only tag', accept('blu|', 'blush'), 'blush, |');
// A tag with brackets in it — a character name — must arrive intact.
eq('an escaped name survives',
  accept('choc|', 'chocho \\(homelessfox\\)'), 'chocho \\(homelessfox\\), |');

/* --------------------------------------------------------- pasted links */

check('a booru post link', P.looksLikeBooruLink('https://safebooru.org/index.php?page=post&s=view&id=7108138'));
check('danbooru too', P.looksLikeBooruLink('https://danbooru.donmai.us/posts/7108138'));
check('with whitespace around it', P.looksLikeBooruLink('  https://yande.re/post/show/1  '));
/* Pasting a paragraph that happens to mention a booru should paste a
   paragraph. Only a bare link is an instruction. */
check('prose containing a link is prose',
  !P.looksLikeBooruLink('see https://danbooru.donmai.us/posts/1 for reference'));
check('another site is not a booru', !P.looksLikeBooruLink('https://example.com/posts/1'));
check('a tag list is not a link', !P.looksLikeBooruLink('1girl, solo, blue eyes'));
check('and nothing is not a link', !P.looksLikeBooruLink(''));

/* ------------------------------------------------------ the four, joined

   The order is the whole point: these models read a prompt positionally, so
   "masterpiece, best quality" belongs in front of the subject and "depth of
   field, film grain" behind it. */

const form = { lead: 'masterpiece', artist: '(@someone:1.2)', prompt: '1girl, solo', tail: 'film grain' };
eq('all four, in order',
  P.joinPrompt(form), 'masterpiece, (@someone:1.2), 1girl, solo, film grain');
/* Anima has an artist encoder and the artists go to it separately, so they must
   not also appear in the prompt — naming them twice is naming them twice. */
eq('the artists come out when the workflow encodes them itself',
  P.joinPrompt(form, { foldArtist: false }), 'masterpiece, 1girl, solo, film grain');

eq('empty parts leave no gaps',
  P.joinPrompt({ lead: '', artist: '', prompt: '1girl', tail: '' }), '1girl');
// Somebody who ends a box with a comma should not get `a, , b`.
eq('a trailing comma in a box is not a hole in the prompt',
  P.joinPrompt({ lead: 'masterpiece,', prompt: '1girl', tail: ', grain' }), 'masterpiece, 1girl, grain');
eq('whitespace-only parts are empty',
  P.joinPrompt({ lead: '   ', prompt: '1girl', tail: '\n' }), '1girl');
eq('nothing at all joins to nothing', P.joinPrompt({}), '');
eq('and undefined does not throw', P.joinPrompt(undefined), '');

check('a prompt with only a lead is still a prompt', P.hasPrompt({ lead: 'masterpiece' }));
check('but an empty form is not', !P.hasPrompt({ lead: '', prompt: '  ' }));
/* The subtle one: with the artists held out, a form containing *only* artists
   has nothing to draw — and the Generate button has to be able to say so. */
check('artists alone are not a subject when they are encoded separately',
  !P.hasPrompt({ artist: '(@someone:1.2)' }, { foldArtist: false }));
check('but they are when they are folded in',
  P.hasPrompt({ artist: '(@someone:1.2)' }, { foldArtist: true }));

/* ------------------------------------------------------------ the wiring */

const P_SRC = fs.readFileSync(path.join(ROOT, 'src/promptTags.js'), 'utf8');
const panel = fs.readFileSync(path.join(ROOT, 'src/StudioPanel.jsx'), 'utf8');
/* Four boxes, named by what they are rather than counted: the three quiet rows
   come from one helper now, so the class name appears fewer times than there
   are boxes and a count would fail for the wrong reason. */
check('the panel has four positive boxes',
  /quietPart\('lead'/.test(panel) && /quietPart\('artist'/.test(panel)
  && /quietPart\('tail'/.test(panel) && /studio-prompt-part is-main/.test(panel));
// And in the order they are sent, because these models read by position.
check('in the order they are joined',
  panel.indexOf("quietPart('lead'") < panel.indexOf("quietPart('artist'")
  && panel.indexOf("quietPart('artist'") < panel.indexOf('studio-prompt-part is-main')
  && panel.indexOf('studio-prompt-part is-main') < panel.indexOf("quietPart('tail'"));
/* Completion belongs to the subject box only. The other three hold settings,
   and a dropdown over them would be in the way of the thing being set. */
check('only the subject box completes', (panel.match(/<TagPrompt/g) || []).length === 1);
check('and it is the one that takes pasted links', /onBooru=\{fillFromBooru\}/.test(panel));
check('the four are joined on the way out', /prompt: joinPrompt\(form, \{ foldArtist \}\)/.test(panel));
check('the artists go separately where the workflow can take them',
  /has\.artist \? \{ artist: /.test(panel));
// Rebuilding the four boxes by splitting the joined string back up would be
// guesswork, so the job carries them.
check('a job remembers the parts, so reuse can restore them', /parts: \{ lead:/.test(panel));

const tagPrompt = fs.readFileSync(path.join(ROOT, 'src/TagPrompt.jsx'), 'utf8');
/* A slow request for `b` landing after a fast one for `blue` would otherwise
   replace the right list with a stale one. */
check('a late response for an old query is discarded',
  /query\.current !== needle/.test(tagPrompt));
check('the list is closed after picking, not before',
  /onMouseDown=\{\(e\) => \{ e\.preventDefault\(\); accept/.test(tagPrompt));
/* A tag prompt is not prose: spell-check underlines every tag, and on a phone
   autocapitalise and autocorrect rewrite them. */
check('spell-check and autocorrect are off', /spellCheck=\{false\}/.test(tagPrompt)
  && /autoCorrect="off"/.test(tagPrompt));

/* A prompt restored from last time put its first tag under a caret that
   starts at 0, and the list opened over the form the moment the Studio did,
   in a box nobody had clicked. Only typing (or Ctrl+Space) asks for it. */
check('suggestions wait for typing in the focused box',
  /if \(!armed\.current \|\| document\.activeElement !== box\.current\)/.test(tagPrompt));
check('typing arms them and leaving the box disarms them',
  /armed\.current = true;\s*onChange\(e\.target\.value\)/.test(tagPrompt)
  && /onBlur=\{\(\) => \{ armed\.current = false;/.test(tagPrompt));
check('Ctrl+Space asks for them without a keystroke', /event\.ctrlKey && \(event\.code === 'Space'/.test(tagPrompt));

/* `navigator.clipboard` is undefined over plain HTTP, which is how this app is
   reached from a phone — the copy button did nothing, silently. */
check('the Studio copies through copyText', /import \{ copyText \} from '\.\/clipboard\.js'/.test(panel)
  && /if \(await copyText\(job\.prompt\)\)/.test(panel));
check('and not through the API that is missing over HTTP', !/navigator\.clipboard\.writeText\(/.test(panel));

const lightbox = fs.readFileSync(path.join(ROOT, 'src/StudioLightbox.jsx'), 'utf8');
check('a finished picture opens in the viewer', /className="studio-job-open" onClick=\{onOpen\}/.test(panel)
  && /onOpen=\{\(\) => setViewing\(job\.id\)\}/.test(panel));
check('the viewer is a modal dialog', /role="dialog"/.test(lightbox) && /aria-modal="true"/.test(lightbox));
/* The app has its own Escape and arrow shortcuts; the viewer has to see the
   keys first, or Escape closes more than the viewer. */
check('the viewer takes its keys before the app does', /addEventListener\('keydown', onKey, true\)/.test(lightbox)
  && /stopPropagation/.test(lightbox));
/* The ceiling is the screen. Going to actual size made every view of a
   2520-pixel picture a fragment of it, so the largest size on offer is the
   largest one that is still all there -- and never past the picture's own
   pixels, which would only be a softer copy of what is already on screen. */
check('enlarging stops at what the screen can hold',
  !/is-actual|scrollLeft|setPointerCapture/.test(lightbox)
  && /maxWidth: `min\(100%, \$\{dims\.w\}px\)`/.test(lightbox));
{
  /* `max-height: 100%` on a grid item of a `1fr` row resolved to nothing, so
     the picture was only ever bounded by the width and the rest was cropped.
     Positioned against the stage, both percentages resolve. */
  const css = fs.readFileSync(path.join(ROOT, 'src/studio.css'), 'utf8');
  const rule = /\.studio-lightbox-stage img \{([\s\S]*?)\}/.exec(css)?.[1] || '';
  check('the picture is bounded by the stage in both directions',
    /position: absolute;/.test(rule) && /max-height: 100%;/.test(rule) && /max-width: calc\(100% - 136px\);/.test(rule));
  check('and nothing scrolls to see the rest of it',
    /\.studio-lightbox-stage \{[\s\S]*?overflow: hidden;[\s\S]*?\}/.test(css) && !/overflow: auto/.test(
      /\.studio-lightbox-stage[\s\S]*?\.studio-lightbox-nav/.exec(css)?.[0] || ''));
}
check('the viewer is styled', /\.studio-lightbox \{/.test(fs.readFileSync(path.join(ROOT, 'src/studio.css'), 'utf8')));

/* -------------------------------------------------------------- weights

   Written with `[` and `]` around the selection that comes back, because the
   selection is half the behaviour: it is what lets the key be pressed again. */
const weigh = (marked, delta) => {
  const text = marked.replace('|', '');
  const caret = marked.indexOf('|');
  const out = P.nudgeWeight(text, caret, caret, delta);
  return out && out.value.slice(0, out.selStart) + '[' + out.value.slice(out.selStart, out.selEnd) + ']' + out.value.slice(out.selEnd);
};
eq('Ctrl+Up wraps the tag under the caret', weigh('1girl, blue e|yes, smile', 0.1), '1girl, ([blue eyes]:1.1), smile');
eq('and raises a weight that is there', weigh('1girl, (blue eyes:1.|2), smile', 0.1), '1girl, ([blue eyes]:1.3), smile');
eq('back to 1 unwraps it', weigh('(blue eyes:1.1|)', -0.1), '[blue eyes]');
eq('below 1 is a weight too', weigh('smi|le', -0.1), '([smile]:0.9)');
{
  // The selection left by one press is what the next one works on.
  const first = P.nudgeWeight('a, blue eyes, c', 4, 4, 0.1);
  const second = P.nudgeWeight(first.value, first.selStart, first.selEnd, 0.1);
  eq('a second press works on the selection the first left', second.value, 'a, (blue eyes:1.2), c');
}
eq('no tag, nothing to weigh', P.nudgeWeight('a, , b', 3, 3, 0.1), null);
/* The caret is what makes the key repeatable, and React moves it to the end
   when it writes the new value in. Restored on a timer rather than on a frame:
   under a headless browser the frame callback did not run at all, and the
   second press then weighed whichever tag the end fell in. */
check('the caret is put back after React rewrites the box',
  /restoreSelection\(box, out\.value, out\.selStart, out\.selEnd\)/.test(P_SRC)
  && /setTimeout\(tick, 0\)/.test(P_SRC) && !/requestAnimationFrame\(tick\)/.test(P_SRC));
check('every prompt box takes the keys', (panel.match(/onWeightKey\(e, v => set\(/g) || []).length === 2
  && /onWeightKey\(event,/.test(fs.readFileSync(path.join(ROOT, 'src/TagPrompt.jsx'), 'utf8')));

const server = fs.readFileSync(path.join(ROOT, 'server/workflows.js'), 'utf8');
check('the artist box is emptied of its author default too',
  /'positive', 'negative', 'artist'/.test(server));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
