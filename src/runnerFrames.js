// Keep browsing contexts connected while their React layout slots change.
export function createFramePool() {
  const frames = new Map();
  let parking;
  const park = () => {
    if (!parking) {
      parking = document.createElement('div');
      parking.setAttribute('aria-hidden', 'true');
      Object.assign(parking.style, { position: 'fixed', left: '-20000px', top: '0', width: '1280px', height: '720px', visibility: 'hidden', pointerEvents: 'none' });
      document.body.append(parking);
    }
    return parking;
  };
  const move = (host, frame) => {
    if (frame.parentNode === host) return;
    if (host.moveBefore && frame.isConnected && host.isConnected) host.moveBefore(frame, null);
    else host.append(frame);
  };
  return {
    attach(host, url, revision, style) {
      let entry = frames.get(url);
      if (!entry) {
        const frame = document.createElement('iframe');
        frame.className = 'runner-frame';
        frame.title = 'preview';
        frame.allow = 'fullscreen; autoplay; gamepad; pointer-lock; clipboard-read; clipboard-write; accelerometer; gyroscope; xr-spatial-tracking';
        frame.allowFullscreen = true;
        frame.src = url;
        entry = { frame, revision };
        frames.set(url, entry);
      } else if (entry.revision !== revision) { entry.frame.src = url; entry.revision = revision; }
      entry.frame.removeAttribute('style');
      for (const [key, value] of Object.entries(style)) entry.frame.style[key] = typeof value === 'number' && ['width', 'height'].includes(key) ? `${value}px` : String(value);
      move(host, entry.frame);
      return () => { if (entry.frame.parentNode === host) move(park(), entry.frame); };
    },
    retain(urls) {
      for (const [url, { frame }] of frames) if (!urls.has(url)) { frame.remove(); frames.delete(url); }
    },
    destroy() { for (const { frame } of frames.values()) frame.remove(); frames.clear(); parking?.remove(); parking = null; },
  };
}
