// Keeping this device in step with the account, one record at a time.
//
// What this replaces gathered the whole account into a blob, uploaded it, and
// stored it by overwriting. With one device that is fine. With two — which is
// the entire point of having an account — it loses data:
//
//   * The laptop uploads. Its blob does not contain the chat the phone wrote a
//     minute ago, so the account no longer has that chat.
//   * The phone deletes a chat. The laptop's next upload, made from a copy that
//     still has it, puts it back. A blob cannot express "this one is gone".
//   * Every change ships the whole history. On a phone that is not a sync.
//
// So the unit is a record: one chat, one setting, one document, one memory,
// each with its own timestamp. Conflicts resolve per record and by time, so two
// devices editing different chats never collide and two devices editing the
// same one keep the later edit. Deletions are tombstones — real writes that
// travel — so they finally propagate. And a device pulls by revision, asking
// only for what changed since it last looked.
//
// The local timestamps are the load-bearing part. A record without an honest
// `updatedAt` cannot win or lose a conflict correctly, which is why settings
// get a shadow table of their own (see settingsStore.js) rather than being
// compared by value.

import localforage from 'localforage';
import { api, ApiError, currentTabSession } from './session.jsx';
import { ownerOfScope } from './profileScope.js';
import { mergeJobs, trimJobs } from './studioTools.js';
import { waitFor, isOverdue } from './coalesce.js';
import {
  readScopeSettings, writeScopeSettings, removeScopedKey,
  settingStamps, stampSetting, forgetSettingStamp,
} from './settingsStore.js';

const named = (storeName) => localforage.createInstance({ name: 'ollama-webui', storeName });

const SESSION_PREFIX = 'ollama-sessions';

/** Raised when the account on screen is not the account the server answered for. */
export class OwnerMismatch extends Error {
  constructor(expected, found) {
    super('That data belongs to a different account.');
    this.name = 'OwnerMismatch';
    this.expected = expected;
    this.found = found || null;
  }
}

/* --------------------------------------------------------------- local keys */

const keysFor = (scope) => ({
  chats: `${SESSION_PREFIX}:${scope}`,
  knowledge: `knowledge:${scope}`,
  memory: `memory:${scope}`,
  folders: `chatFolders:${scope}`,
  presets: `samplingPresets:${scope}`,
  personas: `systemPrompts:${scope}`,
  // Who is asking. It is stored beside the personas and travels the same way,
  // and it was the one library that did neither: written on a phone it stayed
  // on that phone, because nothing here ever collected it.
  profile: `userProfile:${scope}`,
  /* What the Studio was last set to, per workflow: the four prompt boxes, the
     size, the sampler, the LoRA stack. The same argument as the profile — a
     prompt written on a phone stayed on that phone — and the same shape, one
     small object read and written whole. */
  studio: `studioSettings:${scope}`,
  /* And the prompt blocks kept by name -- a character, a lighting recipe, the
     quality words that suit one checkpoint. The same shape as the personas and
     the sampling presets beside them: one named list, read and written whole.
     See src/studioPresets.js. */
  studioPrompts: `studioPrompts:${scope}`,
  /* And who it has been taught to draw: a LoRA's name, the word that summons
     it, and how hard to apply it. The trained file is not in here -- it lives
     in the ComfyUI that made it, which is the one serving this app. See
     src/characters.js. */
  characters: `characters:${scope}`,
  /* And what has been made. The pictures themselves are not carried: an entry
     holds the prompt, the settings and a `/studio/view` URL, which resolves
     through whichever machine is serving this app — so a phone opening the
     same server sees the same gallery without a byte of image data crossing
     the sync.
     *
     * Not a whole-list record, though it looks like one. See `studioJob`. */
  studioJobs: `studioHistory:${scope}`,
});

/* The whole-list records: small ordered things the app reads and writes entire,
 * so splitting them into per-item records would invent conflicts the UI cannot
 * express. One record each, with its own timestamp. Listed once because the
 * collect and apply sides have to agree, and a kind added to one and forgotten
 * in the other is a record that uploads and never comes back down. */
const WHOLE_LISTS = ['folders', 'presets', 'personas', 'profile', 'studio', 'studioPrompts', 'characters'];

/* The Studio's two records, which are applied like the others but reported
   apart from them. Every other list is read into state once, at mount, so a
   change to one needs the page rebuilt; the Studio re-reads its own in place
   (see the `webui:studio-synced` event). Counting them as ordinary lists made
   every job the Studio ran — queued, running, done, each one a write — end in
   a page reload. */
const STUDIO_LISTS = new Set(['studio', 'studioPrompts', 'characters']);

// Where this device's place in the account's history is remembered. Per scope,
// because two accounts on one browser are two independent positions.
const revKey = (scope) => `syncRev@${scope}`;
const sentKey = (scope) => `syncSent@${scope}`;

