// Preserve tail-following across wrapping, preview changes and workspace hiding.
export function followRunnerOutput(el) {
  let following = true;
  let width = el.clientWidth, height = el.clientHeight, content = el.scrollHeight;
  const remember = () => { width = el.clientWidth; height = el.clientHeight; content = el.scrollHeight; };
  const update = () => {
    if (following && el.clientHeight) el.scrollTop = el.scrollHeight;
    remember();
  };
  const scroll = () => {
    if (width !== el.clientWidth || height !== el.clientHeight || content !== el.scrollHeight) {
      update();
      return;
    }
    following = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  const observer = new ResizeObserver(update);
  observer.observe(el);
  el.addEventListener('scroll', scroll);
  update();
  return { update, destroy() { observer.disconnect(); el.removeEventListener('scroll', scroll); } };
}
