// Zooming and moving a picture.
//
// All of this is arithmetic, and all of it is the kind that is wrong by a
// factor rather than by a mile: a zoom that scales about the centre instead of
// about the cursor still zooms, and still feels broken. So the properties are
// pinned as numbers here, where they can be read, rather than left to be
// noticed by a finger.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const Z = await import(pathToFileURL(path.join(ROOT, 'src/zoomPan.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const near = (name, got, want, tol = 0.001) => check(name, Math.abs(got - want) <= tol,
  `got ${got} want ${want}`);

const box = { left: 0, top: 0, width: 400, height: 800 };

/* ------------------------------------------------- zooming about a point

   The whole reason this is not `transform: scale()` and a drag handler.
   Turning the wheel over a face has to leave that face under the cursor;
   scaling about the centre sends it off the edge, and the next second is spent
   dragging it back. */

{
  // Where a picture point lands on screen, given a view.
  const onScreen = (view, p) => view.x + view.scale * p;
  const cursor = { x: 100, y: -60 };
  // The picture point currently under the cursor, at fit.
  const px = (cursor.x - Z.FIT.x) / Z.FIT.scale;
  const py = (cursor.y - Z.FIT.y) / Z.FIT.scale;

  const v = Z.zoomAt(Z.FIT, 2, cursor, box);
  near('what was under the cursor is still under it, across', onScreen({ ...v, x: v.x }, px), cursor.x);
  near('and down', onScreen({ ...v, x: v.y }, py), cursor.y);
  check('and it did zoom', v.scale === 2);
}

/* Turning the wheel in and back out lands exactly where it started. An
   additive step does not: it is coarse at 1x and imperceptible at 6x, and the
   rounding leaves the picture a little off every time. */
{
  const cursor = { x: 100, y: 0 };
  let v = Z.FIT;
  for (let i = 0; i < 8; i++) v = Z.zoomAt(v, Z.wheelScale(v, -100), cursor, box);
  check('eight notches in is well past fit', v.scale > 3, String(v.scale));
  for (let i = 0; i < 8; i++) v = Z.zoomAt(v, Z.wheelScale(v, 100), cursor, box);
  near('and eight back out is exactly fit again', v.scale, 1);
  near('  with nothing left over, across', v.x, 0);
  near('  or down', v.y, 0);
}

/* The deltas browsers report are not comparable: a line is not a pixel and a
   page is neither. Unnormalised, one notch on a mouse that reports lines would
   move a hundredth of what the same notch does elsewhere. */
check('a wheel that reports lines is not a wheel that reports pixels',
  Z.wheelScale(Z.FIT, -3, 1) !== Z.wheelScale(Z.FIT, -3, 0));
check('and every mode still zooms in when the delta is negative',
  [0, 1, 2].every(mode => Z.wheelScale(Z.FIT, -1, mode) > 1));

/* ------------------------------------------------------------ the bounds */

check('fit is the floor -- there is no zooming out past the screen',
  Z.clampScale(0.2) === Z.MIN_SCALE);
check('and there is a ceiling, past which there is no more detail to show',
  Z.clampScale(9999) === Z.MAX_SCALE);

{
  /* At fit the offset is always zero. That is what lets a drag mean the
     viewer's own gesture -- across to the next picture, down to close -- with
     no ambiguity about whether the picture was meant to move. */
  const v = Z.clampOffset({ scale: 1, x: 80, y: -40 }, box);
  check('at fit the picture is centred, whatever it is asked for',
    v.x === 0 && v.y === 0, JSON.stringify(v));
  check('  and a drag there belongs to the viewer', Z.dragOwner(Z.FIT) === 'viewer');
  check('  while a drag zoomed in belongs to the picture', Z.dragOwner({ scale: 2 }) === 'picture');
}

{
  /* Zoomed in, the picture may be moved exactly as far as it overhangs and no
     further -- so there is never an empty margin to drag into, and nothing to
     spring back from. */
  const v = Z.clampOffset({ scale: 2, x: 1e6, y: -1e6 }, box);
  near('it cannot be dragged off sideways', v.x, Z.panLimit(2, box.width));
  near('nor off the bottom', v.y, -Z.panLimit(2, box.height));
  near('the overhang at 2x is half the box', Z.panLimit(2, 400), 200);
  near('and at fit there is none at all', Z.panLimit(1, 400), 0);
}

/* -------------------------------------------------------------- gestures */