// Keep an initial/recovery upload below the server's 32 MB request limit.
// One oversized chat must not prevent every newer chat from being uploaded.
export const uploadBatch = records => {
  const batch = [], refused = [];
  let bytes = 0, remaining = 0;
  const encoder = new TextEncoder();
  for (const record of [...records].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const size = encoder.encode(JSON.stringify(record)).byteLength;
    if (!record.deleted && encoder.encode(JSON.stringify(record.payload)).byteLength > 8 * 1024 * 1024) {
      refused.push({ kind: record.kind, id: record.id, reason: '대화에 포함된 첨부파일 등의 크기가 동기화 한도 8MB를 초과했습니다.' });
      continue;
    }
    if (batch.length >= 100 || (batch.length > 0 && bytes + size > 8 * 1024 * 1024)) { remaining++; continue; }
    batch.push(record); bytes += size;
  }
  return { batch, refused, remaining };
};

export const readRev = (scope) => {
  try { return Number(localStorage.getItem(revKey(scope))) || 0; } catch (e) { return 0; }
};

const writeRev = (scope, rev) => {
  try { localStorage.setItem(revKey(scope), String(rev)); } catch (e) { /* quota */ }
};

/**
 * What this device has already uploaded, as `kind:id -> updatedAt`.
 *
 * Without it every sync would re-send the whole local store: there is no other
 * way to tell a record that has changed since the last upload from one that has
 * not. It is a cache, not a source of truth — losing it costs one large upload,
 * not correctness, because the server resolves by timestamp anyway.
 */
const readSent = (scope) => {
  try { return JSON.parse(localStorage.getItem(sentKey(scope)) || '{}'); } catch (e) { return {}; }
};

const writeSent = (scope, sent) => {
  try { localStorage.setItem(sentKey(scope), JSON.stringify(sent)); } catch (e) { /* quota */ }
};

/** Forget this device's sync position, so the next sync is a full one. */
export const resetSyncPosition = (scope) => {
  try {
    localStorage.removeItem(revKey(scope));
    localStorage.removeItem(`initialSyncPending@${scope}`);
    localStorage.removeItem(sentKey(scope));
  } catch (e) { /* private mode */ }
};

/* ------------------------------------------------- pictures, not their bytes

   A generated picture is kept in the chat as a data URL -- the whole PNG, in
   base64, at the size it was saved. One of these is around thirteen megabytes,
   and the sync refuses any single record over eight: a conversation with one
   picture in it could not be uploaded at all, which is what "the pictures do
   not reach my phone" turned out to mean.

   Nothing has to cross, though. The bytes are already on the machine serving
   this app, and `/studio/view` hands them back by name -- which is exactly how
   the Studio's own gallery has always synced ("not a byte of image data
   crossing the sync"). So what goes up is the address rather than the picture,
   and on the other device it lands in the same field: an `<img src>` and a
   `fetch()` cannot tell the two apart, so nothing downstream has to know.

   Only the copy being uploaded is changed. What this browser holds is left as
   it is, so a picture already on screen does not start depending on the server
   being reachable. */

// Every save node in every workflow writes under this prefix -- see
// `stampOutputs` in server/workflows.js, which sets it on all of them.
const OUTPUT_SUBFOLDER = 'webui';

/** Where a picture's bytes can be fetched from, or '' if that cannot be said. */
export const pictureUrl = (picture) => {
  if (typeof picture?.url === 'string' && picture.url) return picture.url;
  const filename = picture?.filename || picture?.file?.filename;
  if (!filename || typeof filename !== 'string') return '';
  return `/studio/view?${new URLSearchParams({
    filename, subfolder: OUTPUT_SUBFOLDER, type: 'output',
  })}`;
};

/**
 * One picture with its bytes swapped for an address, where there is one.
 *
 * The same picture back when there is nothing to swap -- an address is already
 * an address, and a chat that came down from the account and goes up again
 * must not read as changed. `localChanges` compares by timestamp, but the
 * caller uses identity to decide whether the message was touched at all.
 */
const asAddress = (picture) => {
  if (!picture || typeof picture !== 'object') return picture;
  const url = String(picture.dataUrl || '').startsWith('data:') ? pictureUrl(picture) : '';
  // The one it was drawn instead of, which is a whole picture of its own.
  const other = picture.retouch?.other;
  const inner = other ? asAddress(other) : other;
  if (!url && inner === other) return picture;
  return {
    ...picture,
    ...(url ? { dataUrl: url } : {}),
    ...(inner !== other ? { retouch: { ...picture.retouch, other: inner } } : {}),
  };
};

