// src/chatStore.js: one record per chat, written only where something changed.
//
//   node scripts/chatstore.test.mjs
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${name}`); } else { failed++; console.log(`FAIL  ${name}  -> ${detail}`); }
};

/* An in-memory localforage: one Map per (database, store), structured-cloned
   like IndexedDB so a shared reference cannot pass for a write. */
const dbs = new Map();
const ops = { set: 0, get: 0, remove: 0 };
const inst = (name, storeName) => {
  const id = `${name}/${storeName}`;
  if (!dbs.has(id)) dbs.set(id, new Map());
  const m = dbs.get(id);
  return {
    getItem: async (k) => { ops.get++; return m.has(k) ? structuredClone(m.get(k)) : null; },
    setItem: async (k, v) => { ops.set++; m.set(k, structuredClone(v)); return v; },
    removeItem: async (k) => { ops.remove++; m.delete(k); },
    keys: async () => [...m.keys()],
    iterate: async (fn) => { for (const [k, v] of m) fn(structuredClone(v), k); },
  };
};
globalThis.__forageStub = { ...inst('ollama-webui', 'keyvaluepairs'), createInstance: ({ name, storeName }) => inst(name, storeName) };

const stub = path.resolve(HERE, '../node_modules/.localforage-chatstore-stub.mjs');
fs.writeFileSync(stub, 'export default globalThis.__forageStub;\n');
const bundle = await rolldown({ input: path.resolve(HERE, '../src/chatStore.js'), platform: 'neutral', resolve: { alias: { localforage: stub } } });
const file = path.resolve(HERE, '../node_modules/.chatstore-test.mjs');
await bundle.write({ file, format: 'esm' });
await bundle.close();
const S = await import(pathToFileURL(file).href);

const KEY = 'ollama-sessions:srv-a';
const legacy = dbs.get('ollama-webui/keyvaluepairs');
const chats = () => dbs.get('ollama-webui-chats/chats') || new Map();
const chat = (id, t, content = 'hi') => ({ id, title: `c${id}`, updatedAt: t, messages: [{ role: 'user', content }] });

// --- off: the old single value, untouched ---
legacy.set(KEY, [chat(1, 10), chat(2, 20)]);
check('disabled reads the single value', (await S.readChats(KEY)).length === 2);

// --- on: legacy is read where it is until the first write ---
S.enableSplitChatStore(true);
const first = await S.readChats(KEY);
check('enabled still reads an unmigrated profile', first.length === 2 && first[0].id === 2);
check('reading alone does not migrate', legacy.has(KEY));

// --- first write migrates and removes the old value ---
await S.writeChats(KEY, first);
check('first write moves each chat to its own record', chats().has(`${KEY}\u00011`) && chats().has(`${KEY}\u00012`));
check('and writes the index', !!chats().get(`${KEY}\u0000index`)?.items);
check('and removes the single value', !legacy.has(KEY));

// --- an edit to one chat writes one chat ---
let list = await S.readChats(KEY);
ops.set = 0;
await S.writeChats(KEY, [chat(2, 30, 'edited'), list[1]]);
check('editing one chat writes that chat and the index only', ops.set === 2, `set=${ops.set}`);

// --- equal content in fresh objects is not a change ---
list = await S.readChats(KEY);
ops.set = 0;
await S.writeChats(KEY, list.map(c => ({ ...c, messages: c.messages.map(m => ({ ...m })) })));
check('copies with equal fields write nothing but the index', ops.set === 1, `set=${ops.set}`);

// --- fresh objects at every depth (what externalizeChat does on a real account) ---
await S.writeChats(KEY, (await S.readChats(KEY)).map(c => ({ ...c, messages: c.messages.map(m => ({ ...m, attachments: [{ name: 'a.png', data: 'x' }] })) })));
ops.set = 0;
await S.writeChats(KEY, (await S.readChats(KEY)).map(c => structuredClone(c)));
check('deeply rebuilt but equal chats write nothing but the index', ops.set === 1, `set=${ops.set}`);

// --- an in-place edit is still caught ---
list = await S.readChats(KEY);
ops.set = 0;
const mutated = list.map(c => c);
mutated[0].messages = [...mutated[0].messages, { role: 'assistant', content: 'new' }];
await S.writeChats(KEY, mutated);
check('a chat edited in place is still written', ops.set === 2, `set=${ops.set}`);

// --- deletion ---
await S.writeChats(KEY, (await S.readChats(KEY)).filter(c => c.id !== 1));
check('a chat left out is removed', !chats().has(`${KEY}\u00011`) && (await S.readChats(KEY)).length === 1);

// --- another tab's write is seen through the index ---
const idx = chats().get(`${KEY}\u0000index`);
chats().set(`${KEY}\u00019`, chat(9, 99));
chats().set(`${KEY}\u0000index`, { v: 1, items: { ...idx.items, 9: 'other-tab' } });
ops.get = 0;
const seen = await S.readChats(KEY);
check('another tab\'s new chat is read', seen.some(c => c.id === 9) && seen[0].id === 9);
check('fetching only what moved (index + one chat + old-value probe)', ops.get === 3, `get=${ops.get}`);
const again = await S.readChats(KEY);
check('nothing moved: same list object back', again === seen);

// --- a fresh page finds an orphan record (index write lost) ---
chats().set(`${KEY}\u000177`, chat(77, 5));
S.forgetHeldChats();
check('a cold read keeps a record the index missed', (await S.readChats(KEY)).some(c => c.id === 77));

// --- enumeration and removal ---
check('split lists are enumerated', (await S.splitChatLists()).includes(KEY));
await S.removeChats(KEY);
check('removing clears every record and the index', [...chats().keys()].every(k => !k.startsWith(KEY)) && (await S.readChats(KEY)).length === 0);

// --- serialised writes keep the last one ---
await Promise.all([S.writeChats(KEY, [chat(1, 1)]), S.writeChats(KEY, [chat(1, 2), chat(2, 2)])]);
S.forgetHeldChats();
const last = await S.readChats(KEY);
check('concurrent writes apply in order', last.length === 2 && last.find(c => c.id === 1).updatedAt === 2);

// --- an old-version tab writes the single value after migration ---
legacy.set(KEY, [chat(1, 50, 'from old tab'), chat(5, 60)]);
const mixed = await S.readChats(KEY);
check("an old tab's later single value is folded in", mixed.length === 3 && mixed.find(c => c.id === 1).updatedAt === 50 && mixed.some(c => c.id === 5));
await S.writeChats(KEY, mixed);
check('and moved on the next write', chats().has(`${KEY}\u00015`) && !legacy.has(KEY));
S.forgetHeldChats();
check('and kept after a fresh read', (await S.readChats(KEY)).length === 3);

// --- read-merge-write is one step: a sync page landing mid-save survives ---
await S.writeChats(KEY, [chat(1, 1)]);
const slowSave = S.updateChats(KEY, async (current) => {
  await new Promise(r => setTimeout(r, 50));           // the save is busy (externalising, merging)
  return [...current, chat(2, 2)];
});
const syncPage = S.updateChats(KEY, (current) => [...current, chat(3, 3)]); // the sync lands meanwhile
await Promise.all([slowSave, syncPage]);
S.forgetHeldChats();
const both = (await S.readChats(KEY)).map(c => c.id).sort();
check('a page written during a save is not lost', JSON.stringify(both) === '[1,2,3]', JSON.stringify(both));
const untouched = await S.updateChats(KEY, () => null);
check('returning null writes nothing', Array.isArray(untouched) && untouched.length === 3);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
