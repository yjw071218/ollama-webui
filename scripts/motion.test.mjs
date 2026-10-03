// How the app moves, and the two rules about it that are not taste.
//
// The first is that there is one system. Two panels that open at different
// speeds read as two apps, and the way that happens is not carelessness — it
// is a second set of tokens arriving beside the first. This file had one:
// `--fast`/`--base`/`--slow` alongside the app's own `--dur-fast`/`--dur`/
// `--dur-slow`, and, because it loads last, its `--ease-out` silently replaced
// the curve under every existing rule. So the check is not "are there tokens"
// but "is there one of each".
//
// The second is reduced motion, and the app's answer to it is better than the
// obvious one: the *travel* goes to zero while the durations merely shorten,
// so an interface still fades between its states rather than hard-cutting.
// Turning everything off outright reads as "this app has no animation" rather
// than "this app is being considerate" — and a reader who wants it back can
// say so with `data-motion="full"`. A blanket `!important` kill breaks both.
//
// And the ripple on the safeguard's glass is checked for what it must *not*
// do: a hover is not somebody asking to see a covered picture.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const sheets = ['src/index.css', 'src/extras.css', 'src/studio.css', 'src/safeguard.css', 'src/motion.css', 'src/App.css'];
const css = Object.fromEntries(sheets.map(f => [f, read(f)]));
const all = Object.values(css).join('\n');

/* ------------------------------------------------------------ one system */

for (const token of ['--ease-out', '--ease-in-out', '--dur-fast', '--dur', '--dur-slow',
  '--ease-spring', '--ease-glass', '--dur-slower']) {
  const defined = sheets.filter(f => new RegExp(`^\\s*${token}:`, 'm').test(css[f]));
  check(`${token} is defined exactly once, in one place`, defined.length === 1, defined.join(', '));
}

/* The tokens the whole thing turns on. `--motion-shift` and friends are what
   let reduced motion remove the travel without removing the transition. */
for (const token of ['--motion-shift', '--motion-scale', '--press-scale']) {
  check(`${token} exists, so travel can be zeroed apart from time`,
    new RegExp(`^\\s*${token}:`, 'm').test(all));
}

// And nothing invents a duration of its own beside them.
const strays = [...all.matchAll(/transition:[^;]*?(\d{2,4})ms/g)].map(m => m[1]);
check('durations come from the tokens rather than being typed in',
  strays.length <= 6, `${strays.length} literal durations: ${[...new Set(strays)].join(', ')}`);

/* ------------------------------------------- the rule that is not taste */

const motion = css['src/motion.css'];
const extras = css['src/extras.css'];

check('reduced motion is answered', /@media \(prefers-reduced-motion: reduce\)/.test(extras));
check('  by zeroing the travel', /--motion-shift: 0px/.test(extras) && /--motion-scale: 1/.test(extras));
check('  while the durations only shorten, so states still fade between',
  /--dur-fast: 90ms/.test(extras) && !/--dur-fast: 0/.test(extras));
check('  and a reader can ask for it back', /data-motion="full"/.test(extras));

/* The blanket kill this file used to carry. It overrode the considered
   behaviour above for every element in the app, `data-motion="full"`
   included, because `!important` on `*` cannot be opted out of. */
check('nothing switches the whole app off with one !important rule',
  !/\*[\s\S]{0,80}animation-duration:\s*0[\s.]?\d*m?s\s*!important/.test(all),
  'a global animation kill is back');
check('and what this file adds follows the same rule',
  /--ease-spring: var\(--ease-out\)/.test(motion) && /--dur-slower: 200ms/.test(motion));

/* ------------------------------------------- a hand on the glass

   Frosted glass is a surface, and a surface answers being touched. What it
   must not do is answer by showing what is under it. */