/**
 * A chat as it should be uploaded: every generated picture by address.
 *
 * Pictures the reader *attached* are left alone. Those have no copy on the
 * server -- they came off a phone's camera roll -- so an address for them
 * would name nothing, and a chat that is too big because of one is a chat the
 * server refuses and says so.
 */
export const withoutPictureBytes = (chat) => {
  const messages = chat?.messages;
  if (!Array.isArray(messages)) return chat;
  let touched = false;
  const next = messages.map((message) => {
    if (!Array.isArray(message?.generated) || !message.generated.length) return message;
    const generated = message.generated.map(asAddress);
    if (generated.every((picture, i) => picture === message.generated[i])) return message;
    touched = true;
    return { ...message, generated };
  });
  return touched ? { ...chat, messages: next } : chat;
};

/* ------------------------------------------------------------- local reads */

/* ------------------------------------------------------------- the gallery

   One record per job, not one for the list.

   It was one for the list, and the shape was the bug. Two devices can both be
   right about a gallery -- the phone finished three pictures this machine
   never saw, this machine is running one the phone has never heard of -- and a
   single row cannot hold both: whoever uploads last overwrites it, and the
   other device's pictures are gone from the account before anyone could merge
   them. Merging on the way down does not rescue it either, because the upload
   in the same request has already replaced the row.

   Per job, none of that arises. Two devices writing about different jobs are
   writing to different records and neither touches the other; a job both know
   is resolved by its own timestamp, like a chat; and forgetting one becomes a
   tombstone, which a whole-list record could never express at all.

   The list in storage is still a list -- that is what the panel reads. It is
   only the wire that is per job. */

/** The jobs this device holds, as an array. */
const readJobs = (key) => {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed.filter(job => job && job.id != null) : [];
  } catch (e) {
    return [];
  }
};

/* When a job last changed, for the conflict rule.
 *
 * `savedAt` is stamped by the panel as it writes, precisely so that a job
 * whose state moved on -- or that was starred an hour after it was made -- is
 * newer than the copy another device holds. The two older fields are the
 * fallback for jobs written before that existed. */
const jobStamp = (job) => Number(job?.savedAt) || Number(job?.finishedAt) || Number(job?.startedAt) || 0;

/**
 * Every record this device holds for one account.
 *
 * Deliberately scoped: the stores are shared between accounts on a machine, so
 * gathering them wholesale would publish the guest's chats and anyone else's
 * into whoever happened to be signed in.
 */
export const collectLocal = async (scope) => {
  const keys = keysFor(scope);
  const out = [];

  const chats = (await localforage.getItem(keys.chats)) || [];
  for (const chat of chats) {
    if (chat?.id == null) continue;
    // By address rather than by value -- see `withoutPictureBytes`.
    // Built lazily: a sync looks at every chat's stamp but uploads only the
    // few that changed, and stripping ~100 MB of chats on every sync (once a
    // second while a reply streams) was most of the time a sync took.
    const record = { kind: 'chat', id: String(chat.id), updatedAt: chat.updatedAt || 0 };
    let built;
    Object.defineProperty(record, 'payload', {
      enumerable: true,
      get: () => (built ??= withoutPictureBytes(chat)),
    });
    out.push(record);
  }

  const documents = (await named('knowledge').getItem(keys.knowledge)) || [];
  for (const doc of documents) {
    if (doc?.id == null) continue;
    out.push({ kind: 'document', id: String(doc.id), updatedAt: doc.addedAt || 0, payload: doc });
  }

  const memories = (await named('memory').getItem(keys.memory)) || [];
  for (const memory of memories) {
    if (memory?.id == null) continue;
    out.push({ kind: 'memory', id: String(memory.id), updatedAt: memory.createdAt || 0, payload: memory });
  }

  // One record per job. See the note above `readJobs`.
  for (const job of readJobs(keys.studioJobs)) {
    out.push({ kind: 'studioJob', id: String(job.id), updatedAt: jobStamp(job), payload: job });
  }

  const stamps = settingStamps(scope);
  for (const [kind, key] of WHOLE_LISTS.map(kind => [kind, keys[kind]])) {
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    out.push({ kind, id: 'all', updatedAt: stamps[key] || 0, payload: raw });
  }

  for (const [key, value] of Object.entries(readScopeSettings(scope))) {
    // Explicit zero marks a boot default, not a user edit. Do not upload it:
    // servers may normalize zero timestamps to their current clock.
    if (stamps[key] === 0) continue;
    out.push({ kind: 'setting', id: key, updatedAt: stamps[key] || 0, payload: value });
  }

  return out;
};

