// Account-wide activity is independent of this tab's current chat or request.
export function watchLiveJobs(onSnapshot, { fetcher = fetch, win = window, doc = document, interval = 2000 } = {}) {
  let disposed = false, pending = false, controller;
  const refresh = async () => {
    if (disposed || pending) return;
    pending = true;
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetcher('/api/chat/live?all=1', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) return;
      const data = await response.json();
      if (!disposed && data.success && Array.isArray(data.jobs)) onSnapshot(data.jobs);
    } catch { /* Offline is not evidence that a request finished. */ }
    finally { clearTimeout(timeout); pending = false; }
  };
  const visible = () => { if (!doc.hidden) void refresh(); };
  win.addEventListener('focus', visible);
  win.addEventListener('online', visible);
  doc.addEventListener('visibilitychange', visible);
  const timer = setInterval(visible, interval);
  void refresh();
  return () => {
    disposed = true; controller?.abort(); clearInterval(timer);
    win.removeEventListener('focus', visible);
    win.removeEventListener('online', visible);
    doc.removeEventListener('visibilitychange', visible);
  };
}

export function busyChats(jobs, localChat, currentChat) {
  const chats = [...new Set([...(localChat == null ? [] : [String(localChat)]), ...jobs.map(job => String(job.chat))])];
  return chats.filter(chat => chat !== String(currentChat));
}