{
  const a = { clientX: 0, clientY: 0 };
  const b = { clientX: 30, clientY: 40 };
  const { distance, mid } = Z.pinchOf(a, b);
  near('two fingers are as far apart as they look', distance, 50);
  check('and the point between them is between them',
    mid.clientX === 15 && mid.clientY === 20);
}

check('a double press goes in when it is out', Z.toggleZoom(Z.FIT, { x: 0, y: 0 }, box).scale > 1);
check('and comes back to fit when it is in',
  Z.toggleZoom({ scale: 4, x: 30, y: 30 }, { x: 0, y: 0 }, box).scale === 1);

check('a hair over 1 does not count as zoomed', !Z.isZoomed({ scale: 1.0005 }));
check('but a visible amount does', Z.isZoomed({ scale: 1.2 }));

/* The transform is composited: translate and scale only, never width or left.
   This runs on every frame of a pinch. */
{
  const css = Z.transformOf({ scale: 2, x: 10.00049, y: -3 });
  check('the transform is one composited string', /^translate3d\(.+\) scale\(2\)$/.test(css), css);
  check('  and does not carry more precision than a pixel deserves',
    css === 'translate3d(10px, -3px, 0) scale(2)', css);
}

/* A view built from nothing at all is still a view. These come from events. */
{
  const v = Z.clampOffset(undefined, undefined);
  check('a missing view reads as fit', v.scale === 1 && v.x === 0 && v.y === 0);
  check('and a missing scale does not read as zero', Z.clampScale(null) === Z.MIN_SCALE);
}