/** Only what has changed since this device last uploaded. */
const localChanges = async (scope) => {
  const sent = readSent(scope);
  const local = await collectLocal(scope);
  const seen = new Set();
  const changed = [];

  for (const record of local) {
    const key = `${record.kind}:${record.id}`;
    seen.add(key);
    if (sent[key] === record.updatedAt) continue;
    /* Which version of the chat this edit was made on: the one this device
       last had in step with the account. The server merges instead of
       replacing when another device wrote after it (server/chatMerge.js).
       -1 is "re-send everything" from an older client, which says nothing. */
    if (record.kind === 'chat' && Number.isFinite(sent[key]) && sent[key] >= 0) record.base = sent[key];
    changed.push(record);
  }

  // Anything uploaded before and gone now was deleted here. Saying so is what
  // makes a deletion reach the other devices instead of being silently undone
  // by whichever of them still has a copy.
  for (const key of Object.keys(sent)) {
    if (seen.has(key)) continue;
    const [kind, ...rest] = key.split(':');
    changed.push({ kind, id: rest.join(':'), updatedAt: Date.now(), deleted: true, payload: null });
  }

  return { changed, local };
};

/* ------------------------------------------------------------ local writes */

/**
 * Put records from the account into this device's stores.
 *
 * Returns what actually changed, not what arrived: the caller decides whether
 * to reload on the strength of it, and counting every incoming record would
 * mean reloading forever against an account that is already in step.
 */
export const applyLocal = async (scope, records) => {
  const keys = keysFor(scope);
  const applied = { chats: 0, settings: 0, documents: 0, memories: 0, lists: 0, studio: 0 };
  if (!records.length) return applied;

  const byKind = (kind) => records.filter(r => r.kind === kind);

  // --- lists of objects, merged by id ---
  const mergeList = async (store, key, kind, stamp, counter) => {
    const incoming = byKind(kind);
    if (!incoming.length) return;

    const existing = (await store.getItem(key)) || [];
    const map = new Map(existing.map(item => [String(item.id), item]));

    for (const record of incoming) {
      if (record.deleted) {
        if (map.delete(record.id)) applied[counter]++;
        continue;
      }
      // A malformed server response must not erase a valid local record.
      if (record.payload === null || record.payload === undefined) continue;
      const current = map.get(record.id);
      // The record only wins if it is genuinely newer. An older copy arriving
      // late — another device catching up — must not undo a local edit.
      if (current && (current[stamp] || 0) > record.updatedAt) continue;
      map.set(record.id, record.payload);
      applied[counter]++;
    }

    const next = [...map.values()].sort((a, b) => (b[stamp] || 0) - (a[stamp] || 0));
    await store.setItem(key, next);
  };

  await mergeList(localforage, keys.chats, 'chat', 'updatedAt', 'chats');
  await mergeList(named('knowledge'), keys.knowledge, 'document', 'addedAt', 'documents');
  await mergeList(named('memory'), keys.memory, 'memory', 'createdAt', 'memories');

  /* --- the gallery, job by job ---
   *
   * The same rule as the chats above it: a record wins only if it is genuinely
   * newer than the copy here, a tombstone removes one, and nothing is counted
   * unless something actually changed. What is different is only where it
   * lands -- one array in localStorage rather than one key per item, because
   * that is the shape the panel reads.
   *
   * Counted as a studio change, which makes the Studio re-read in place. An
   * ordinary list change reloads the page, and a gallery that gains a job
   * every time another device finishes one would reload it constantly. */
  const jobRecords = byKind('studioJob');
  if (jobRecords.length) {
    const before = localStorage.getItem(keys.studioJobs);
    const byId = new Map(readJobs(keys.studioJobs).map(job => [String(job.id), job]));
    const incoming = [];
    for (const record of jobRecords) {
      const id = String(record.id);
      const mine = byId.get(id);
      if (record.deleted) {
        // Forgotten on the other device. Kept here if it has changed here since.
        if (mine && jobStamp(mine) <= record.updatedAt) byId.delete(id);
        continue;
      }
      // Ours is later news. Strictly later: an equal stamp is a tie, and
      // `mergeJobs` settles ties by how far along each copy is, which is the
      // rule that stops a device that last saw a job running from undoing the
      // one that saw it finish.
      if (mine && jobStamp(mine) > record.updatedAt) continue;
      incoming.push(record.payload);
    }
    const merged = trimJobs(mergeJobs([...byId.values()], incoming));
    const next = JSON.stringify(merged);
    if (next !== before) {
      try { localStorage.setItem(keys.studioJobs, next); } catch (e) { /* quota */ }
      applied.studio++;
    }
  }

  /* --- whole lists ---
   *
   * The same rule as everything above: a record only wins if it is genuinely
   * newer, and only a real change is counted.
   *
   * This branch had neither, and the server sends a device's own uploads back
   * to it in the same response. So every write came home as a "change": the
   * echo — a copy of what was uploaded, which can be seconds older than what
   * has been typed since — overwrote the newer local value, was counted, and
   * the count triggered a page reload that then restored the older copy. In
   * the Studio that is the main prompt vanishing between typing it and
   * pressing Generate. */
  const listStamps = settingStamps(scope);
  for (const [kind, key] of WHOLE_LISTS.map(kind => [kind, keys[kind]])) {
    const record = byKind(kind)[0];
    if (!record) continue;
    const localStamp = listStamps[key] || 0;
    const counter = STUDIO_LISTS.has(kind) ? 'studio' : 'lists';

    if (record.deleted) {
      if (localStorage.getItem(key) === null) continue;
      // Edited here after it was deleted there: the edit is the later intent.
      if (localStamp > record.updatedAt) continue;
      localStorage.removeItem(key);
      forgetSettingStamp(scope, key);
      applied[counter]++;
      continue;
    }

    // Our own upload coming back, or an older copy arriving late.
    if (localStamp >= record.updatedAt) continue;
    // Newer by the clock but the same content — record the stamp so the next
    // sync does not send it again, and count nothing, because nothing changed.
    if (localStorage.getItem(key) === record.payload) {
      stampSetting(scope, key, record.updatedAt);
      continue;
    }
    try { localStorage.setItem(key, record.payload); } catch (e) { /* quota */ }
    stampSetting(scope, key, record.updatedAt);
    applied[counter]++;
  }

  // --- settings ---
  const stamps = settingStamps(scope);
  applied.settingKeys = [];
  for (const record of byKind('setting')) {
    if (record.deleted) {
      removeScopedKey(scope, record.id);
      forgetSettingStamp(scope, record.id);
      applied.settings++;
      applied.settingKeys.push(record.id);
      continue;
    }
    // A local change made more recently than this one keeps its place.
    if ((stamps[record.id] || 0) > record.updatedAt) continue;
    const changed = writeScopeSettings(scope, { [record.id]: record.payload });
    applied.settings += changed;
    if (changed) applied.settingKeys.push(record.id);
    stampSetting(scope, record.id, record.updatedAt);
  }

  return applied;
};

