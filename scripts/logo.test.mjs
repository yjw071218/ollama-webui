// One mark, written down three times.
//
// A browser tab cannot import a React component and neither can a home screen,
// so the geometry lives in `public/favicon.svg`, `public/icon-maskable.svg`
// and `src/Logo.jsx`. Three copies drift, and a mark that differs between the
// tab and the sidebar is not a mark — so the agreement is checked here rather
// than remembered.
//
// The rest is what "clean" has to mean concretely, because it is otherwise an
// opinion. The thing this replaced was a 9 KB lightning bolt built from fifteen
// ellipses behind a mask, each with its own Gaussian blur, painted #863bff — a
// purple that appeared nowhere else in the app. At 16px it was a smudge, and it
// did not match the product it stood for.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* What actually renders.
 *
 * The comments inside these files explain what they replaced, and that
 * explanation names the old purple and the word "blur". A scan that read
 * comments would report the explanation as a recurrence, which is a check
 * that punishes writing one. */
const rendered = (svg) => svg.replace(/<!--[\s\S]*?-->/g, '');

const favicon = rendered(read('public/favicon.svg'));
const maskable = rendered(read('public/icon-maskable.svg'));
const component = rendered(read('src/Logo.jsx')).replace(/\/\*[\s\S]*?\*\//g, '');
const css = read('src/index.css') + read('src/extras.css');

/* --------------------------------------------------------- it is valid XML

   An SVG that does not parse is a broken-image placeholder, and nothing
   about the file looks wrong while reading it. That is how it happened here:
   two hyphens inside an XML comment, which is illegal, in a comment
   explaining what the mark before this one had been. The build succeeded,
   every other check passed, and every icon on the page rendered as a broken
   image. */

for (const [name, file] of [
  ['favicon', 'public/favicon.svg'],
  ['home-screen icon', 'public/icon-maskable.svg'],
]) {
  const raw = read(file);
  const comments = [...raw.matchAll(/<!--([\s\S]*?)-->/g)];
  check(`the ${name} has no double hyphen inside a comment`,
    comments.every(m => !m[1].includes('--')), file);
  check(`the ${name} closes the tag it opens`,
    (raw.match(/<svg/g) || []).length === (raw.match(/<\/svg>/g) || []).length);

  // The real check: hand it to something that actually parses XML.
  const balanced = (() => {
    const tags = [...raw.matchAll(/<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g)];
    const stack = [];
    for (const [, closing, tag, selfClosing] of tags) {
      if (selfClosing) continue;
      if (closing) { if (stack.pop() !== tag) return false; } else stack.push(tag);
    }
    return stack.length === 0;
  })();
  check(`the ${name} is well-formed`, balanced, file);
}

/* -------------------------------------------------------------- it is small */

// Not a size limit for its own sake: everything that made the old one 9 KB —
// the blurs, the mask, the fifteen ellipses — is also what made it illegible
// at the size it is actually used.
check('the favicon is small', favicon.length < 1500, `${favicon.length} bytes`);
check('and the home-screen icon too', maskable.length < 1500, `${maskable.length} bytes`);

for (const [name, svg] of [['favicon', favicon], ['maskable icon', maskable]]) {
  check(`the ${name} has no blur`, !/feGaussianBlur|filter=/.test(svg));
  check(`the ${name} has no gradient`, !/linearGradient|radialGradient/.test(svg));
  check(`the ${name} has no mask`, !/<mask|mask=/.test(svg));
  check(`the ${name} is opaque`, !/opacity="0?\.\d/.test(svg));
}

/* ------------------------------------------------ it is the product's colour */

// The old mark was #863bff. The app's accent is #D97757, defined in extras.css
// and used everywhere else. An icon in a colour the interface never uses reads
// as somebody else's icon.
const ACCENT = '#D97757';
check('the accent is what the app actually uses', css.includes('--primary: #D97757;'));
check('the favicon is painted in it', favicon.includes(ACCENT));
check('so is the home-screen icon', maskable.includes(ACCENT));
check('and the old purple is gone', !favicon.includes('863bff') && !maskable.includes('863bff'));
check('the in-app mark takes its colour from the square it sits in',
  component.includes('fill="currentColor"'));
check('and that square is the accent', css.includes('.claude-logo-icon') && /\.claude-logo-icon\s*\{[^}]*background:\s*var\(--primary\)/s.test(css));

/* ------------------------------------------------------- the three copies agree */

// Two arcs and a dot. The arcs carry their radius in the path, so the whole
// geometry can be read back out of any of the three files and compared.
const arcsOf = (text) => [...text.matchAll(/<path d="([^"]+)"\s+stroke-?[Ww]idth=[{"]([\d.]+)[}"]/g)]
  .map(m => ({ d: m[1], w: Number(m[2]), r: Number((m[1].match(/A([\d.]+) /) || [])[1]) }));
const dotOf = (text) => {
  const m = text.match(/<circle[^/]*?r=[{"]([\d.]+)[}"][^/]*?fill/);
  return m ? Number(m[1]) : 0;
};

const faviconArcs = arcsOf(favicon);
const faviconDot = dotOf(favicon);
eq('the favicon draws two arcs', faviconArcs.length, 2);
check('and a centre dot', faviconDot > 0, String(faviconDot));

// The grading is the point. Concentric rings of equal sweep are a bullseye;
// what makes this turn is the outer arc running much further than the inner.
const sweepOf = (d) => Number((d.match(/A[\d.]+ [\d.]+ 0 (\d)/) || [])[1]);
check('the outer arc runs more than half a turn', sweepOf(faviconArcs[0].d) === 1, faviconArcs[0].d);
check('and the inner arc less', sweepOf(faviconArcs[1].d) === 0, faviconArcs[1].d);
check('the outer arc is the larger circle', faviconArcs[0].r > faviconArcs[1].r);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check('the home-screen icon uses the same arcs', same(arcsOf(maskable), faviconArcs),
  JSON.stringify(arcsOf(maskable)));
eq('and the same dot', dotOf(maskable), faviconDot);

// The component holds the mark twice: bare, and inside its container.
const componentArcs = arcsOf(component);
eq('the component draws it twice', componentArcs.length, 4);
check('and both copies match the favicon',
  same(componentArcs.slice(0, 2), faviconArcs) && same(componentArcs.slice(2, 4), faviconArcs),
  JSON.stringify(componentArcs));

/* -------------------------------------------- it survives being small

   At 16px one unit of this 32-unit grid is half a pixel, so two strokes closer
   together than about 1.6 units merge and the mark becomes a disc. A
   three-ring version measured 0.4px between rings and did exactly that, which
   is why this is a test and not a note. */

const [outerArc, innerArc] = faviconArcs;
const gaps = [
  (outerArc.r - outerArc.w / 2) - (innerArc.r + innerArc.w / 2),
  (innerArc.r - innerArc.w / 2) - faviconDot,
];
const smallestPx = Math.min(...gaps) / 32 * 16;
check(`nothing merges at 16px (tightest gap ${smallestPx.toFixed(2)}px)`,
  smallestPx >= 1, JSON.stringify(gaps));

/* ------------------------------------------------- it survives being cropped */

/* A maskable icon is cropped to whatever shape the launcher likes. Anything
 * outside the middle 80% may be cut away, so the safe zone is a circle of
 * radius 205 about the centre of a 512 icon. This is the check the old
 * lightning bolt would have failed: it ran corner to corner. */
const SAFE = 205;
const transform = maskable.match(/translate\((-?[\d.]+)[ ,](-?[\d.]+)\) scale\(([\d.]+)\)/);
check('the home-screen icon places the mark with a transform', !!transform, 'no transform found');
const scale = transform ? Number(transform[3]) : 1;
const reach = Math.max(...faviconArcs.map(a => a.r + a.w / 2)) * scale;
check(`nothing in the home-screen icon can be cropped away (reaches ${reach.toFixed(0)})`,
  reach < SAFE);
check('and it bleeds to the edge, so the crop has something to cut',
  /<rect width="512" height="512"/.test(maskable));

/* ------------------------------------------------------------ it is wired up */

const html = read('index.html');
check('the tab uses it', html.includes('href="/favicon.svg"'));
check('and the home screen', html.includes('href="/icon-maskable.svg"'));
const manifest = JSON.parse(read('public/manifest.webmanifest'));
check('the manifest names both', JSON.stringify(manifest.icons).includes('favicon.svg')
  && JSON.stringify(manifest.icons).includes('icon-maskable.svg'));
check('and marks the maskable one as maskable',
  manifest.icons.some(i => i.src.includes('maskable') && /maskable/.test(i.purpose || '')));

const app = read('src/App.jsx');
check('the sidebar draws the mark rather than a stock icon',
  app.includes('<Logo size={16} />'));

/* ------------------------------------------- the cache has to let it through

   The icons and the manifest are the only files here whose names do not
   change when their contents do -- a build asset carries a hash, so a new
   one is a new URL and can never be served stale. These cannot, and the
   service worker keeps them. That is how a redrawn icon can be right in the
   build and still wrong in the tab: the worker went on handing out the copy
   it already had, and the tab kept its lightning bolt.

   sw.js therefore names its shell cache after a digest of these four files.
   Recomputing it here means an icon cannot be changed without the cache
   being invalidated -- not because somebody remembered to bump a version,
   but because forgetting fails. */

const digest = crypto.createHash('sha256');
for (const f of ['public/favicon.svg', 'public/icon-maskable.svg', 'public/icons.svg', 'public/manifest.webmanifest']) {
  digest.update(fs.readFileSync(path.join(ROOT, f)));
}
const iconsRev = digest.digest('hex').slice(0, 8);

const sw = read('public/sw.js');
const declared = (sw.match(/const ICONS_REV = '([0-9a-f]+)'/) || [])[1];
check('the worker records a digest of the icons', !!declared, 'no ICONS_REV in sw.js');
eq('and it matches the icons on disk', declared, iconsRev);
check('the shell cache is named after that digest',
  /SHELL_CACHE = .webui-shell-\$\{VERSION\}-\$\{ICONS_REV\}./.test(sw), 'the digest is recorded but not used');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
