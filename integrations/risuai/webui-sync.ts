import { getDatabase } from './ts/storage/database.svelte';
import { forageStorage, checkCharOrder } from './ts/globalApi.svelte';
import { DBState, selectedCharID, settingsOpen } from './ts/stores.svelte';
import { doingChat } from './ts/process/index.svelte';
import { get } from 'svelte/store';
import { sha256 } from '@noble/hashes/sha2.js';
import { mergeRisu, mergeRisuAutomatically } from './webui-sync-merge.js';
import { syncSettings, applySyncSettings } from './webui-sync-settings.js';
import { applySyncedLocalModel } from './webui-local-model.js';
import { syncAssetTasks } from './webui-sync-assets.js';
import { createDelta, applyDelta } from './webui-sync-delta.js';
import { createAssetIndex } from './webui-sync-asset-index.js';

const fields = ['characters', 'botPresets', 'modules'] as const;
const empty = () => ({ characters: [], botPresets: [], modules: [], assets: {} });
const fingerprint = data => JSON.stringify(data);
const announce = (state, message) => window.parent.postMessage({ channel: 'webui-risu', syncState: state, syncMessage: message }, location.origin);
const hex = (digest: Uint8Array) => Array.from(digest, x => x.toString(16).padStart(2, '0')).join('');
/* The browser's own SHA-256 where there is one (native, off the main thread's
   JS) -- the same digest the pure-JS one gives, many times faster on big
   assets. The fallback is for a page served without a secure context. */
const hash = async (bytes: Uint8Array): Promise<string> => {
  if (globalThis.crypto?.subtle) {
    try { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))); } catch { /* fall back */ }
  }
  return hex(sha256(bytes));
};
const assetKey = key => !key.startsWith('database/') && !key.startsWith('webui-sync/') && key !== 'migrated';