/* ------------------------------------------------------------------ the sync */

/**
 * One round trip: send what changed here, take what changed elsewhere.
 *
 * `full` throws away this device's memory of where it had got to, so the whole
 * account comes down again. That is what a new device does, and what the
 * "replace this device from the account" button does.
 */
const applyTouched = (a) => Object.values(a || {}).some(n => Number(n) > 0);

export const syncOnce = async (scope, { full = false, limit = 500, onPhase } = {}) => {
  const ownerId = ownerOfScope(scope);
  if (!ownerId) throw new Error('There is no signed-in account to sync with.');

  if (full) resetSyncPosition(scope);

  // Older clients marked the post-request local state as uploaded, including
  // edits that happened while the request was in flight. Re-send those records
  // once, retaining keys so pending deletions still become tombstones.
  const ackVersionKey = `syncSentAckVersion@${scope}`;
  if (localStorage.getItem(ackVersionKey) !== '2') {
    writeSent(scope, Object.fromEntries(Object.keys(readSent(scope)).map(key => [key, -1])));
    localStorage.setItem(ackVersionKey, '2');
  }

  const since = readRev(scope);
  onPhase?.({ phase: 'preparing' });
  const { changed: pendingChanges, local } = full ? { changed: [], local: [] } : await localChanges(scope);
  const { batch: changed, refused: oversized, remaining } = uploadBatch(pendingChanges);

  let result;
  onPhase?.({ phase: changed.length ? 'uploading' : 'downloading', sending: changed.length });
  try {
    result = await api('/api/auth/sync', {
      method: 'POST',
      body: { since, ownerId, records: changed, limit },
    });
  } catch (e) {
    if (e instanceof ApiError && e.code === 'owner-mismatch') {
      throw new OwnerMismatch(ownerId, e.expected || null);
    }
    throw e;
  }

  // The server answers for the account its session names. If that is not the
  // account on screen, nothing here may be written: this is the check that
  // stops one person's chats being merged into another person's list.
  if (result.ownerId && result.ownerId !== ownerId) {
    throw new OwnerMismatch(ownerId, result.ownerId);
  }

  onPhase?.({ phase: 'applying', received: (result.records || []).length, remaining: result.remaining });
  const applied = await applyLocal(scope, result.records || []);

  // Record where we got to only after the writes landed. Doing it first means a
  // failure loses those records for good — they are below the revision this
  // device will ask from next time.
  writeRev(scope, result.rev || since);

  /* What is now known to be on the server, so the next sync sends only what
   * has changed since. Built from the state after applying, not before.
   *
   * A full sync uploads nothing, so "everything here is on the server" is only
   * true of what the server just sent back at the same timestamp. It used to be
   * assumed of everything, which was harmless while a full sync overwrote every
   * local value with the account's — but an incoming copy no longer wins over
   * a newer local edit, and a newer local edit marked as sent is one that never
   * leaves this device. So in a full sync, only what matches is marked; the
   * rest goes up on the next ordinary one. */
  const refused = new Set((result.refused || []).map(r => `${r.kind}:${r.id}`));
  const refusalListComplete = (result.refusedCount || 0) <= refused.size;
  const uploaded = new Map(changed.filter(r => !refused.has(`${r.kind}:${r.id}`) && refusalListComplete).map(r => [`${r.kind}:${r.id}`, r.updatedAt]));
  const onServer = new Map((result.records || []).map(r => [`${r.kind}:${r.id}`, r.updatedAt]));
  const sent = readSent(scope);
  for (const record of changed) {
    const key = `${record.kind}:${record.id}`;
    if (record.deleted && uploaded.get(key) === record.updatedAt) delete sent[key];
  }
  // Re-reading every store only matters when this sync wrote into them;
  // otherwise the snapshot from before the upload has the same stamps, and an
  // edit made mid-flight just stays unmarked and goes up next time.
  const afterApply = (full || applyTouched(applied)) ? await collectLocal(scope) : local;
  for (const record of afterApply) {
    const key = `${record.kind}:${record.id}`;
    if (uploaded.get(key) === record.updatedAt || onServer.get(key) === record.updatedAt) {
      sent[key] = record.updatedAt;
    }
  }
  writeSent(scope, sent);

  return {
    applied,
    sent: changed.length,
    rejected: result.rejected || 0,
    /* What the server would not store, and why. Not an error -- the rest of
       the batch landed -- but not silence either: a record that cannot sync
       will never sync, and the only way anyone finds out is if it is said.
       See `applyChanges` in server/records.js. */
    refused: [...oversized, ...(result.refused || [])],
    refusedCount: oversized.length + (result.refusedCount || 0),
    rev: result.rev || since,
    complete: result.complete !== false && remaining === 0,
    received: (result.records || []).length,
    // Records still waiting above the cursor, when the server says (older
    // servers do not, and the caller falls back to revisions).
    remaining: Number.isFinite(result.remaining) ? result.remaining : null,
    // Whether anything the user would notice actually changed here.
    changedLocally: applied.chats + applied.settings + applied.documents
      + applied.memories + applied.lists + applied.studio,
    localCount: local.length,
  };
};

