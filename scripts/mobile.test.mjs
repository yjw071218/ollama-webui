// The two things a phone can do that a desktop cannot, and the layout rule
// that stops the bottom of the app running off the side of the screen.
//
// Measured on a 390x844 phone before the layout fix: the footer laid the token
// meter, the thinking switch and the MCP switch across one row whose minimum
// width is about 470px. None of them can shrink -- each is an icon beside a
// word -- so the row simply grew, the browser shrank the whole page to fit
// (window.innerWidth came back as 429 against a 390 screen), and the meter hung
// off the left edge at -30px while the MCP switch hung off the right at 420.
//
// The fix is one property, `flex-wrap`, and one class to hang it on, because
// the row was inline-styled and a media query cannot override an inline style
// without `!important` on every line. Both are asserted here.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundleOne = async (entry, out) => {
  const bundle = await rolldown({ input: path.resolve(HERE, entry), platform: 'neutral' });
  const file = path.resolve(HERE, out);
  await bundle.write({ file, format: 'esm' });
  await bundle.close();
  return import(pathToFileURL(file).href);
};

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ============================================================ sharing ==== */

const share = await bundleOne('../src/share.js', '../node_modules/.share-test-bundle.mjs');
const { canShare, shareText, shareBody, sharePicture } = share;

// ---- what gets sent

eq('the question comes first', shareBody({ question: 'why?', answer: 'because' }),
  'Q. why?\n\nbecause');
eq('the model is credited last', shareBody({ question: 'why?', answer: 'because', model: 'qwen3' }),
  'Q. why?\n\nbecause\n\n— qwen3');
eq('an answer with no question still shares', shareBody({ answer: 'because' }), 'because');
eq('nothing at all shares nothing', shareBody({}), '');
eq('whitespace is not an answer', shareBody({ question: '  ', answer: '  ' }), '');
eq('called with no argument at all', shareBody(), '');

// ---- whether there is a sheet to open