export function startWebUISync(isImporting: () => boolean) {
  let running = false;
  let base: any;
  let stopped = false;
  let remoteCache: any;
  let changedTimer;
  const assetChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('webui-sync-assets');
  const schedule = () => {
    clearTimeout(changedTimer);
    changedTimer = setTimeout(() => { void cycle(); }, 100);
  };
  const assetsIndex = createAssetIndex(forageStorage, assetKey, hash, key => {
    if (key) assetChannel?.postMessage(key);
    schedule();
  });
  if (assetChannel) assetChannel.onmessage = event => { if (typeof event.data === 'string') { assetsIndex.invalidate(event.data); schedule(); } };
  const progress = (label: string) => {
    let last = 0;
    return (done: number, total: number) => {
      if (done === total || Date.now() - last > 250) {
        last = Date.now();
        announce('syncing', `${label} ${done.toLocaleString()}/${total.toLocaleString()}`);
      }
    };
  };
  const synced = () => announce('synced', `동기화됨 · 캐릭터 ${DBState.db.characters.length}개`);
  const snapshot = () => {
    const db = getDatabase({ snapshot: true });
    return { ...Object.fromEntries(fields.map(field => [field, db[field] || []])), settings: syncSettings(db) };
  };
  const blocked = () => isImporting() || get(doingChat);
  const request = async (query = '', options = {}) => {
    const response = await fetch('/api/risu/sync' + query, { ...options, signal: AbortSignal.timeout(60000) });
    if (!response.ok) {
      const error: any = new Error(response.status === 401 ? '같은 WebUI 계정으로 로그인하면 기기 간 대화가 동기화됩니다.' : (await response.json()).error || '동기화 서버에 연결할 수 없습니다.');
      error.status = response.status; throw error;
    }
    return response;
  };
  const remember = async data => {
    await forageStorage.setItem('webui-sync/base', new TextEncoder().encode(JSON.stringify(data)));
    base = data;
  };
  const apply = async data => {
    // Assets are installed before references become visible. Current selection
    // follows its stable character id rather than an index from another device.
    const selected = DBState.db.characters[get(selectedCharID)]?.chaId;
    await syncAssetTasks(Object.entries(data.assets || {}), async ([key, digest]) => {
      if (!assetKey(key)) throw new Error('잘못된 에셋 경로');
      if (assetsIndex.matches(key, digest)) return;
      const current = await forageStorage.getItem(key);
      if (current && await hash(current) === digest) return;
      const bytes = new Uint8Array(await (await request('?asset=' + digest)).arrayBuffer());
      if (await hash(bytes) !== digest) throw new Error('에셋 검증에 실패했습니다.');
      await forageStorage.setItem(key, bytes);
    }, progress('에셋 수신·확인'));
    return () => {
      for (const field of fields) (DBState.db as any)[field] = data[field] || [];
      applySyncSettings(DBState.db, data.settings);
      if (data.settings?.ollamaModel) applySyncedLocalModel(DBState.db);
      checkCharOrder();
      selectedCharID.set(selected ? DBState.db.characters.findIndex(x => x.chaId === selected) : -1);
    };
  };
  /* "(동시 수정 사본)" clones left in this device's own database by older
     builds. They used to be filtered only from a finished merge, and a merge
     that waits -- a reply generating, an import, an edit landing mid-commit --
     never installs, so the copies stayed on screen for as long as sync was
     "pending". Remove them from the live database directly, before any of
     that can wait. The one being chatted with is left until the reply ends. */
  const isCopy = (item: any) => /\(동시 수정 사본\)/.test(item?.name || '');
  const purgeCopies = () => {
    const db: any = DBState.db;
    if (!db) return;
    const current = db.characters?.[get(selectedCharID)];
    const keep = (item: any) => !isCopy(item) || (item === current && get(doingChat));
    let changed = false;
    for (const field of fields) {
      const list = db[field];
      if (!Array.isArray(list) || !list.some((item: any) => !keep(item))) continue;
      db[field] = list.filter(keep);
      changed = true;
    }
    if (!changed) return;
    checkCharOrder();
    const id = current?.chaId;
    selectedCharID.set(id && !isCopy(current) ? db.characters.findIndex((x: any) => x.chaId === id) : -1);
  };
  const cycle = async () => {
    if (running || stopped) return;
    try { purgeCopies(); } catch { /* cleanup only; never block sync */ }
    if (blocked()) { announce('pending', '응답 생성·가져오기를 마치면 자동 동기화합니다.'); return; }
    if (!(window as any).__WEBUI_SESSION__?.id) { announce('guest', '로그인하면 PC·모바일 대화를 동기화할 수 있습니다.'); return; }
    running = true;
    try {
      if (base === undefined) {
        const bytes = await forageStorage.getItem('webui-sync/base');
        base = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
      }
      const local = snapshot();
      const before = fingerprint(local);
      const response = await (await request(remoteCache ? '?delta=1&revision=' + remoteCache.revision : '')).json();
      if (response.delta && response.fromRevision !== remoteCache?.revision) throw new Error('동기화 기준 버전이 일치하지 않습니다.');
      const remote = response.unchanged ? remoteCache : response.delta ? { revision: response.revision, data: applyDelta(remoteCache.data, response.delta) } : response;
      remoteCache = remote;
      const assets = await assetsIndex.read(progress('최초 에셋 확인'));
      // Most polls have no edits. Avoid re-reading and hashing potentially
      // large card audio/video assets on every mobile poll.
      if (base && fingerprint(assets) === fingerprint(base.assets) && fingerprint(local) === fingerprint({ ...Object.fromEntries(fields.map(field => [field, base[field] || []])), settings: base.settings }) && fingerprint(remote.data) === fingerprint(base)) {
        synced(); return;
      }
      // Retain paths, not all binary data: a large library would otherwise
      // keep hundreds of MB alive on a phone until the entire sync finishes.
      const localPaths = new Map();
      for (const [key, digest] of Object.entries(assets)) localPaths.set(digest, key);
      const localData = { ...local, assets: Object.fromEntries(Object.entries(assets).sort(([a], [b]) => a.localeCompare(b))) };
      // Existing installations and new devices have no shared settings base.
      // Adopt already-synced settings instead of publishing device defaults.
      const mergeBase = { ...(base || empty()), settings: base?.settings ?? (remote.data?.settings ? local.settings : undefined) };
      let merged;
      {
        try { merged = remote.data ? mergeRisu(mergeBase, localData, remote.data) : localData; }
        catch (error) {
          await forageStorage.setItem('webui-sync/conflict-' + Date.now(), new TextEncoder().encode(JSON.stringify(localData)));
          merged = mergeRisuAutomatically(mergeBase, localData, remote.data);
          announce('syncing', '두 기기의 수정 내용을 합쳐 자동 동기화합니다.');
        }
      }
      /* "(동시 수정 사본)" clones made by older builds live on in a device's
         own storage and came back as "new on this device" every sync. The
         server drops them; so does every device, from its merge result, which
         then installs without them. */
      // A merge may hand back localData itself; filter a copy so the
      // comparison below still sees that this device must change.
      merged = { ...merged, assets: { ...(merged.assets || {}) } };
      for (const field of fields) if (Array.isArray(merged[field])) merged[field] = merged[field].filter((item: any) => !isCopy(item));
      for (const key of Object.keys(merged.assets || {})) if (/\.sync-[0-9a-f]+$/.test(key)) delete merged.assets[key];
      if (blocked() || fingerprint(snapshot()) !== before) return;
      const sameRemote = fingerprint(merged) === fingerprint(remote.data);
      const sameLocal = fingerprint(merged) === fingerprint(localData);
      if (sameRemote && sameLocal) { if (fingerprint(base) !== fingerprint(merged)) await remember(merged); synced(); return; }
      announce('syncing', '대화와 에셋 동기화 중…');
      if (!sameRemote) {
        const known = new Set(Object.values(remote.data?.assets || {}));
        const missing = [...new Set(Object.values(merged.assets))].filter(digest => !known.has(digest) && localPaths.has(digest));
        await syncAssetTasks(missing, async digest => {
          const bytes = await forageStorage.getItem(localPaths.get(digest));
          if (!bytes || await hash(bytes) !== digest) throw new Error('에셋이 변경되어 다음 동기화에서 다시 확인합니다.');
          await request('?asset=' + digest, { method: 'PUT', body: bytes });
        }, progress('에셋 전송'));
      }
      const install = sameLocal ? null : await apply(merged);
      if (blocked() || fingerprint(snapshot()) !== before) return;
      if (!sameRemote) {
        const payload = remote.data ? { revision: remote.revision, delta: createDelta(remote.data, merged) } : { revision: remote.revision, data: merged };
        const saved = await (await request('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
        remoteCache = { revision: saved.revision, data: merged };
      }
      // A user may type while the commit is in flight. Keep those changes for
      // the next three-way merge instead of overwriting them with this snapshot.
      const safeToInstall = !blocked() && fingerprint(snapshot()) === before;
      if (safeToInstall) install?.();
      if (safeToInstall || sameLocal) await remember(merged);
      if (safeToInstall || sameLocal) synced();
      else announce('pending', '기기 변경 사항을 보존했습니다. 다음 동기화에서 반영합니다.');
    } catch (error) {
      announce(error.status === 401 ? 'guest' : 'error', error.status === 409 ? '다른 기기의 변경 내용을 합치는 중…' : error.message);
      // Another device committed first: fetch and merge it now, not on the next tick.
      if (error.status === 409) schedule();
    }
    finally { running = false; }
  };
  /* Live: hold one request open; the server answers the moment another
     device commits, and this device merges at once. The 500ms tick stays for
     this device's own edits. */
  const watch = async () => {
    while (!stopped) {
      if (document.visibilityState !== 'visible' || !(window as any).__WEBUI_SESSION__?.id) { await new Promise(r => setTimeout(r, 1000)); continue; }
      try {
        const response = await fetch('/api/risu/sync?wait=' + (remoteCache?.revision ?? -1), { signal: AbortSignal.timeout(35000) });
        if (!response.ok) { await new Promise(r => setTimeout(r, 3000)); continue; }
        const answer = await response.json();
        if (answer.changed) schedule();
      } catch { await new Promise(r => setTimeout(r, 3000)); }
    }
  };
  const tick = () => { if (document.visibilityState === 'visible') void cycle(); };
  const flush = () => { void cycle(); };
  const timer = setInterval(tick, 500);
  const stopChat = doingChat.subscribe(active => {
    if (active) announce('pending', '응답을 생성한 뒤 동기화합니다.');
    else setTimeout(flush, 250);
  });
  const stopSettings = settingsOpen.subscribe(open => { if (!open) setTimeout(flush, 250); });
  window.addEventListener('focus', tick);
  window.addEventListener('blur', flush);
  document.addEventListener('visibilitychange', flush);
  // Mobile browsers freeze and restore this same page via the back/forward
  // cache. Keep subscriptions alive on persisted pagehide and resume polling.
  const resume = () => { const was = stopped; stopped = false; flush(); if (was) void watch(); };
  window.addEventListener('pageshow', resume);
  window.addEventListener('online', tick);
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    stopped = true; stopChat(); stopSettings(); clearInterval(timer);
    clearTimeout(changedTimer); assetChannel?.close();
    window.removeEventListener('focus', tick); window.removeEventListener('blur', flush);
    window.removeEventListener('pageshow', resume); window.removeEventListener('online', tick);
    document.removeEventListener('visibilitychange', flush);
  });
  void cycle();
  void watch();
  return { run: () => { void cycle(); } };
}