/**
 * Sync until the server says there is nothing left.
 *
 * A first sync on a large account comes down in pages, so one round trip is not
 * enough to be in step. The page cap is what keeps a slow connection from
 * having to hold one enormous request open.
 */
export const syncFully = async (scope, { full = false, maxRounds = 20, limit = 500, onProgress } = {}) => {
  let total = null;
  let receivedSoFar = 0;
  for (let round = 0; round < maxRounds; round++) {
    const result = await syncOnce(scope, {
      full: full && round === 0,
      limit,
      // Said as it happens, not after the round: a round on a phone can take
      // many seconds, and silence for that long reads as a hang.
      onPhase: (p) => onProgress?.({ ...p, round, receivedSoFar: receivedSoFar + (p.received || 0) }),
    });
    receivedSoFar += result.received;
    onProgress?.({
      phase: result.complete ? 'done' : 'downloading',
      round,
      rev: result.rev,
      complete: result.complete,
      received: result.received,
      receivedSoFar,
      remaining: result.remaining,
    });
    total = total ? {
      ...result,
      applied: {
        chats: total.applied.chats + result.applied.chats,
        settings: total.applied.settings + result.applied.settings,
        settingKeys: [...new Set([...(total.applied.settingKeys || []), ...(result.applied.settingKeys || [])])],
        documents: total.applied.documents + result.applied.documents,
        memories: total.applied.memories + result.applied.memories,
        lists: total.applied.lists + result.applied.lists,
        studio: (total.applied.studio || 0) + (result.applied.studio || 0),
      },
      changedLocally: total.changedLocally + result.changedLocally,
      received: total.received + result.received,
      sent: total.sent + result.sent,
      // Gathered across the rounds, or a refusal in the first one is lost.
      refused: [...total.refused, ...result.refused].slice(0, 20),
      refusedCount: total.refusedCount + result.refusedCount,
    } : result;
    if (result.complete) break;
  }
  return total;
};

/* --------------------------------------------------- first sync on a device */

const firstSyncKey = (scope) => `initialSyncPending@${scope}`;

