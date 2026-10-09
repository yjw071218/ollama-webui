// Layout may grow after React renders (images, fonts and content-visibility).
export function observeConversationTail(area, shouldFollow, follow) {
  let frame = 0;
  const settle = () => {
    if (!shouldFollow() || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (shouldFollow()) follow();
    });
  };
  const observer = new ResizeObserver(settle);
  observer.observe(area);
  for (const child of area.children) observer.observe(child);
  area.addEventListener('load', settle, true);
  settle();
  return () => {
    observer.disconnect();
    area.removeEventListener('load', settle, true);
    cancelAnimationFrame(frame);
  };
}
