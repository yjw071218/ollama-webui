// Resume the same server job; never submit the prompt a second time.
export const resumableChatReader = (response, jobId, signal, fetcher = fetch) => {
  let reader = response?.body.getReader(), offset = 0, following = !response;
  const connect = async () => {
    const res = await fetcher(`/api/chat/replay?id=${encodeURIComponent(jobId)}&follow=1&offset=${offset}`, {
      cache: 'no-store', signal,
    });
    if (!res.ok) {
      const error = new Error(`Chat replay returned HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    reader = res.body.getReader();
    following = true;
  };
  return {
    async read() {
      for (;;) {
        signal?.throwIfAborted();
        try {
          if (!reader) await connect();
          const result = await reader.read();
          if (result.done && !following) { reader = null; continue; }
          if (result.value) offset += result.value.byteLength;
          return result;
        } catch (error) {
          signal?.throwIfAborted();
          if (error.status === 404 || error.status === 410) throw error;
          try { await reader?.cancel(); } catch { /* already disconnected */ }
          reader = null;
          await new Promise((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(signal.reason); };
            const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 500);
            signal?.addEventListener('abort', abort, { once: true });
          });
        }
      }
    },
  };
};