/* ------------------------------------------------------------ the wiring */
{
  const box2 = fs.readFileSync(path.join(ROOT, 'src/StudioLightbox.jsx'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src/studio.css'), 'utf8');

  /* A filling animation outranks an inline style. The viewer's entrance
     animation ended on `transform: none` and held it with `both`, so the
     zoom was computed, written to the element, and never painted --
     `getComputedStyle` said identity while the inline style said 5.2x.
     `backwards` keeps the opening frame during the delay and releases the
     element when the entrance ends, which is when the zoom starts to
     matter. */
  check('the entrance animation lets go of the picture when it is done',
    /animation: studio-lightbox-rise [^;]*backwards;/.test(css)
    && !/animation: studio-lightbox-rise [^;]*both;/.test(css));
  check('  and so does the one for walking through with the arrows',
    !/is-walking[\s\S]{0,200}animation: fade-in [^;]*both;/.test(css));

  /* React attaches `wheel` at the root as a passive listener, so a
     `preventDefault` inside an `onWheel` prop is ignored with a warning and
     the page scrolls behind the picture while the picture zooms. The listener
     has to be this element's own, asked for non-passive. */
  check('the viewer zooms with the wheel',
    /el\.addEventListener\('wheel', onWheel, \{ passive: false \}\)/.test(box2));
  check('  and not through React, whose wheel listener cannot take the gesture',
    !/onWheel=\{/.test(box2));
  check('  taking the page scroll for it, or the page moves too',
    /const onWheel = \(event\) => \{[\s\S]{0,120}event\.preventDefault\(\);/.test(box2));
  /* And touch does it the other way round: `touch-action` is declarative and
     works before the first frame, where a passive `onTouchMove` cannot. */
  check('  while touch is claimed by touch-action rather than by preventDefault',
    !/onTouchMove[\s\S]{0,400}event\.preventDefault\(\)/.test(box2));
  check('the viewer pinches and pans', /onTouchMove=\{onTouchMove\}/.test(box2)
    && /kind: 'pinch'/.test(box2) && /kind: 'pan'/.test(box2));
  check('  with the browser\'s own gestures switched off only where it takes over',
    /zoomable \? \{ touchAction: 'none' \} : undefined/.test(box2));
  /* A touch synthesises mouse events as well. Both handlers moving the picture
     doubles every drag. */
  check('  and a touch drag is not also followed as a mouse drag',
    /if \(!g \|\| g\.kind !== 'pan' \|\| g\.touch\) return;/.test(box2));
  check('a film keeps its own scrubber', /const zoomable = !item\.video/.test(box2));
  /* A click no longer resizes anything -- the wheel and two fingers do that,
     continuously, and a click that jumped between two fixed sizes was a way
     to lose your place, especially at the end of a drag where a click is what
     the browser reports whether one was meant or not. It is still stopped
     from reaching the backdrop, which closes the viewer. */
  check('a click does not resize, and does not close the viewer either',
    /onClick=\{\(event\) => \{ event\.stopPropagation\(\); moved\.current = false; \}\}/.test(box2));
  /* Only the picture inside the viewer. A thumbnail elsewhere still says
     zoom-in, and still means it: pressing one opens the viewer. */
  check('  and the picture in the viewer no longer promises that it will',
    !/\.studio-lightbox-stage img \{[^}]*cursor: zoom-in/.test(css)
    && !/cursor: zoom-out/.test(css));
  // The same rule, checked in full further down under "three ways the viewer
  // went quiet": it is keyed on the index now, because a URL is not what
  // changes when somebody walks a gallery.
  check('and the zoom resets when the picture underneath changes',
    /useEffect\(\(\) => \{ setView\(FIT\); \}, \[index, /.test(box2));
  /* `veiled` is true while the verdict is pending and false a second later.
     Resetting on every change of it threw away a zoom made in that second. */
  check('  and when a veil goes up, but not when one comes down',
    /useEffect\(\(\) => \{ if \(veiled\) setView\(FIT\); \}, \[veiled\]\);/.test(box2));
}

/* ================================================ three ways the viewer went quiet

   All three were reported as "it does not respond", and none of them was.

   Measured in a phone-sized headless browser with a real file in ComfyUI's
   output folder, because two of the three are invisible in the source: they
   are about what the *rendered* viewer does. */

{
  const box = fs.readFileSync(path.join(ROOT, 'src/StudioLightbox.jsx'), 'utf8');
  const panel = fs.readFileSync(path.join(ROOT, 'src/StudioPanel.jsx'), 'utf8');
  const gallery = fs.readFileSync(path.join(ROOT, 'src/PictureGallery.jsx'), 'utf8');

  /* ---- the arrows that "did not press" ----

     They pressed. The picture changed and the view stayed at 5x on the middle
     of the new one, which from the outside is a button that did nothing. The
     reset was keyed on the picture's URL, and a URL is not what changes when
     somebody walks a gallery: two entries can be the same file -- a retouch
     kept beside its original, one picture appearing in two messages -- and
     those walked past without resetting anything. */
  check('walking the gallery goes back to fit',
    /useEffect\(\(\) => \{ setView\(FIT\); \}, \[index, item\?\.url, showCompare\]\);/.test(box));
  check('  keyed on the index, which always changes',
    /\[index, /.test(box));

  /* ---- "확인 중" that never finished ----

     A verdict handed to the viewer is final: carrying one is how a caller says
     "this has been judged, do not judge it again", and both effects that would
     look at the picture are skipped. So handing over `pending` for a job
     nobody had looked at yet froze the picture behind "checking…" for the life
     of the viewer, and the reveal button was the only way past. */
  check('the viewer treats a given verdict as final',
    /const given = item\?\.verdict !== undefined;/.test(box));
  check('so the Studio hands one over only when it has one',
    /\.\.\.\(job\.safety\?\.verdict\s*\?\s*\{ verdict: strongest\(/.test(panel));
  check('  and never a frozen "pending"',
    !/verdict: settleVerdict\(/.test(panel));
  /* The card is a different question and keeps `settleVerdict`: a card is on
     screen while the job is still running, and "not yet known" is the answer
     then. */
  check('  while the card still says "not yet known" while one is running',
    /const settleVerdict = /.test(panel));
  // The gallery beside it already had this right, and is what the fix copied.
  check('  as the gallery already did',
    /\.\.\.\(known \? \{ verdict: strongest\(known, promptSignal\(item\.prompt\)\) \} : \{\}\)/.test(gallery));

  /* ---- a covered picture that ignored the wheel ----

     Blocked on the reasoning that a bigger blur is still a blur. True, and not
     a reason to refuse the gesture: the veil is `filter: blur(44px)` on the
     picture itself, so scaling the element scales the blurred result and no
     detail comes back. Measured: wheeling on the veil zooms to 1.73x and the
     blur is still `blur(44px) saturate(0.6) brightness(0.8)` afterwards. */
  check('a covered picture can still be zoomed',
    /const zoomable = !item\.video && !showCompare;/.test(box));
  check('  and the veil is a filter on the picture, so zooming cannot lift it',
    /\.studio-lightbox-stage\.is-veiled img,[\s\S]{0,120}filter: blur\(/.test(
      fs.readFileSync(path.join(ROOT, 'src/safeguard.css'), 'utf8')));
  /* A film keeps its own gestures: the scrubber is dragged, and a pinch on a
     `<video>` belongs to the player. */
  check('  while a film keeps its own', /!item\.video/.test(box));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