/** Whether this device has never finished a sync with this account. */
export const needsInitialSync = (scope) => {
  if (!ownerOfScope(scope)) return false;
  try {
    const state = localStorage.getItem(firstSyncKey(scope));
    if (state === '1') return true;
    if (state === '0') return false; // Empty accounts can complete at revision zero.
  } catch (e) { /* private mode */ }
  return readRev(scope) === 0;
};

export const markInitialSync = (scope, pending) => {
  try {
    if (pending) localStorage.setItem(firstSyncKey(scope), '1');
    else localStorage.setItem(firstSyncKey(scope), '0');
  } catch (e) { /* private mode */ }
};

/**
 * Percent of the account this device has caught up with.
 *
 * Revisions are a cursor that only moves forward and ends at the account's
 * current one, so where the cursor stands against that target is the progress.
 */
export const syncPercent = (rev, target, complete, counts = null) => {
  if (complete) return 100;
  // Counted records, when the server reports what is left. Revisions are not
  // spread evenly over records, so a revision-based bar sat at 0% and leapt.
  const done = Number(counts?.receivedSoFar);
  const left = Number(counts?.remaining);
  if (Number.isFinite(done) && Number.isFinite(left) && done + left > 0 && counts.remaining !== null) {
    return Math.max(0, Math.min(99, Math.floor(done / (done + left) * 100)));
  }
  if (!(target > 0)) return 0;
  return Math.max(0, Math.min(99, Math.floor((Number(rev) || 0) / target * 100)));
};

/**
 * Where a first sync is, in words the screen can show.
 *
 * Returns an i18n key and its values; `counts` is the latest progress report.
 */
export const syncStage = (p = {}) => {
  const done = Number(p.receivedSoFar) || 0;
  const left = Number.isFinite(p.remaining) ? p.remaining : null;
  switch (p.phase) {
    case 'connecting': return { key: 'sync.stage.connecting' };
    case 'preparing': return { key: 'sync.stage.preparing' };
    case 'uploading': return { key: 'sync.stage.uploading', values: { count: p.sending || 0 } };
    case 'applying': return { key: 'sync.stage.applying', values: { done, total: left === null ? '?' : done + left } };
    case 'done': return { key: 'sync.stage.finishing' };
    case 'downloading':
    default:
      if (done > 0 && left !== null) return { key: 'sync.stage.downloadingCount', values: { done, total: done + left } };
      return { key: 'sync.stage.downloading' };
  }
};

/* ------------------------------------------------------------ live changes */

/**
 * Be told when the account changes, instead of asking.
 *
 * Asking is what this replaces and it was never good enough on a phone. The
 * poll is on a timer, and a browser freezes the timers of a page that is not
 * visible -- which, on a phone, is whenever the screen is off or another app
 * is in front. So a change made on one device reached the other on its next
 * poll after being looked at, if the poll had not been throttled away
 * entirely. Two windows of one desktop browser hid this completely: they share
 * one local database and read each other's writes directly, so they looked
 * instant while nothing was syncing at all.
 *
 * `onRev` is called with the account's new revision. Nothing is downloaded
 * here -- the caller decides whether that revision is news and fetches through
 * the ordinary sync if it is.
 *
 * Returns a function that closes the stream. If the browser has no
 * `EventSource`, or the server has no such route, nothing is opened and the
 * caller's polling remains the only mechanism -- which is why the poll stays.
 */
export const subscribeToAccount = ({ onRev, onOpen, onClose } = {}) => {
  if (typeof EventSource === 'undefined') return () => {};

  let source = null;
  let stopped = false;
  let retry = null;

  const open = () => {
    if (stopped) return;
    // The session id names which of the browser's sessions this tab acts as.
    // It has to go in the URL because EventSource cannot set a header; it is
    // not a credential (see the route's comment), and it is read fresh on
    // every reconnect because a tab can be handed a new session at any time.
    const url = `/api/auth/events?session=${encodeURIComponent(currentTabSession() || 'new')}`;
    source = new EventSource(url);

    // A (re)connect is also a moment of not knowing what was missed while
    // the stream was down, so the caller is asked to check.
    source.addEventListener('open', () => { if (!stopped) onOpen?.(); });

    source.addEventListener('rev', (event) => {
      if (stopped) return;
      let data;
      try { data = JSON.parse(event.data); } catch (e) { return; }
      const rev = Number(data?.rev) || 0;
      if (!rev) return;
      // The upload that caused this was ours. We already have everything in
      // it, and fetching it back would be a round trip to learn nothing.
      if (data.origin && data.origin === currentTabSession()) return;
      onRev?.(rev);
    });

    // EventSource reconnects on its own, but not after the server ends the
    // stream cleanly -- which is what it does for a request with no session.
    // Reconnecting anyway would be a request per second against a signed-out
    // app, so the retry is ours, and slow.
    source.addEventListener('error', () => {
      if (stopped) return;
      source?.close();
      source = null;
      onClose?.();
      retry = setTimeout(open, 20000);
    });
  };

  /* A phone that comes back is the moment the stream matters most, and the
     moment it is most likely to be down: the network dropped it while the
     screen was off, and the 20-second retry timer was frozen with the page.
     So being looked at, or getting a network back, reconnects at once. */
  const wake = () => {
    if (stopped || document.hidden || source) return;
    if (retry) { clearTimeout(retry); retry = null; }
    open();
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', wake);

  open();

  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    document.removeEventListener('visibilitychange', wake);
    window.removeEventListener('online', wake);
    window.removeEventListener('pageshow', wake);
    source?.close();
    source = null;
  };
};

