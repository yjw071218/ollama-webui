/**
 * "Decoding" reveal for streamed words: a new word first shows as random
 * symbols that settle, left to right, into its real letters.
 *
 * The words are <span class="tok"> nodes that React owns, so their text is
 * never touched -- React would later write over it, or we over React. The
 * scramble lives in a `data-scramble` attribute drawn by ::before over the
 * real text (made transparent meanwhile; see extras.css), and the attribute is
 * removed when the word has resolved. Layout never moves: the real word still
 * takes its own width the whole time.
 */
const GLYPHS = '!<>-_\\/[]{}=+*^?#%&@$~:;01';
const DURATION = 420;   // ms for a word to settle
const MAX_ACTIVE = 80;  // a burst of text should not cost a frame per word

const active = new Map(); // span -> { text, start }
let frame = 0;

const pick = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];

const tick = (now) => {
  frame = 0;
  for (const [el, w] of active) {
    if (!el.isConnected || el.textContent !== w.text) {
      el.removeAttribute('data-scramble');
      active.delete(el);
      continue;
    }
    const p = (now - w.start) / DURATION;
    if (p >= 1) {
      el.removeAttribute('data-scramble');
      active.delete(el);
      continue;
    }
    // Letters before the head are real; after it, a fresh symbol each frame.
    const chars = Array.from(w.text);
    const head = Math.floor(p * chars.length);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      out += i < head || /\s/.test(chars[i]) ? chars[i] : pick();
    }
    el.setAttribute('data-scramble', out);
  }
  if (active.size) frame = requestAnimationFrame(tick);
};

const start = (el) => {
  if (active.has(el) || active.size >= MAX_ACTIVE) return;
  const text = el.textContent || '';
  if (!text.trim()) return;
  active.set(el, { text, start: performance.now() });
  el.setAttribute('data-scramble', Array.from(text).map(pick).join(''));
  if (!frame) frame = requestAnimationFrame(tick);
};

export const installDecodeReveal = () => {
  if (typeof MutationObserver === 'undefined') return;
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        // Only while an answer is arriving; history and reloads appear at once.
        if (!node.closest?.('.markdown-body.is-streaming')) continue;
        if (node.classList?.contains('tok')) start(node);
        else node.querySelectorAll?.('.tok').forEach(start);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
};
