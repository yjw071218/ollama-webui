import { useEffect, useState } from 'react';
import { api } from './session.jsx';
import { syncedRecords } from './syncEngine.js';

export function useRecordSearch(query, scope, signedIn) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    setResult(null);
    if (!signedIn || !query || query.length > 200) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const stamps = syncedRecords(scope);
        const hits = new Set();
        let offset = 0, page;
        do {
          page = await api(`/api/auth/records/search?q=${encodeURIComponent(query)}&offset=${offset}`, { signal: controller.signal });
          for (const hit of page.hits) hits.add(String(hit.sessionId));
          if (!page.complete && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)) throw new Error('Search page did not advance.');
          offset = page.nextOffset;
        } while (!page.complete && !controller.signal.aborted);
        if (!controller.signal.aborted) setResult({ query, scope, hits, stamps });
      } catch { /* Offline and older servers retain local search. */ }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, scope, signedIn]);
  return signedIn && result?.query === query && result.scope === scope ? result : null;
}