/** Where the account stands, without downloading anything. */
export const accountStamp = async () => {
  try {
    const stats = await api('/api/auth/stats');
    return { rev: stats.rev || 0, ownerId: stats.ownerId, savedAt: stats.savedAt, chats: stats.chats };
  } catch (e) {
    return null;
  }
};

/* ---------------------------------------------------------------- scheduler */

/**
 * A sync that waits for the dust to settle.
 *
 * Chats change on every token of a streaming reply, so coalescing is what keeps
 * this from being one request per token. `scope` is read at sync time rather
 * than captured: the account can change while one is pending, and the value
 * that matters is the one in effect when the records are gathered.
 */
export const createSyncScheduler = ({
  delay = 4000, maxDelay = 0, scope, onResult, onError, onOwnerMismatch,
} = {}) => {
  let timer = null;
  let queued = false;
  let stopped = false;

  // When the oldest un-uploaded change was made, or 0 when there is none.
  //
  // Coalescing without a ceiling is not coalescing, it is postponement: each
  // new change pushes the timer out by the full delay, so a change every few
  // hundred milliseconds means the timer never fires at all. A streaming reply
  // is exactly that, and the result was that the other devices saw the empty
  // placeholder and then nothing until the answer had finished -- "Thinking..."
  // for as long as the model took. `maxDelay` is the promise that a change will
  // be sent within that long however busy things are.
  let pendingSince = 0;

  // The sync in flight, or null. Holding the promise rather than a boolean lets
  // a second caller *wait* for it instead of being told someone else is doing
  // it and moving on — which matters at sign-out, where whether the last upload
  // landed decides whether this device's cache can be cleared.
  let inFlight = null;

  const once = async () => {
    const at = scope?.();
    // An unresolved or guest scope means there is nothing to sync and no
    // account to sync it to. Doing nothing is correct, and successful.
    if (!ownerOfScope(at)) return true;
    try {
      onResult?.(await syncFully(at));
      return true;
    } catch (e) {
      if (e instanceof OwnerMismatch) {
        // Stop. Every further attempt would be equally wrong, and retrying is
        // how a confused client turns one bad upload into a loop of them.
        stopped = true;
        onOwnerMismatch?.(e);
      } else {
        onError?.(e);
      }
      return false;
    }
  };

  const run = async () => {
    if (stopped) return false;
    if (inFlight) { queued = true; return inFlight; }
    // Cleared as the upload starts, not when it lands: changes made *during*
    // it are new, and their ceiling should be measured from now.
    pendingSince = 0;
    inFlight = once();
    let succeeded = false;
    try {
      succeeded = await inFlight;
      return succeeded;
    } finally {
      inFlight = null;
      if (!succeeded && !stopped) {
        // A quiet desktop still has unsent chats after a failed upload. Server
        // revision polling cannot detect these local-only changes.
        queued = false;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; run(); }, 5000);
      } else if (queued && !stopped) { queued = false; schedule(); }
    }
  };

  const schedule = () => {
    if (stopped) return;
    const now = Date.now();
    if (!pendingSince) pendingSince = now;

    // The ceiling, enforced here and not only by the timer, because a hidden
    // page's timers are throttled and this call is not. See `isOverdue`.
    if (isOverdue(now, pendingSince, maxDelay)) {
      if (timer) { clearTimeout(timer); timer = null; }
      run();
      return;
    }

    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; run(); },
      waitFor(now, pendingSince, delay, maxDelay));
  };

  return {
    schedule,
    /**
     * Whether a sync is queued or in flight.
     *
     * The remote-change poll asks, because the two race: a sync can land on the
     * server before its result has come back here, and the poll then reads a
     * revision newer than anything this device has recorded and concludes some
     * other device changed something.
     */
    pending: () => inFlight !== null || timer !== null,
    /** Sync now, and report whether the account really is up to date. */
    flush: async () => {
      if (timer) { clearTimeout(timer); timer = null; }
      return run();
    },
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      pendingSince = 0;
      stopped = true;
    },
  };
};
