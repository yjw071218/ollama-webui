import { useEffect, useRef } from 'react';

/* The bottom of a partly drawn chat list: when it comes near the screen, ask
   for more rows.

   The sidebar drew every chat. On a real account that was 536 rows and 11,944
   of the page's 12,156 elements, and every reply re-rendered them and then
   forced a layout of all of them (the composer and the scroll position are
   measured after each update). On a phone, at a 4x slower CPU, that was most
   of the 7-10 s of main-thread work per sent message. The rows below the fold
   are drawn when the list is scrolled towards them, which looks the same. */
export default function SidebarMore({ hidden, onMore }) {
  const node = useRef(null);
  const more = useRef(onMore);
  more.current = onMore;
  useEffect(() => {
    const el = node.current;
    if (!el || typeof IntersectionObserver !== 'function') return undefined;
    const root = el.closest('.sidebar-content') || null;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) more.current();
    }, { root, rootMargin: '600px 0px' });
    observer.observe(el);
    /* And on scroll. An observer is only run when the page renders, which a
       hidden or backgrounded window (and some WebViews) does not -- measured:
       scrolled to the bottom there, no rows came. A scroll has just laid the
       list out, so asking where the end is costs nothing extra. */
    const onScroll = () => {
      if (!root) return;
      if (el.getBoundingClientRect().top < root.getBoundingClientRect().bottom + 600) more.current();
    };
    root?.addEventListener('scroll', onScroll, { passive: true });
    return () => { observer.disconnect(); root?.removeEventListener('scroll', onScroll); };
  }, [hidden]);
  if (!hidden) return null;
  // A real button as well, for when there is no IntersectionObserver.
  return (
    <button type="button" ref={node} className="sidebar-more" onClick={() => more.current()}>
      +{hidden}
    </button>
  );
}