// Node defines `navigator` as a getter-only property, so it has to be
// redefined rather than assigned.
const setGlobal = (name, value) => {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

const withGlobals = async (navigatorPatch, windowPatch, run) => {
  const savedNav = globalThis.navigator, savedWin = globalThis.window;
  setGlobal('navigator', navigatorPatch);
  setGlobal('window', windowPatch);
  try { return await run(); } finally {
    setGlobal('navigator', savedNav); setGlobal('window', savedWin);
  }
};

eq('no share function, no sheet',
  await withGlobals({}, { isSecureContext: true }, () => canShare()), false);
eq('a share function and a secure page, yes',
  await withGlobals({ share: () => {} }, { isSecureContext: true }, () => canShare()), true);

// The app is reached over plain http on a home network constantly, and
// `navigator.share` throws there rather than reporting itself absent.
eq('an insecure page, no',
  await withGlobals({ share: () => {} }, { isSecureContext: false }, () => canShare()), false);

// ---- what the outcomes mean

eq('nothing to share is not attempted',
  await withGlobals({ share: async () => {} }, { isSecureContext: true },
    () => shareText({ text: '   ' })), 'failed');

eq('a sheet that accepts reports shared',
  await withGlobals({ share: async () => {} }, { isSecureContext: true },
    () => shareText({ text: 'hello' })), 'shared');

// Dismissing the sheet is a decision, not a failure. Reporting it as one would
// pop a red error at somebody who deliberately chose not to share.
const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
eq('a dismissed sheet is cancelled, not failed',
  await withGlobals({ share: async () => { throw abort; } }, { isSecureContext: true },
    () => shareText({ text: 'hello' })), 'cancelled');

const denied = Object.assign(new Error('no gesture'), { name: 'NotAllowedError' });
eq('a refused gesture is treated the same way',
  await withGlobals({ share: async () => { throw denied; } }, { isSecureContext: true },
    () => shareText({ text: 'hello' })), 'cancelled');

eq('any other throw is a failure the caller should fall back from',
  await withGlobals({ share: async () => { throw new TypeError('nope'); } }, { isSecureContext: true },
    () => shareText({ text: 'hello' })), 'failed');

eq('a browser with no sheet says so, so the caller can copy instead',
  await withGlobals({}, { isSecureContext: true }, () => shareText({ text: 'hello' })), 'unsupported');

// A title is optional and must not be invented: some targets show it and an
// empty one reads as a blank subject line.
let sawKeys = null;
await withGlobals({ share: async (data) => { sawKeys = Object.keys(data).sort().join(','); } },
  { isSecureContext: true }, () => shareText({ text: 'hello' }));
eq('no title means no title key', sawKeys, 'text');
await withGlobals({ share: async (data) => { sawKeys = Object.keys(data).sort().join(','); } },
  { isSecureContext: true }, () => shareText({ title: 'A chat', text: 'hello' }));
eq('a title is passed when there is one', sawKeys, 'text,title');

/* ========================================================== wake lock ==== */

const wake = await bundleOne('../src/wakeLock.js', '../node_modules/.wake-test-bundle.mjs');
const { wakeLockSupported, holdScreenAwake } = wake;

const fakeDocument = () => {
  const listeners = {};
  return {
    visibilityState: 'visible',
    addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
    removeEventListener: (name, fn) => {
      listeners[name] = (listeners[name] || []).filter(f => f !== fn);
    },
    fire: (name) => (listeners[name] || []).slice().forEach(fn => fn()),
    count: (name) => (listeners[name] || []).length,
  };
};

const withWake = async (navigatorPatch, doc, run) => {
  const savedNav = globalThis.navigator, savedDoc = globalThis.document;
  setGlobal('navigator', navigatorPatch);
  setGlobal('document', doc);
  try { return await run(); } finally {
    setGlobal('navigator', savedNav); setGlobal('document', savedDoc);
  }
};

eq('no wakeLock, unsupported', await withWake({}, fakeDocument(), () => wakeLockSupported()), false);
eq('a wakeLock, supported',
  await withWake({ wakeLock: { request: async () => ({}) } }, fakeDocument(), () => wakeLockSupported()), true);

// An unsupported browser must still hand back something callable: the caller
// is a React effect and returning a non-function from one is an error.
await withWake({}, fakeDocument(), async () => {
  const stop = holdScreenAwake();
  check('unsupported still returns a release function', typeof stop === 'function');
  stop();
});

// The lock is taken, and released when the caller says so.
{
  const doc = fakeDocument();
  let taken = 0, releases = 0;
  const sentinel = { addEventListener: () => {}, release: async () => { releases++; } };
  await withWake({ wakeLock: { request: async () => { taken++; return sentinel; } } }, doc, async () => {
    const stop = holdScreenAwake();
    await new Promise(r => setTimeout(r, 0));
    eq('the lock is taken', taken, 1);
    eq('and a visibility listener is watching', doc.count('visibilitychange'), 1);
    stop();
    await new Promise(r => setTimeout(r, 0));
    eq('releasing releases it', releases, 1);
    eq('and stops watching', doc.count('visibilitychange'), 0);
  });
}

// The system takes the lock away whenever the page hides and does not give it
// back. Without re-taking it, the second half of any answer the reader looked
// away from is unprotected -- which is the whole failure this guards against.
{
  const doc = fakeDocument();
  let taken = 0;
  // Modelled on the spec: a sentinel carries `released`, and the system sets
  // it when the page hides. Nothing fires a `release` event here, because a
  // browser that revoked the lock while nothing was listening is exactly the
  // case that must still recover.
  let live = null;
  const request = async () => {
    taken++;
    live = { released: false, addEventListener: () => {}, release: async () => { live.released = true; } };
    return live;
  };
  const oldFire = doc.fire;
  doc.fire = (name) => {
    if (name === 'visibilitychange' && doc.visibilityState === 'hidden' && live) live.released = true;
    oldFire(name);
  };
  await withWake({ wakeLock: { request } }, doc, async () => {
    const stop = holdScreenAwake();
    await new Promise(r => setTimeout(r, 0));
    eq('taken once', taken, 1);
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');
    await new Promise(r => setTimeout(r, 0));
    eq('hiding does not take another', taken, 1);
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    await new Promise(r => setTimeout(r, 0));
    eq('coming back takes it again', taken, 2);
    stop();
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    await new Promise(r => setTimeout(r, 0));
    eq('and after release it stays released', taken, 2);
  });
}

// A refused lock -- low battery, a permissions policy -- must leave the app
// working exactly as before. This is an improvement, not a requirement.
{
  const doc = fakeDocument();
  await withWake({ wakeLock: { request: async () => { throw new Error('denied'); } } }, doc, async () => {
    let threw = false;
    try {
      const stop = holdScreenAwake();
      await new Promise(r => setTimeout(r, 0));
      stop();
    } catch (e) { threw = true; }
    check('a refused lock does not throw', !threw);
  });
}

/* ====================================================== the phone layout == */

const css = [
  fs.readFileSync(path.resolve(HERE, '../src/index.css'), 'utf8'),
  fs.readFileSync(path.resolve(HERE, '../src/extras.css'), 'utf8'),
].join('\n').replace(/\r\n/g, '\n');
const app = fs.readFileSync(path.resolve(HERE, '../src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');

// The row must be a class, not an inline style: a media query cannot override
// an inline style, and every phone rule for this row is a media query.
check('the footer controls are a class, not an inline style',
  /className="composer-controls"/.test(app));
check('and the footer itself is too',
  /className="input-footer">/.test(app));
check('no inline flex is left on the footer',
  !/className="input-footer" style=/.test(app));

// The one property that stops the page being wider than the phone.
check('the control row wraps', /\.composer-controls\s*\{[^}]*flex-wrap:\s*wrap/.test(css));
check('the footer wraps too', /\.input-footer\s*\{[^}]*flex-wrap:\s*wrap/.test(css));

// `space-between` is right for one row and wrong for a wrapped one: it strands
// the third item under a gap the width of the screen.
check('a wrapped row is centred rather than spread',
  /@media[^{]*860px[\s\S]*?\.composer-controls\s*\{[^}]*justify-content:\s*center/.test(css));

// Each control may give ground so that two can share a line.
check('the controls are allowed to shrink on a phone',
  /\.ctx-meter,\s*\n?\s*\.mcp-toggle-container,\s*\n?\s*\.think-toggle\s*\{[^}]*min-width:\s*0/.test(css));

/* ---------------------------------------------------------- a picture

   The reason a picture needs its own path: a browser will only take files it
   says it can take, and it says so through a second call made with the actual
   File. There is no way to know in advance, so the bytes are fetched first and
   the question asked afterwards -- and "it will not take this" has to come
   back as `unsupported`, because that is what tells the caller to offer a link
   instead of reporting a failure at somebody. */

const pngBlob = { type: 'image/png', size: 3 };
const withFetch = (body) => {
  const saved = globalThis.fetch;
  const savedFile = globalThis.File;
  setGlobal('fetch', async () => ({ ok: true, blob: async () => body }));
  setGlobal('File', class { constructor(parts, name, opts) { this.name = name; this.type = opts?.type; } });
  return () => { setGlobal('fetch', saved); setGlobal('File', savedFile); };
};

{
  const restore = withFetch(pngBlob);
  try {
    eq('no share sheet at all, no picture share',
      await withGlobals({}, { isSecureContext: true },
        () => sharePicture({ url: '/x.png' })), 'unsupported');

    eq('a browser that will not take files says so, rather than failing',
      await withGlobals({ share: async () => {}, canShare: () => false }, { isSecureContext: true },
        () => sharePicture({ url: '/x.png' })), 'unsupported');

    eq('and one that will, shares it',
      await withGlobals({ share: async () => {}, canShare: () => true }, { isSecureContext: true },
        () => sharePicture({ url: '/x.png', filename: 'a.png' })), 'shared');

    eq('dismissing it is still a decision',
      await withGlobals({ share: async () => { throw abort; }, canShare: () => true },
        { isSecureContext: true }, () => sharePicture({ url: '/x.png' })), 'cancelled');

    eq('with nothing to fetch there is nothing to share',
      await withGlobals({ share: async () => {}, canShare: () => true }, { isSecureContext: true },
        () => sharePicture({})), 'unsupported');
  } finally { restore(); }
}

// A picture whose bytes cannot be read is a failure, not an absent sheet: the
// sheet is there, and offering a link instead would not have helped.
{
  const saved = globalThis.fetch;
  setGlobal('fetch', async () => { throw new Error('offline'); });
  try {
    eq('bytes that cannot be read are a failure',
      await withGlobals({ share: async () => {}, canShare: () => true }, { isSecureContext: true },
        () => sharePicture({ url: '/x.png' })), 'failed');
  } finally { setGlobal('fetch', saved); }
}

/* ------------------------------------------- and what a link is made of

   The row names the file rather than carrying it -- an 11 MB PNG does not fit
   in a share row, and a copy of it would outlive the link being revoked. */

const links = await bundleOne('../src/shareLink.js', '../node_modules/.sharelink-test-bundle.mjs');
eq('an address is read back into the three fields that name a file',
  JSON.stringify(links.outputRef('/studio/view?filename=a.png&subfolder=webui&type=output')),
  JSON.stringify({ filename: 'a.png', subfolder: 'webui', type: 'output' }));
eq('something that is not one names nothing', links.outputRef('/nope'), null);
eq('a picture that knows its address is published by it',
  JSON.stringify(links.picturePayload({ url: '/studio/view?filename=a.png&subfolder=webui&type=output', prompt: 'p' })),
  JSON.stringify({ filename: 'a.png', subfolder: 'webui', type: 'output', prompt: 'p' }));
// Every workflow writes under the same prefix, so a name is enough on its own.
eq('and one that knows only its name is found where they are all written',
  links.picturePayload({ filename: 'b.png' }).subfolder, 'webui');
eq('a picture with neither cannot be published', links.picturePayload({ prompt: 'p' }), null);
check('the bytes are fetched by token, not by filename',
  /\/api\/share\/image\?/.test(links.sharedImageUrl('tok'))
  && links.sharedImageUrl('tok').includes('token=tok'));

/* ------------------------------------------------------ and the wiring

   A picture leaves this app two ways, and both of them are a button. */
{
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const app = read('src/App.jsx');
  const panel = read('src/StudioPanel.jsx');
  const i18n = read('src/i18n.jsx');
  check('a picture in a conversation can be shared',
    /pictureAction\('share', picture\)/.test(app) && /const sharePictureOut/.test(app));
  check('the sheet is tried first, and a link is what "no sheet" means',
    /await sharePicture\(\{/.test(app) && /sheet === 'shared' \|\| sheet === 'cancelled'/.test(app));
  check('the link names the file rather than carrying it',
    /picture: payload/.test(app) && /picturePayload\(picture\)/.test(app));
  check('a picture in the Studio leaves the same two ways',
    /onSharePicture/.test(panel) && /onSharePicture=\{sharePictureOut\}/.test(app));
  const dicts = (i18n.match(/^const [a-zA-Z]+ = \{$/gm) || []).length;
  for (const key of ['picture.share', 'picture.shareLinked', 'picture.shareFailed']) {
    const n = (i18n.match(new RegExp(`'${key.replace('.', '\.')}':`, 'g')) || []).length;
    check(`  ${key} is translated into all ${dicts} languages`, n === dicts, `${n}`);
  }
}

/* ================================================ what a phone was getting wrong

   Four reports, one session, all four measured in a headless phone viewport
   rather than argued about. Each one is pinned here by the property that was
   actually wrong, because each was invisible in the source until it was
   measured.

   These are read out of the stylesheet rather than rendered: the rendering is
   what the measurement did, and repeating it in the test suite would mean a
   browser and a dev server to run `npm test`. */

const ROOT_ = path.resolve(HERE, '..');
/* Line endings normalised on the way in. These files are edited on Windows by
   several tools and some of them are now CRLF in places, which turned a check
   for a two-line CSS rule into a check for nothing -- it failed by finding the
   rule absent rather than misplaced. */
const read = (file) => fs.readFileSync(path.resolve(HERE, '..', file), 'utf8').replace(/\r\n/g, '\n');
const extras = read('src/extras.css');
const studioCss = read('src/studio.css');
// `app` is already read further up, with its line endings normalised.

/* ---- the model picker that did nothing ----

   Measured: with a notice on screen at 390x844, `elementFromPoint` at the
   centre of the composer's model button returned `div.toast`, and the button
   was unreachable. The bottom right of a phone is the composer, and that is
   where the notices were. */
{
  check('the notice stack lets presses through the air around it',
    /\.toast-stack \{[^}]*pointer-events: none;/.test(extras)
    && /\.toast-stack > \* \{ pointer-events: auto; \}/.test(extras));
  check('and on a phone it is not over the composer at all',
    /@media \(max-width: 860px\) \{\s*\.toast-stack \{[\s\S]{0,600}bottom: auto;/.test(extras));
  /* Under the header, whatever height that is: the in-chat search opens a
     second row inside it, and a fixed offset then put the notices across
     the search field. The header measures itself into `--header-h`. */
  check('  clearing a header that has grown a second row',
    /var\(--header-h, 56px\)/.test(extras)
    && /--header-h/.test(read('src/App.jsx')));
  check('  coming down from the top, so the animation matches where it is',
    /@keyframes toast-in-top/.test(extras));
}

/* ---- the buttons that overlapped the message below ----

   `opacity: 0` hides a thing from the eye and from nothing else. The toolbar
   is absolutely positioned 36px below its own message, so an invisible row of
   buttons lay across the top of the next one, and pressing the first line of a
   reply pressed Copy on the one above it. */
{
  check('an invisible toolbar is also out of reach',
    /\.message-row \.msg-hover-actions \{ pointer-events: none; \}/.test(extras));
  check('  and comes back when it is shown',
    /\.message-row:hover \.msg-hover-actions,[\s\S]{0,160}pointer-events: auto;/.test(extras));
}

/* ---- tap to show, tap again to hide ----

   It existed, behind `(hover: none)`. That is not true of every device held in
   a hand -- Android with "desktop site" on, a tablet with a trackpad -- and on
   those the desktop toolbar came back at 390px, where seven buttons do not fit.

   The stylesheet and the script have to ask the same question. The CSS decides
   whether the bar is `display: none` until `.actions-open`; the script decides
   whether anything ever adds that class. Disagreeing one way gives a toolbar
   nothing can open, and the other way one nothing can close. */
{
  check('the toolbar is revealed by tapping on a phone, hover or not',
    /@media \(hover: none\), \(max-width: 640px\) \{/.test(extras));
  check('  and the script opens it under exactly the same condition',
    /matchMedia\?\.\('\(hover: none\), \(max-width: 640px\)'\)/.test(app));
  check('  a tap toggles, so a second one puts it away',
    /setOpenActionsIndex\(prev => \(prev === index \? null : index\)\)/.test(app));
  check('  and a PC click opens the same capsule',
    /onClick=\{e => toggleMessageActions\(e, i\)\}/.test(app) && /click-capsule/.test(extras));
}

/* ---- the Studio's seed ----

   Measured at 390px: the field was 79px wide for a number that needs 161. These
   workflows produce fifteen-digit seeds, so more than half of it was cut off --
   in a field whose whole purpose is to be read back and typed in again.

   The rule meant to fix it was written at `max-width: 560px` and lost to one at
   `max-width: 939px` further down the file: both match on a phone, and with
   equal specificity the later one wins. So the phone layout is last in the
   file, and this checks that it still is. */
{
  const phone = studioCss.lastIndexOf('@media (max-width: 640px)');
  const wider = studioCss.lastIndexOf('@media (max-width: 939px)');
  check('the phone footer rule is there', phone > 0);
  check('  and comes after the wider one it has to beat', phone > wider, `${phone} vs ${wider}`);
  check('  giving the seed the whole width', /\.studio-seed \{ grid-column: 1 \/ -1; \}/.test(studioCss));
  check('  with nothing left on a dead column',
    /@media \(max-width: 640px\)[\s\S]{0,700}\.studio-footer \{\s*grid-template-columns: minmax\(0, 1fr\);/.test(studioCss));
}

/* ====================================== a body that is not JSON, and what to say

   Reported: with a VPN on, pressing generate produced

       Unexpected token '<', "<!doctype "... is not valid JSON

   which is a message from a parser about a parser. What it means is that
   something answered with an HTML page where data was expected -- on this
   network, a VPN routing the app's own public address out through a tunnel,
   where the machine in the next room is not. Nothing can fix the routing from
   inside the app; saying so in one sentence is the whole of the fix. */

{
  const J = await import(pathToFileURL(path.join(ROOT_, 'src/jsonFetch.js')).href);
  const answer = (body, status = 200) => ({ status, text: async () => body });

  const said = async (body, status) => {
    try { await J.readJson(answer(body, status), 'The picture server'); return '(parsed)'; }
    catch (e) { return e.message; }
  };

  check('a web page is named as a web page, not as a stray "<"',
    /web page instead of data/.test(await said('<!doctype html><html><head>')));
  check('  and the cause worth checking first is named',
    /VPN/.test(await said('<!doctype html>')));
  check('an empty body says so', /answered with nothing/.test(await said('', 200)));
  check('a server error says which', /HTTP 500/.test(await said('boom', 500)));
  check('and JSON still parses', (await J.readJson(answer('{"a":1}'))).a === 1);

  const app2 = read('src/App.jsx');
  check('the paths somebody presses go through it',
    /const postJson = async \(url, init\) => readJson\(/.test(app2)
    && /await postJson\('\/studio\/generate'/.test(app2));
  /* The job poll runs once a second for as long as a picture takes. Throwing
     on one bad answer would end the wait for a generation still running. */
  check('  and the job poll still shrugs a bad answer off',
    /const fetchJsonQuietly = /.test(app2));
}

/* ------------------------------------------- a helper that already parsed it

   `postJson` and `panelJson` return the parsed body. The call sites they
   replaced looked like

       await (await fetch(url, init)).json()

   and replacing only the opening of that expression leaves the `.json()` on
   the end -- now applied to an object, which has no such method. That is
   exactly what shipped: pressing generate threw "… .json is not a function"
   while ComfyUI drew the picture perfectly well, because the request had gone
   and only the reading of the answer was broken.

   Checked as text because it is a shape, not a behaviour: nothing runs these
   files in the test suite, and the build does not mind. */
{
  const offenders = [];
  for (const file of ['src/App.jsx', 'src/StudioPanel.jsx']) {
    const text = read(file);
    /* `(await fetch(…)).json()` is the idiom these helpers replaced, so the
       closing `)).json()` it leaves behind is the mistake and nothing else.
       Any call site that still wants the raw response can call `.json()` on
       one paren, which this does not match. */
    const hits = (text.match(/\)\)\.json\(\)/g) || []).length;
    if (hits) offenders.push(`${file}: ${hits}`);
  }
  check('nothing calls .json() on something a helper already parsed',
    offenders.length === 0, offenders.join('; '));
}

/* ============================== the Studio's prompt, around a picture asked for in chat

   The prompt box is four boxes: quality tags in front, the artists, the
   subject, the modifiers behind. A picture asked for in conversation was
   getting only the middle one, so the same request made in the two places came
   out looking like two different installs. */

{
  const app2 = read('src/App.jsx');
  check('the Studio hands over the three boxes that are not the subject',
    /parts: \{\s*lead:/.test(app2) && /artist: \(form\.artist \|\| ''\)\.trim\(\)/.test(app2)
    && /tail: \(form\.tail \|\| ''\)\.trim\(\)/.test(app2));
  /* Assembled by the same function the Studio's own button uses. A second way
     of joining them would drift from the one people are tuning. */
  check('  and they are joined the way the Studio joins them',
    /joinPrompt\(\{ lead: parts\.lead, artist: parts\.artist, prompt, tail: parts\.tail \}/.test(app2));
  check('  which has to be imported, or it throws where nothing checks',
    /import \{ joinPrompt \} from '\.\/promptTags\.js';/.test(app2));
  /* The artists go into the prompt always -- see "the order the boxes come out
     in" below -- and additionally to Anima's own encoder, which is what
     `hasArtistInput` is for. They used to go to one or the other, so on Anima
     the prompt never said who the picture was drawn like. */
  check('  with the artists in the prompt and also at the encoder',
    /foldArtist: true,/.test(app2)
    && /parts\.hasArtistInput && parts\.artist \? \{ artist: parts\.artist \}/.test(app2));
}

/* ================================================ sending a picture from a phone

   `navigator.share` needs a secure context. This app is reached from a phone
   over plain HTTP, so the sheet never opened and the fallback was a link --
   which arrives in KakaoTalk as a line of text rather than as the picture. */

{
  const shareSrc = read('src/share.js');
  const app2 = read('src/App.jsx');
  check('the two reasons there is no sheet are told apart',
    /export const whyNoSheet/.test(shareSrc) && /'insecure'/.test(shareSrc));
  check('  and an insecure origin saves the file rather than offering a link',
    /if \(whyNoSheet\(\) === 'insecure'\) \{[\s\S]{0,120}downloadPicture\(picture\)/.test(app2));
  /* A film is the thing that takes longest to make, and was the one thing that
     could not be sent to anybody. */
  check('a film can be sent too', !/\{!picture\.video && \([\s\S]{0,200}picture\.share/.test(app2));
  check('and a file is typed by its bytes, not by its name',
    /blob\.type \|\| guessType\(filename\)/.test(shareSrc));
}

/* ---------------------------------------- a pasted link brings tags, not artists

   The artist box is a standing choice: the style this install draws in, set
   once and left. A pasted reference is about the subject of one picture, and
   filling that box from it overwrote the choice silently, every time. */
{
  const panel = read('src/StudioPanel.jsx');
  check('pasting a link writes only the prompt',
    /setForm\(f => \(\{\s*\.\.\.f,\s*prompt: replace \? String\(data\.prompt \|\| ''\) : add\(base\(f\.prompt\), data\.prompt\),\s*\}\)\);/.test(panel));
  check('  and never touches the artist box',
    !/artist: replace \? data\.artists/.test(panel) && !/artist: add\(f\.artist, data\.artists\)/.test(panel));
}

/* ------------------------------------------- the veil is a tint, not a wall

   Measured on a covered picture: `elementFromPoint` at the centre of the
   viewer's next arrow returned `div.safe-veil`, pressing it left the counter
   at "1 / 2", and the arrow *key* moved to "2 / 2". Same in the transcript,
   where the veil sat over the button that opens the viewer -- so a covered
   picture could not be enlarged by pressing it.

   The veil is `inset: 0; z-index: 2` in the same stacking context as those
   controls, which have none. It carries exactly one control of its own. */
{
  const veilCss = read('src/safeguard.css');
  const studioCss2 = read('src/studio.css');
  check('presses go through the veil to whatever it covers',
    /\.safe-veil:not\(\.is-compact\) \{ pointer-events: none; \}/.test(veilCss));
  check('  except the one control it carries',
    /\.safe-veil:not\(\.is-compact\) \.safe-veil-show \{ pointer-events: auto; \}/.test(veilCss));
  /* At 56 pixels there is no room for a pill, so the whole overlay is the
     button -- and it must keep taking presses. */
  check('  while the compact veil, which is itself the button, keeps them',
    !/\.safe-veil \{[^}]*pointer-events: none/.test(veilCss));
  check('and the viewer\'s arrows sit above it rather than under a tint',
    /\.studio-lightbox-nav \{[\s\S]{0,240}z-index: 3;/.test(studioCss2));
}

/* ===================================== the Studio's boxes, around a chat picture

   The prompt box is four boxes: quality tags in front, the artists, the
   subject, the modifiers behind. Only the subject is written fresh for each
   picture; the other three are typed once and left, and they are positional --
   "masterpiece, best quality" in front is the entire reason a lead box exists.

   Two things had to be true for those boxes to reach a picture asked for in
   conversation, and each was separately broken.

   The browser has to send them. Measured, with the boxes filled in and the
   redraw button pressed, the request now carries:

       prompt : masterpiece, best quality, 1girl, standing, outdoors, depth of field, film grain
       artist : (@wlop:1.2)
       lead   : masterpiece, best quality
       tail   : depth of field, film grain
       subject: 1girl, standing, outdoors

   And the server must not take them apart again. A prompt from a conversation
   is prose, so for Anima it is reshaped into tags and a sentence -- and
   reshaping the *joined* string produced

       1girl, standing, outdoors, depth of field, film grain, masterpiece, best quality.

   with the lead at the end, as prose. The boxes reached the graph and did
   nothing anybody could see, which is exactly how it was reported. */

{
  const app = read('src/App.jsx');
  check('the browser sends the boxes as well as the joined prompt',
    /\.\.\.\(parts && parts\.lead \? \{ lead: parts\.lead \} : \{\}\),/.test(app)
    && /\.\.\.\(parts && parts\.tail \? \{ tail: parts\.tail \} : \{\}\),/.test(app)
    && /\.\.\.\(parts \? \{ subject: prompt \} : \{\}\),/.test(app));

  const studioSrc = read('server/studio.js');
  check('and the server reshapes the subject, not the whole of it',
    /shaped = shapeAnimaPrompt\(subject, index\);/.test(studioSrc)
    && /const subject = typeof job\.subject === 'string' \? job\.subject : job\.prompt;/.test(studioSrc));
  check('  putting the boxes back around it',
    /job\.prompt = framedAnimaPrompt\(\{[\s\S]{0,160}lead: job\.lead, artist: job\.artist, tail: job\.tail, shaped,/.test(studioSrc));
  /* The Studio's own prompt is still never reshaped: somebody writing tags on
     purpose, with autocomplete, should not have them rearranged. That is the
     same argument, and it is why the boxes are exempt wherever they are used. */
  check('  and only when the caller asked for shaping',
    /if \(job\.shapeTags && definition\.id === 'anima-base'\)/.test(studioSrc));
}

{
  const A = await import(pathToFileURL(path.join(ROOT_, 'server/animaPrompt.js')).href);
  const shaped = { tags: ['1girl', 'standing', 'outdoors'], sentence: '' };

  eq('the lead leads and the tail trails',
    A.framedAnimaPrompt({ lead: 'masterpiece, best quality', tail: 'depth of field, film grain', shaped }),
    'masterpiece, best quality, 1girl, standing, outdoors, depth of field, film grain');

  eq('with no boxes it is only the subject',
    A.framedAnimaPrompt({ shaped }), '1girl, standing, outdoors');

  /* The model's prose is part of the subject, so it sits with the subject --
     before the tail, which goes last. See "the order the boxes come out in". */
  eq('and a sentence comes after the tags, terminated, before the tail',
    A.framedAnimaPrompt({ lead: 'masterpiece', tail: 'film grain', shaped: { tags: ['1girl'], sentence: 'on a rooftop at sunset' } }),
    'masterpiece, 1girl, on a rooftop at sunset., film grain');
  eq('  and is not terminated twice',
    A.framedAnimaPrompt({ shaped: { tags: [], sentence: 'already done.' } }), 'already done.');

  // Nothing in, nothing out -- these come off a form that may be empty.
  eq('an empty everything is an empty prompt', A.framedAnimaPrompt({}), '');
  eq('and stray commas are not a box', A.framedAnimaPrompt({ lead: ' , ', shaped }), '1girl, standing, outdoors');
}

/* ----------------------------------------- the lead that came back five long

   Reported with the exact strings, which is what made this findable. Typed:

     newest, year 2024, year 2025, safe, (best quality), score_8, highres,
     absurdres, anime coloring, flat color, minimalist vector illustration,
     clean lines, pastel colors

   and what reached the picture began:

     highres, absurdres, anime coloring, flat color, pastel colors

   Five of thirteen. The five are exactly the ones that are danbooru tags. The
   other eight were not dropped -- they were swept to the very end of the
   prompt as a "sentence", where a positional model does nothing with them, so
   from the front the lead had lost more than half of itself.

   None of these is a tag the shaping could know: `newest`, `year 2024` and
   `safe` are danbooru *search* syntax rather than tags, `score_8` is a
   pony-family convention, `(best quality)` carries weighting brackets, and
   `minimalist vector illustration` and `clean lines` are simply English. All
   of them are things a person types into a lead box on purpose, which is the
   whole argument for not reshaping that box. */

{
  const A = await import(pathToFileURL(path.join(ROOT_, 'server/animaPrompt.js')).href);
  const B = await import(pathToFileURL(path.join(ROOT_, 'server/booruTags.js')).href);
  const index = B.loadTags();

  const LEAD = 'newest, year 2024, year 2025, safe, (best quality), score_8, highres, absurdres, '
    + 'anime coloring, flat color, minimalist vector illustration, clean lines, pastel colors';
  const entries = LEAD.split(',').map(s => s.trim());

  if (!index.size) {
    check('the tag index is there to test against', false, 'no tags loaded');
  } else {
    const shaped = A.shapeAnimaPrompt('1girl, standing, outdoors', index);
    const out = A.framedAnimaPrompt({ lead: LEAD, tail: 'depth of field', shaped });

    check('every entry of the lead survives', entries.every(e => out.includes(e)),
      entries.filter(e => !out.includes(e)).join(' | '));
    check('  in the order they were typed',
      out.indexOf('newest') < out.indexOf('score_8')
      && out.indexOf('score_8') < out.indexOf('pastel colors'));
    check('  in front of the subject',
      out.indexOf('pastel colors') < out.indexOf('1girl'));
    check('  with the weighting brackets intact', out.includes('(best quality)'));
    check('and the tail is still last', out.trim().endsWith('depth of field'));

    /* And the shape of the fault itself, so a change that reintroduces it is
       caught rather than merely different: reshaping the joined string puts
       some of the thirteen at the front and the rest at the end. Which ones
       depends on the tag file: with every category 0 it was the five danbooru
       tags; once the update filled categories in, `highres` and `absurdres`
       are meta and go to the end too. Either way the lead is split, and the
       order it was typed in is gone. */
    const joined = `${LEAD}, 1girl, standing, outdoors, depth of field`;
    const whole = A.shapeAnimaPrompt(joined, index);
    const kept = entries.filter(e => whole.tags.some(t => t.toLowerCase() === e.toLowerCase()));
    check('reshaping the whole string is still what it was -- and still wrong for a lead',
      kept.length > 0 && kept.length < entries.length && !whole.prompt.startsWith(entries[0]),
      `${kept.length}/${entries.length} survived as tags`);
  }
}

/* ------------------------------------------- and the order the boxes come out in

   `lead, artist, subject, tail` -- the order `joinPrompt` uses in the Studio,
   and the order these prompts are read in.

   The tail is last, and that is the part worth checking rather than assuming.
   It was put with the subject's tags for a while, on the reasoning that both
   are tags: true, and it meant that the moment a subject had any prose in it --
   which is most of them, since a model writes the subject -- the sentence was
   pushed out behind the tail and the tail was in the middle. A box whose whole
   purpose is to go last has one job.

   The artist is in the prompt at all, which it was not. Anima has an encoder
   of its own and the names were sent only there, so the prompt recorded beside
   a picture never said who it was drawn like. It still goes to that encoder as
   well -- measured against the real graph, `Simple Text ED.text` carries it
   while `Efficient Loader ED.positive` now names it too. */

{
  const A = await import(pathToFileURL(path.join(ROOT_, 'server/animaPrompt.js')).href);

  const boxes = {
    lead: 'masterpiece, best quality',
    artist: '(@wlop:1.2)',
    tail: 'depth of field, film grain',
  };

  // A subject of pure tags: nothing left over, so no sentence.
  eq('tags only, in order',
    A.framedAnimaPrompt({ ...boxes, shaped: { tags: ['1girl', 'standing'], sentence: '' } }),
    'masterpiece, best quality, (@wlop:1.2), 1girl, standing, depth of field, film grain');

  // A subject with prose in it -- the case that put the tail in the middle.
  const withProse = A.framedAnimaPrompt({
    ...boxes, shaped: { tags: ['1girl'], sentence: 'on a rooftop at sunset' },
  });
  eq('and with prose in the subject, the prose is still before the tail',
    withProse,
    'masterpiece, best quality, (@wlop:1.2), 1girl, on a rooftop at sunset., depth of field, film grain');
  check('  so the tail is genuinely last', withProse.trimEnd().endsWith('film grain'));

  check('the artist is in the prompt', withProse.includes('(@wlop:1.2)'));
  check('  after the lead and before the subject',
    withProse.indexOf('(@wlop') > withProse.indexOf('best quality')
    && withProse.indexOf('(@wlop') < withProse.indexOf('1girl'));

  // Each box is optional; a form may have any of them empty.
  eq('a missing artist leaves no gap',
    A.framedAnimaPrompt({ lead: 'a', tail: 'z', shaped: { tags: ['b'], sentence: '' } }), 'a, b, z');
  eq('and a missing tail leaves none either',
    A.framedAnimaPrompt({ lead: 'a', artist: 'x', shaped: { tags: ['b'], sentence: '' } }), 'a, x, b');
}

{
  /* The artists reach the prompt from both places that build one, so the two
     agree -- the whole reason the boxes were wired through in the first place
     was that the same request made in the two places produced different
     pictures. */
  const panel = read('src/StudioPanel.jsx');
  const app = read('src/App.jsx');
  const studioSrc = read('server/studio.js');
  check('the Studio folds the artists into its prompt',
    /const foldArtist = true;/.test(panel));
  check('and the chat does too', /foldArtist: true,/.test(app));
  check('  while still sending them to the encoder that wants them',
    /parts\.hasArtistInput && parts\.artist \? \{ artist: parts\.artist \}/.test(app));
  check('and the server puts them in the rebuilt prompt',
    /lead: job\.lead, artist: job\.artist, tail: job\.tail, shaped,/.test(studioSrc));
}

/* ============================================ the header, when it grows a row

   Measured at 390x844: opening the in-chat search grows `.header-tools` from
   40px to 94px -- the field wraps onto a second line, as it is meant to --
   while `.main-header` stayed exactly 56px. The second line was therefore
   *outside* the header, lying over the top of the conversation.

   The header is told its height twice: a media query that lets it grow, and an
   unconditional `height: 56px` further down the file. Equal specificity, later
   wins, and the media query had been dead. */
{
  const late = extras.lastIndexOf('the header, when it has two rows');
  /* The unconditional rule, found by its own opening rather than by the
     declaration -- `min-height: 56px` contains `height: 56px` and the phone
     block below sets one. */
  const fixed = extras.indexOf('.main-header {' + String.fromCharCode(10) + '  background: var(--surface);');
  check('the header may grow a second row on a phone', late > 0);
  check('  and says so after the rule that fixes its height', fixed > 0 && late > fixed, `${late} vs ${fixed}`);
}

/* ============================================== lifting the shadows out of one

   There is no shadow-removal node in this ComfyUI. Of everything named for one,
   `LayerStyle: DropShadow` adds one, `LayerMask: Shadow & Highlight Mask` only
   says where they are, and `MagnificImageRelight` is a paid partner API. What
   is left is the colour node, which raises the shaded areas and drains the cast
   out of them -- on flat and anime-coloured work that is removing the shade;
   on a photograph it lightens it, because what a real shadow covers was never
   drawn. */
{
  const ops = read('server/imageOps.js');
  check('the shadow lift uses the node that exists',
    /LayerColor: ColorofShadowHighlightV2/.test(ops));
  check('  and names the pack when it does not',
    /return \{ missing: \['LayerColor: Color of Shadow & Highlight'\] \}/.test(ops));
  /* Deterministic: no sampler, no model, no queue behind a generation. That is
     the same bargain as taking a background out, which is why it sits beside
     it rather than being another redraw. */
  check('  without sampling anything', !/KSampler|denoise/.test(
    ops.slice(ops.indexOf('removeShadowGraph'), ops.indexOf('upscaleGraph'))));
  check('  and the lit half is left alone',
    /highlight_brightness: 1,/.test(ops));

  const app2 = read('src/App.jsx');
  check('it is a button under a picture', /pictureAction\('deshadow'/.test(app2));
  check('and a tool the model can call', /name: 'TOOL_REMOVE_SHADOW'/.test(app2));
}

/* ====================================== drawing without the Studio's own boxes

   The lead, the artists and the tail are what this install puts on everything,
   and inheriting them is the point. Sometimes the request is the exception --
   "그 태그들 다 빼고 그냥 그려줘" -- so the model can turn them off for one
   picture, and is told not to do it on its own judgement. */
{
  const app2 = read('src/App.jsx');
  const toolsSrc = read('src/tools.js');
  check('one picture can go without them',
    /const parts = opts\.plain \? null : saved;/.test(app2));
  check('  asked for by the request, not decided here',
    /const plain = String\(attrs\.studio_prompt \|\| ''\)\.toLowerCase\(\) === 'off';/.test(app2));
  // The sentence is split across two source lines, so only its start is matched.
  check('  and the model is told never to decide it alone',
    /Never off on your/.test(toolsSrc));
}

/* ============================================ a PDF opens as the PDF it is

   What the model is given is the text, because text is what it can read. What a
   person opening the attachment wants is the document -- the layout, the
   tables, the pages -- and they were being shown the text.

   The bytes deliberately do not go into the message: a chat carrying a ten
   megabyte PDF as base64 is the weight problem pictures already had, and it
   would sit in storage and in the sync for ever. They are held for as long as
   the tab is open, and after a reload the text is what is left -- which is what
   was shown before this existed. */
{
  const app2 = read('src/App.jsx');
  check('the original is kept out of the message',
    /const originals = useRef\(new Map\(\)\);/.test(app2));
  /* A PDF, and only a PDF. A .json handed to the browser's reader came back as
     white text on the white this stylesheet forces under the frame -- a blank
     rectangle -- and a .json *is* its text, which the viewer below already
     shows in this app's own colours. See `readableAsDocument`. */
  check('  and the viewer shows it while it is there',
    /originalOf\(viewingAttachment\) && readableAsDocument\(viewingAttachment\) \? \(/.test(app2)
    && /className="attachment-viewer-doc"/.test(app2));
  check('  in the browser\'s own reader, since there is no reader here',
    /<iframe/.test(app2.slice(app2.indexOf('attachment-viewer-doc') - 400)));
  /* A blob URL means nothing to another tab, so one written into a message
     would be a dead string. The map is revoked when the tab goes. */
  check('  and the URLs are given back', /URL\.revokeObjectURL/.test(app2));

  /* And it survives being sent, which it did not.
   *
   * In the composer a document is `type: 'text'`; the message folds it into the
   * text and the transcript reads it back out as `type: 'file'` (or `indexed`,
   * for one too long to send whole) -- so a key made of name *and* type missed
   * every time from the moment the message left the composer. The PDF opened as
   * a PDF before sending and as its own extracted text afterwards. */
  check('the original is found by name, which does not change when it is sent',
    /const keyOfAttachment = \(att\) => String\(att\?\.name \|\| ''\)\.trim\(\);/.test(app2));
  {
    const marks = read('src/attachMarkers.js');
    const composer = /type: 'text', data: text/.test(app2);
    const sent = /type: 'file', name: m\[1\]/.test(marks);
    check('  because the composer and the transcript call it different things',
      composer && sent, `composer ${composer}, sent ${sent}`);
  }
  /* A document long enough to be indexed is the one whose extracted text is
     least like the document, and it was the one kind that kept nothing. */
  check('  and a file that went to the library keeps its original too',
    /keepOriginal\(\{ name: bigFile\.name \}, bigFile\);/.test(app2));

  /* The round trip itself, run rather than read: the attachment as the composer
     makes it, through the message text, back out as the transcript sees it. The
     two objects have to land on the same key or the document is lost at exactly
     the moment the message is sent -- which is the bug. */
  {
    const AM = await import(pathToFileURL(path.resolve(HERE, '../src/attachMarkers.js')).href);
    const key = (att) => String(att?.name || '').trim();
    const composed = { name: 'report.pdf', type: 'text', data: 'page one', truncated: false };
    const message = `이 문서 요약해줘${AM.fileMarker(composed.name, composed.data)}`;
    const [recovered] = AM.extractAttachments(message).attachments;
    check('an attachment keeps its identity across being sent',
      !!recovered && key(recovered) === key(composed), JSON.stringify(recovered));
    check('  which the old key did not', `${composed.name}:${composed.type}` !== `${recovered.name}:${recovered.type}`);
  }
}

/* ===================================== stopping means stopping the whole turn

   A turn that calls a tool carries on in a *new* `handleSend`, which makes an
   AbortController of its own -- so the signal cancelled a moment earlier was
   not the one the next leg ran with, and stopping a picture stopped only the
   picture while the model went on to talk about it. */
{
  const app2 = read('src/App.jsx');
  const guards = (app2.match(/if \(signal\.aborted\) \{/g) || []).length;
  check('a stopped turn does not schedule another leg', guards >= 2, `${guards}`);
  check('  and stops running the calls it had left',
    /Nothing more after a stop[\s\S]{0,200}if \(signal\.aborted\) break;/.test(app2));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