const safeguard = css['src/safeguard.css'];
check('the glass ripples where the pointer is', /@keyframes safe-ripple/.test(safeguard));
check('  from the pointer, not the middle',
  /\.safe-ring\s*\{[\s\S]*?left: var\(--rx\)[\s\S]*?top: var\(--ry\)/.test(safeguard));
check('  thinning as it travels, the way a wave loses height',
  /@keyframes safe-ripple[\s\S]*?border-width: 0\.5px/.test(safeguard));
check('  only while a pointer is actually on it',
  /\.safe-frame\.is-veiled\.is-rippling \.safe-ripples/.test(safeguard)
  && !/\.safe-frame\.is-veiled:hover \.safe-ripples/.test(safeguard));
check('  and on touch, gone the moment the finger lifts',
  /onPointerUp=\{veiled \? lift/.test(read('src/SafeImage.jsx'))
  && /\.safe-ring \{ animation-play-state: paused; \}/.test(safeguard));
check('  nor when motion has been asked to stop',
  /prefers-reduced-motion[\s\S]*?\.safe-ring\s*\{\s*display: none/.test(safeguard));
check('the ripple never touches the blur that covers the picture',
  !/\.safe-ripple[\s\S]*?filter:\s*blur\(0/.test(safeguard)
  && !/\.safe-ring[\s\S]*?backdrop-filter/.test(safeguard));
check('and it is not a target, so it cannot be pressed by accident',
  /\.safe-ripples\s*\{[\s\S]*?pointer-events: none/.test(safeguard));
check('it is under the veil that explains the cover, not over it',
  /\.safe-ripples\s*\{[\s\S]*?z-index: 1/.test(safeguard) && /\.safe-veil\s*\{[\s\S]*?z-index: 2/.test(safeguard));

const safeImage = read('src/SafeImage.jsx');
check('the pointer position is written onto the node, not into state',
  /node\.style\.setProperty\('--rx'/.test(safeImage) && /node\.style\.setProperty\('--ry'/.test(safeImage));
check('  only while there is glass to ripple',
  /onPointerMove=\{veiled \? follow : undefined\}/.test(safeImage));
check('and a thumbnail too small for rings does not get them',
  /\{veiled && !compact && \(/.test(safeImage));

/* ------------------------------------------------------ what it is used on */

check('a picture fades in rather than cutting in',
  /\.picture-gallery-item img[\s\S]*?animation: fade-in/.test(motion));
check('a button gives a little when pressed, by the distance the app already had',
  /:active:not\(:disabled\)[\s\S]*?var\(--press-scale/.test(motion));
check('the viewer opens over what was there rather than replacing it',
  /@keyframes studio-lightbox-rise/.test(css['src/studio.css']));
check('  but does not re-open on every arrow press',
  /\.studio-lightbox\.is-walking[\s\S]*?animation: fade-in/.test(css['src/studio.css']));

/* ------------------------------------------------- what answers an action

   Motion that answers a person's action is the kind worth having: it shows
   what changed. A disclosure that snaps open shows nothing. */

check('opening a disclosure is something you can watch happen',
  /@keyframes studio-group-open/.test(css['src/studio.css']));

/* ============================================ elevation, radius, and pressing

   Three systems that are invisible when they are right and read as "several
   apps in a trenchcoat" when they are not. Each had tokens *and* a pile of
   one-offs beside them, which is the worst of both: the tokens look like a
   system to whoever reads the file next, and the values on screen do not
   agree with each other. */

{
  const extras = css['src/extras.css'];
  const index = css['src/index.css'];

  /* Three rungs, and a menu, a popover and a toast are all one of them. Six
     anchored, floating things had grown up at four different heights. */
  for (const rung of ['--shadow-raised', '--shadow-lifted', '--shadow-overlay']) {
    check(`${rung} is a rung of one scale`, new RegExp(`^\\s*${rung}:`, 'm').test(extras));
  }
  const menus = ['.cmd-palette', '.slash-menu', '.regen-menu', '.toast', '.popover', '.auth-card'];
  const offScale = menus.filter((sel) => {
    const rule = new RegExp(`\\${sel}\\s*\\{[^}]*box-shadow:([^;]*);`).exec(extras);
    return rule && !/var\(--shadow-/.test(rule[1]);
  });
  check('everything that floats takes its height from the scale', offScale.length === 0, offScale.join(', '));

  /* Tinted with the ink colour rather than black: on a paper-white ground a
     neutral black shadow is grey, and grey on cream reads as dirt. */
  check('and the light theme\'s shadows are the page\'s own dark, not black',
    /--shadow-overlay: [^;]*rgba\(31, 31, 29/.test(extras)
    && /--shadow-lifted: [^;]*rgba\(31, 31, 29/.test(extras));

  /* A radius is read as a proportion of the edge it sits on, so a 20-pixel
     button and a 600-pixel panel curved alike look unrelated. Eleven raw
     values had grown up under the three tokens. */
  for (const step of ['--radius-lg', '--radius-md', '--radius-sm', '--radius-xs', '--radius-pill']) {
    check(`${step} is on the scale`, new RegExp(`^\\s*${step}:`, 'm').test(index));
  }
  const radii = [...index.matchAll(/--radius-(lg|md|sm|xs):\s*(\d+)px/g)].map(m => Number(m[2]));
  check('the scale climbs, so the step means something',
    radii.length === 4 && [...radii].sort((a, b) => b - a).join() === radii.join(), JSON.stringify(radii));

  /* And the one gesture a switch has. It had no answer at all: press, and
     nothing happened until the finger came off. */
  check('a switch answers being held down', /\.switch:active:not\(:disabled\) \.switch-knob/.test(extras));
  check('  and stops stretching for a reader who asked for less movement',
    /data-motion="reduced"\] \.switch:active[\s\S]{0,120}width: 14px/.test(extras));
}

/* -------------------------------------------------- the footer, laid out

   The Studio's action row is seed, batch, button -- and the sweep arrived as a
   fourth item in a three-column grid, with a visible text label where its
   neighbours deliberately have none. It wrapped, it pushed the button out of
   place, and it read as a form field that had wandered into a toolbar.

   It is not a fourth control. It changes what the third one *means*: x6 is six
   seeds, x6 along Steps is six values of one setting. So the two are one
   control in two parts, and the grid's middle column sizes to whichever of
   them a workflow has. */

{
  const panel = read('src/StudioPanel.jsx');
  const studio = css['src/studio.css'];

  check('the count and the axis are one control, not two',
    /<div className=\{`studio-batch \$\{sweepAxis \? 'is-sweeping' : ''\}`\}>/.test(panel));
  check('  the axis is inside it', /studio-batch-axis/.test(panel));
  check('  and it is label-free, like the seed beside it',
    !/studio-batch[\s\S]{0,900}<span>\{t\('sweep\.title'\)\}<\/span>/.test(panel));
  check('  while still being named for a screen reader',
    /aria-label=\{t\('sweep\.title'\)\}/.test(panel));

  check('the middle column sizes to what is in it',
    /\.studio-footer \{ grid-template-columns: 150px auto minmax\(0, 1fr\); \}/.test(studio));
  check('the two share an edge, so they read as one',
    /:has\(\.studio-batch-axis\) \.studio-batch-count[\s\S]{0,160}border-inline-end: 0/.test(studio));

  /* `.studio-form .settings-input` sets `width: 100%` at two classes. A
     one-class rule loses to it wherever it sits in the file, which is how a
     64-pixel control ends up as wide as the row. */
  check('and the widths are scoped high enough to win',
    /\.studio-batch \.studio-batch-count \{ width: 64px/.test(studio)
    && !/^\.studio-batch-count \{/m.test(studio)
    && !/^\.studio-batch-axis \{/m.test(studio));

  /* A narrow panel cannot hold three things and a button on one line. The
     breakpoint moved from 560 to 640 and the rule moved to the end of the
     file, because a `max-width: 939px` rule between them was quietly
     winning -- see "the footer, on a phone" in studio.css. */
  check('on a narrow panel the button takes a line of its own',
    /@media \(max-width: 640px\)[\s\S]{0,900}\.studio-go \{ grid-column: 1 \/ -1; \}/.test(studio));
}

/* ---------------------------------------------------------- the floor */

// A keyboard user has to be able to see where they are. index.css styles the
// app's own buttons and inputs and had no focus rule at all.
check('every focusable thing shows a focus ring',
  /:focus-visible/.test(css['src/index.css']));
check('  drawn in the accent, so it is visible on both themes',
  /:focus-visible[\s\S]{0,200}var\(--btn-active\)/.test(css['src/index.css']));

// `transition: all` animates layout properties nobody meant to animate.
const alls = sheets.filter(f => /transition:\s*all\b/.test(css[f]));
check('nothing transitions `all`, which animates properties nobody chose',
  alls.length === 0, alls.join(', '));

// The stylesheet has to be loaded, or none of the above is true of the app.
check('and the whole thing is actually loaded', /import '\.\/motion\.css'/.test(read('src/main.jsx')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
