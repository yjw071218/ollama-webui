import React, { useLayoutEffect, useRef, useState } from 'react';

// Heights survive switching conversations. Only the light spacer stays mounted
// outside the viewport; Markdown, charts and document previews are unmounted.
const heights = new Map();
export default function VirtualMessage({ chat, index, pinned, children }) {
  const key = `${chat}:${index}`;
  const element = useRef(null);
  const [visible, setVisible] = useState(() => !heights.has(key));
  const [printing, setPrinting] = useState(false);
  const height = useRef(heights.get(key) || 0);
  const revealUntil = useRef(0);
  const shown = visible || pinned || printing;
  useLayoutEffect(() => {
    const node = element.current;
    const root = node.closest('.messages-scroll-area');
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting || Date.now() < revealUntil.current || node.contains(document.activeElement)) setVisible(true);
      else setVisible(false);
    }, { root, rootMargin: '1000px 0px' });
    observer.observe(node);
    const reveal = event => {
      if (String(event.detail.chat) === String(chat) && event.detail.index === index) {
        revealUntil.current = Date.now() + 2000;
        setVisible(true);
      }
    };
    const beforePrint = () => setPrinting(true), afterPrint = () => setPrinting(false);
    window.addEventListener('webui-reveal-row', reveal);
    window.addEventListener('beforeprint', beforePrint);
    window.addEventListener('afterprint', afterPrint);
    return () => {
      observer.disconnect();
      window.removeEventListener('webui-reveal-row', reveal);
      window.removeEventListener('beforeprint', beforePrint);
      window.removeEventListener('afterprint', afterPrint);
    };
  }, [chat, index]);
  useLayoutEffect(() => {
    if (!shown) return;
    const node = element.current;
    const measure = () => {
      height.current = node.getBoundingClientRect().height;
      heights.delete(key); heights.set(key, height.current);
      if (heights.size > 10000) heights.delete(heights.keys().next().value);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown, key]);
  return <div ref={element} data-virtual-index={index} className="virtual-message"
    style={shown ? { display: 'flow-root' } : { height: height.current }} aria-hidden={shown ? undefined : true}>
    {shown ? children : null}
  </div>;
}
