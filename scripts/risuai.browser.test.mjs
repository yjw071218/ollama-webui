import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8, gzipSync } from 'fflate';
import { createRisuRoutes } from '../server/risuai.js';
import { launchChrome } from './chromeProfile.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createRisuSyncHandler } from '../server/risuSync.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = path.join(root, 'integrations/risuai/upstream');
const require = createRequire(path.join(upstream, 'package.json'));
const { encode } = require('msgpackr');
const rpack = fs.readFileSync(path.join(upstream, 'src/ts/rpack/rpack_map.bin'));
const pack = data => Uint8Array.from(data, byte => rpack[byte]);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const wav = Buffer.alloc(44 + 1600);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(1600, 40);
const card = {
  spec: 'chara_card_v3', spec_version: '3.0',
  data: {
    name: '에셋 검증 캐릭터', description: 'A friendly lighthouse keeper.', personality: 'Kind',
    scenario: 'A lighthouse in the rain.', first_mes: 'CHARX_GREETING {{img::한글 표정}} {{audio::목소리}} {{#if {{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-5}}}}}}CBS_VISIBLE{{/if}} {{#if 0}}CBS_HIDDEN{{/if}}',
    mes_example: '{{user}}: Hello\n{{char}}: Welcome.', creator_notes: '', system_prompt: 'Stay in character.',
    post_history_instructions: '', alternate_greetings: ['SECOND_GREETING'], tags: [], creator: 'WebUI test', character_version: '1',
    character_book: { entries: [{ keys: ['lighthouse'], content: 'LORE_TEST', enabled: true, insertion_order: 1, extensions: {} }] },
    extensions: { risuai: { customScripts: [{ in: 'CHARX_GREETING', out: '@@move_top {{#if {{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-5}}}}}}CHARX_GREETING CBS_SCRIPT_VISIBLE{{/if}}', type: 'editdisplay' }], triggerscript: [] } },
    assets: [
      { type: 'icon', uri: 'embeded://assets/icon/main.png', name: 'main', ext: 'png' },
      { type: 'x-risu-asset', uri: 'embeded://assets/한글 표정.png', name: '한글 표정', ext: 'png' },
      { type: 'x-risu-asset', uri: 'embeded://assets/목소리.wav', name: '목소리', ext: 'wav' },
    ],
  },
};
const moduleData = pack(strToU8(JSON.stringify({ type: 'risuModule', module: { name: 'MODULE_TEST', description: 'Test', id: 'fixture', lorebook: [{ key: 'lighthouse', content: 'LORE_TEST', mode: 'normal', insertorder: 1, alwaysActive: false, selective: false }], regex: card.data.extensions.risuai.customScripts, trigger: [] } })));
const moduleHeader = Buffer.alloc(6); moduleHeader[0] = 111; moduleHeader.writeUInt32LE(moduleData.length, 2);
const risum = Buffer.concat([moduleHeader, moduleData, Buffer.from([0])]);
const charx = zipSync({ 'card.json': strToU8(JSON.stringify(card)), 'module.risum': risum, 'assets/icon/main.png': png, 'assets/한글 표정.png': png, 'assets/목소리.wav': wav });
const pngCard = structuredClone(card);
pngCard.data.name = 'PNG 검증 캐릭터'; pngCard.data.first_mes = 'PNG_GREETING {{img::한글 표정}}';
pngCard.data.assets = [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }, { type: 'x-risu-asset', uri: '__asset:0', name: '한글 표정', ext: 'png' }];
const crc32 = require('crc').crc32;
function textChunk(key, value) {
  const content = Buffer.from(key + '\0' + value);
  const chunk = Buffer.alloc(content.length + 12);
  chunk.writeUInt32BE(content.length); chunk.write('tEXt', 4); content.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)) >>> 0, chunk.length - 4);
  return chunk;
}
const cardPng = Buffer.concat([png.subarray(0, -12), textChunk('ccv3', Buffer.from(JSON.stringify(pngCard)).toString('base64')), textChunk('chara-ext-asset_:0', png.toString('base64')), png.subarray(-12)]);
async function preset(name, packed) {
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', strToU8('risupreset')), 'AES-GCM', false, ['encrypt']);
  const value = { name, temperature: 81, top_p: 0.91, promptTemplate: [{ type: 'plain', type2: 'main', text: 'PRESET_TEST', role: 'system' }] };
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, encode(value));
  const bytes = gzipSync(encode({ presetVersion: 2, type: 'preset', preset: encrypted }));
  return packed ? pack(bytes) : bytes;
}
const fixtures = {
  'unicode.CHARX': charx,
  'legacy.risupreset': await preset('LEGACY_PRESET_TEST', false),
  'packed.risup': await preset('RPACK_PRESET_TEST', true),
  'embedded.png': cardPng,
  'module.risum': risum,
  'broken.charx': strToU8('not a zip'),
};
if (process.env.RISU_TEST_PRESET) fixtures['user-preset.risup'] = fs.readFileSync(process.env.RISU_TEST_PRESET);
const [{ handler }] = createRisuRoutes();
// Seed only disposable test profiles; production keeps the first-use dialog.
const shell = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style><script>for(const scope of ['browser-test','another-account'])localStorage.setItem('webui-risu:'+scope+':tos4','true');window.results=[];window.addEventListener('message',e=>{if(e.origin===location.origin)results.push(e.data)});</script><iframe src="/risuai/?scope=browser-test&model=test-model"></iframe>`;
const requests = [];
const syncDb = new DatabaseSync(':memory:');
syncDb.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('browser-account');");
const syncHandler = createRisuSyncHandler({ db: () => syncDb, guard: (req, res) => {
  if (req.headers['x-session-id'] === 'sync-test-session') return { user: { id: 'browser-account' } };
  res.writeHead(401); res.end('{}'); return null;
} });
const chats = [];
const server = http.createServer(async (req, res) => {
  requests.push(req.url);
  if (req.url.startsWith('/api/risu/sync')) return syncHandler(req, res);
  if (['/api/tags', '/risuai/ollama/api/tags'].includes(req.url)) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ models: [{ name: 'fake:cloud', remote_model: 'fake' }, { name: 'nomic-embed-text' }, { name: 'test-model' }, { name: 'other-local' }] })); return; }
  if (req.url === '/risuai/ollama/api/chat') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    chats.push(request);
    const reply = { model: request.model, message: { role: 'assistant', content: 'ROLEPLAY_REPLY_TEST' }, done: true };
    res.setHeader('Content-Type', request.stream ? 'application/x-ndjson' : 'application/json');
    if (request.stream) {
      for (const content of ['ROLEPLAY_REPLY_TEST ', '<0x', 'ED><0x95>', '<0xA5>']) res.write(JSON.stringify({ ...reply, message: { role: 'assistant', content }, done: false }) + '\n');
      res.end(JSON.stringify({ ...reply, message: { role: 'assistant', content: '' } }) + '\n');
    } else res.end(JSON.stringify({ ...reply, message: { role: 'assistant', content: 'ROLEPLAY_REPLY_TEST <0xED><0x95><0xA5>' } }));
    return;
  }
  if (req.url.startsWith('/risuai')) return handler(req, res);
  if (req.url.startsWith('/fixture/')) { res.end(fixtures[decodeURIComponent(req.url.slice(9))]); return; }
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(shell); return; }
  if (req.url === '/api/auth/session') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, user: null, sessionId: null, csrfToken: null, state: null, anyAccounts: false, accounts: [] })); return; }
  if (req.url === '/api/config') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, canonicalOrigin: '' })); return; }
  if (req.url === '/host' || req.url.startsWith('/assets/')) {
    const file = path.join(root, 'dist', req.url === '/host' ? 'index.html' : req.url.slice(1));
    if (fs.existsSync(file)) {
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream');
      fs.createReadStream(file).pipe(res); return;
    }
  }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = [process.env.SMOKE_BROWSER, `${process.env.ProgramFiles}/Google/Chrome/Application/chrome.exe`, `${process.env['ProgramFiles(x86)']}/Microsoft/Edge/Application/msedge.exe`, '/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => p && fs.existsSync(p));
assert.ok(browser, 'Chrome/Edge required for the RisuAI integration test');
const debugPort = 9497;
const chrome = launchChrome(browser, 'webui-chrome-risu-', ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${debugPort}`]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws;
try {
  let target;
  for (let i = 0; i < 60; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(x => x.type === 'page'); } catch { /* starting */ }
    if (target) break;
    await sleep(250);
  }
  assert.ok(target, 'Browser debugging connection');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text);
    return response.result?.result?.value;
  };
  const until = async (expression, label, timeout = 45000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) { if (await evaluate(expression)) return; await sleep(250); }
    throw new Error(`${label}: timed out\n${errors.join('\n')}\n${await evaluate("JSON.stringify(window.results?.filter(x=>x.syncState).slice(-3))")}\n${await evaluate("(document.querySelector('iframe')?.contentDocument?.body || document.body).innerText.slice(-2000)")}`);
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: origin });
  await until('window.results?.some(x=>x.ready)', 'RisuAI loads');
  console.log('PASS RisuAI boots in the embedded frame');
  await until("results.some(x=>x.modelState&&x.model==='test-model')", 'Local model automatically selected');
  assert.ok(await evaluate("document.querySelector('iframe').contentDocument.body.innerText.includes('내 캐릭터')"));
  console.log('PASS integrated character home and automatic local model connection');
  const importFile = async name => {
    const id = 'file-' + name;
    await evaluate(`(async()=>{const file=new File([await (await fetch('/fixture/'+${JSON.stringify(name)})).arrayBuffer()],${JSON.stringify(name)});document.querySelector('iframe').contentWindow.postMessage({channel:'webui-risu',action:'import',id:${JSON.stringify(id)},file},location.origin)})()`);
    await until(`results.some(x=>x.id===${JSON.stringify(id)})`, `import ${name}`);
    return evaluate(`results.find(x=>x.id===${JSON.stringify(id)})`);
  };
  const imported = await importFile('unicode.CHARX');
  assert.equal(imported.ok, true, JSON.stringify(imported));
  await until("document.querySelector('iframe').contentDocument.body.innerText.includes('CHARX_GREETING')", 'Greeting visible');
  await until("document.querySelector('iframe').contentDocument.body.innerText.includes('CBS_VISIBLE')", 'Nested CBS conditional evaluates');
  await until("document.querySelector('iframe').contentDocument.body.innerText.includes('CBS_SCRIPT_VISIBLE')", 'Display-script CBS is evaluated after insertion');
  assert.equal(await evaluate("document.querySelector('iframe').contentDocument.body.innerText.includes('{{#if') || document.querySelector('iframe').contentDocument.body.innerText.includes('CBS_HIDDEN')"), false);
  await until("[...document.querySelector('iframe').contentDocument.querySelectorAll('img')].some(x=>x.src.startsWith('blob:')&&x.complete&&x.naturalWidth>0)", 'Embedded PNG displayed');
  const characterId = await evaluate("document.querySelector('iframe').contentDocument.querySelector('[data-char-id]').dataset.charId");
  await until("document.querySelector('iframe').contentDocument.querySelector('audio')?.readyState > 0", 'Embedded WAV metadata loaded');
  console.log('PASS CHARX with Korean asset names imports and renders its image');
  console.log('PASS embedded WAV loads with its actual media type');
  await evaluate(`(()=>{const w=document.querySelector('iframe').contentWindow;const field=w.document.querySelector('textarea.text-input-area');field.value='Tell me about the lighthouse';field.dispatchEvent(new w.Event('input',{bubbles:true}));})()`);
  await evaluate("document.querySelector('iframe').contentDocument.querySelector('.button-icon-send').click()");
  await until("document.querySelector('iframe').contentDocument.body.innerText.includes('ROLEPLAY_REPLY_TEST')", 'Local model roleplay reply');
  await until("document.querySelector('iframe').contentDocument.body.innerText.includes('ROLEPLAY_REPLY_TEST 핥')", 'Split byte fallback becomes Korean');
  assert.equal(chats.at(-1).model, 'test-model');
  assert.equal(chats.at(-1).stream, true);
  assert.equal(chats.at(-1).think, false);
  assert.equal(chats.at(-1).keep_alive, '15m');
  assert.ok(chats.at(-1).options.num_ctx <= 32768);
  assert.ok(chats.at(-1).options.num_predict <= 2048);
  assert.ok(chats.at(-1).messages.some(x => x.content.includes('lighthouse')));
  assert.ok(chats.at(-1).messages.some(x => x.content.includes('LORE_TEST')), 'Character lore enters the model prompt');
  assert.equal(chats.at(-1).options.temperature, 0.8);
  console.log('PASS local inference receives character lore and sampling options and renders a reply');
  await evaluate("Object.defineProperty(document.querySelector('iframe').contentWindow.crypto,'subtle',{value:undefined,configurable:true})");
  for (const name of ['legacy.risupreset', 'packed.risup', ...(process.env.RISU_TEST_PRESET ? ['user-preset.risup'] : [])]) {
    const result = await importFile(name);
    assert.equal(result.ok, true, JSON.stringify(result));
    console.log('PASS encrypted preset without SubtleCrypto ' + name);
  }
  assert.equal((await importFile('module.risum')).ok, true);
  assert.equal((await importFile('embedded.png')).ok, true);
  await until("document.querySelector('iframe').contentDocument.body.innerText.includes('PNG_GREETING')", 'PNG embedded card greeting');
  await until("[...document.querySelector('iframe').contentDocument.querySelectorAll('.risu-chat img')].some(x=>x.src.startsWith('blob:')&&x.naturalWidth>0)", 'PNG chunk asset decoded');
  console.log('PASS RISUM module and PNG card with embedded asset chunks');
  const broken = await importFile('broken.charx');
  assert.equal(broken.ok, false);
  console.log('PASS corrupt import is reported as a failure');
  assert.equal(requests.some(x => x.startsWith('/sw/')), false, 'No collision with host service worker');
  await sleep(2500);
  await evaluate("results=[]; document.querySelector('iframe').src='/risuai/?scope=another-account&model=test-model'");
  await until('results.some(x=>x.ready)', 'Other account boots');
  assert.equal(await evaluate(`!!document.querySelector('iframe').contentDocument.querySelector('[data-char-id="${characterId}"]')`), false);
  console.log('PASS account storage isolation');
  await evaluate("results=[]; document.querySelector('iframe').src='/risuai/?scope=browser-test&model=other-local'");
  await until('results.some(x=>x.ready)', 'Saved account boots');
  assert.equal(await evaluate("localStorage.getItem('webui-risu:browser-test:last-ollama-model')"), 'test-model');
  await until("results.some(x=>x.modelState&&x.model==='test-model')", 'Remembered model restored');
  await until(`!!document.querySelector('iframe').contentDocument.querySelector('[data-char-id="${characterId}"]')`, 'Imported character survives reload');
  await evaluate(`document.querySelector('iframe').contentDocument.querySelector('[data-char-id="${characterId}"]').click()`);
  await until("document.querySelector('iframe').contentDocument.body.innerText.includes('ROLEPLAY_REPLY_TEST')", 'Saved roleplay conversation reloads');
  console.log('PASS imported character persists after reload');
  await evaluate("document.querySelector('iframe').contentWindow.postMessage({channel:'webui-risu',action:'session',session:{id:'sync-test-session'}},location.origin)");
  await until("results.some(x=>x.syncState==='synced')", 'Desktop uploads snapshot');
  await evaluate("localStorage.setItem('webui-risu:mobile-test:tos4','true');results=[];document.querySelector('iframe').src='/risuai/?scope=mobile-test&model=test-model'");
  await until('results.some(x=>x.ready)', 'Independent mobile storage boots');
  await evaluate("document.querySelector('iframe').contentWindow.postMessage({channel:'webui-risu',action:'session',session:{id:'sync-test-session'}},location.origin)");
  await until("results.some(x=>x.syncState==='synced')", 'Mobile downloads snapshot');
  await until(`!!document.querySelector('iframe').contentDocument.querySelector('[data-char-id="${characterId}"]')`, 'Synced character available on mobile');
  await evaluate(`document.querySelector('iframe').contentDocument.querySelector('[data-char-id="${characterId}"]').click()`);
  await until("document.querySelector('iframe').contentDocument.body.innerText.includes('ROLEPLAY_REPLY_TEST 핥')", 'Desktop conversation restored on mobile');
  await until("[...document.querySelector('iframe').contentDocument.querySelectorAll('img')].some(x=>x.src.startsWith('blob:')&&x.naturalWidth>0)", 'Synced character assets render');
  console.log('PASS separate device storage receives account conversation and binary assets');
  // Model/settings changes from another device must survive a mobile bfcache
  // restore and affect the next actual generation request.
  const syncUrl = origin + '/api/risu/sync';
  const syncHeaders = { 'X-Session-Id': 'sync-test-session', 'Content-Type': 'application/json' };
  let shared = await (await fetch(syncUrl, { headers: syncHeaders })).json();
  assert.ok(shared.data.settings, 'Active settings are included in uploaded snapshots');
  while (shared.data.characters.length < 5) {
    shared.data.characters.push({ ...structuredClone(shared.data.characters[0]), chaId: 'sync-library-' + shared.data.characters.length });
  }
  await evaluate('results=[]');
  assert.equal((await fetch(syncUrl, { method: 'POST', headers: syncHeaders, body: JSON.stringify(shared) })).status, 200);
  await until("results.some(x=>x.syncState==='synced'&&x.syncMessage.includes('캐릭터 5개'))", 'Mobile library has five characters');
  shared = await (await fetch(syncUrl, { headers: syncHeaders })).json();
  while (shared.data.characters.length < 7) {
    shared.data.characters.push({ ...structuredClone(shared.data.characters[0]), chaId: 'sync-library-' + shared.data.characters.length });
  }
  shared.data.settings.temperature = 37;
  shared.data.settings.ollamaModel = 'other-local';
  shared.data.settings.maxResponse = 333;
  assert.equal((await fetch(syncUrl, { method: 'POST', headers: syncHeaders, body: JSON.stringify(shared) })).status, 200);
  await evaluate("results=[];(()=>{const w=document.querySelector('iframe').contentWindow;w.dispatchEvent(new w.PageTransitionEvent('pagehide',{persisted:true}));w.dispatchEvent(new w.PageTransitionEvent('pageshow',{persisted:true}));})()");
  await until("results.some(x=>x.modelState&&x.model==='other-local')", 'Model synchronizes after mobile page restoration');
  await until("results.some(x=>x.syncState==='synced')", 'Settings sync resumes after page restoration');
  await until("results.some(x=>x.syncState==='synced'&&x.syncMessage.includes('캐릭터 7개'))", 'Mobile library catches up from five to seven characters');
  const assetRequestsBeforeChat = requests.filter(url => url.startsWith('/api/risu/sync?asset=')).length;
  await evaluate("(()=>{const w=document.querySelector('iframe').contentWindow;w.syncWrites=[];const original=w.fetch.bind(w);w.fetch=(url,options)=>{if(String(url)==='/api/risu/sync'&&options?.method==='POST')w.syncWrites.push(JSON.parse(options.body));return original(url,options)};})()");
  await evaluate(`(()=>{const w=document.querySelector('iframe').contentWindow;const field=w.document.querySelector('textarea.text-input-area');field.value='MOBILE_CONTINUATION';field.dispatchEvent(new w.Event('input',{bubbles:true}));w.document.querySelector('.button-icon-send').click();})()`);
  await until("(document.querySelector('iframe').contentDocument.body.innerText.match(/ROLEPLAY_REPLY_TEST/g)||[]).length>=2", 'Mobile continues conversation');
  assert.equal(chats.at(-1).model, 'other-local');
  assert.equal(chats.at(-1).options.temperature, 0.37);
  assert.equal(chats.at(-1).options.num_predict, 333);
  await sleep(1000);
  await evaluate("results=[]");
  await until("results.some(x=>x.syncState==='synced')", 'Mobile saves continuation');
  assert.equal(requests.filter(url => url.startsWith('/api/risu/sync?asset=')).length, assetRequestsBeforeChat, 'Chat changes transfer no unchanged assets');
  assert.equal(await evaluate("document.querySelector('iframe').contentWindow.syncWrites.some(x=>Array.isArray(x.delta)&&!x.data)"), true, 'Chat upload contains only a delta');
  await evaluate("results=[];document.querySelector('iframe').src='/risuai/?scope=browser-test&model=test-model'");
  await until('results.some(x=>x.ready)', 'Desktop returns');
  await evaluate(`document.querySelector('iframe').contentDocument.querySelector('[data-char-id="${characterId}"]').click()`);
  await until("!!document.querySelector('iframe').contentDocument.querySelector('textarea.text-input-area')", 'Desktop draft composer ready');
  await evaluate("(()=>{const w=document.querySelector('iframe').contentWindow;const field=w.document.querySelector('textarea.text-input-area');field.value='UNSENT_DRAFT';field.dispatchEvent(new w.Event('input',{bubbles:true}));})()");
  await evaluate("document.querySelector('iframe').contentWindow.postMessage({channel:'webui-risu',action:'session',session:{id:'sync-test-session'}},location.origin)");
  await until("results.some(x=>x.syncState==='synced'||x.syncState==='conflict')", 'Desktop receives mobile continuation');
  assert.equal(await evaluate("results.find(x=>x.syncState==='conflict')?.syncMessage || ''"), '');
  assert.equal(await evaluate("document.querySelector('iframe').contentDocument.querySelector('textarea.text-input-area').value"), 'UNSENT_DRAFT');
  await until("document.querySelector('iframe').contentDocument.body.innerText.includes('MOBILE_CONTINUATION')", 'Mobile turn visible on desktop');
  console.log('PASS mobile-to-desktop continuation round trip');
  assert.deepEqual(errors, []);
  console.log('PASS no uncaught browser exceptions');
  await evaluate("localStorage.setItem('webui-risu:guest:tos4','true')");
  await send('Page.navigate', { url: origin + '/host' });
  await until("!!document.querySelector('[data-risu-tab]') || [...document.querySelectorAll('button')].some(x=>/계정 없이|guest/i.test(x.textContent))", 'Host login screen');
  await evaluate("[...document.querySelectorAll('button')].find(x=>/계정 없이|guest/i.test(x.textContent))?.click()");
  await until("!!document.querySelector('[data-risu-tab]')", 'Host application loads');
  await evaluate("document.querySelector('[data-risu-tab]').click()");
  await until("!!document.querySelector('.risu-panel iframe') && !document.querySelector('.risu-toolbar button').disabled", 'Host roleplay tab ready');
  await evaluate("(()=>{const select=document.querySelector('[aria-label=\"상황극 로컬 모델\"]');select.value='other-local';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await until("document.querySelector('[aria-label=\"상황극 로컬 모델\"]').value==='other-local' && localStorage.getItem('webui-risu:guest:last-ollama-model')==='other-local'", 'Toolbar model selection saved');
  await evaluate("[...document.querySelectorAll('.risu-toolbar button')].find(x=>x.textContent.includes('설정')).click()");
  await until("document.querySelector('.risu-panel iframe').contentDocument.body.innerText.includes('Response 스트리밍')", 'Settings shortcut opens generation controls');
  await evaluate("document.querySelector('[aria-label=\"RisuAI 다시 불러오기\"]').click()");
  await until("!document.querySelector('.risu-toolbar button').disabled", 'Reload returns to home');
  console.log('PASS toolbar model selection, persistence and settings shortcut');
  await evaluate("window.savedRisuFrame=document.querySelector('.risu-panel iframe');document.querySelector('.sidebar-places button').click()");
  assert.equal(await evaluate("document.querySelector('.risu-panel iframe')===savedRisuFrame"), true);
  await evaluate("document.querySelector('[data-risu-tab]').click()");
  await evaluate("document.documentElement.style.setProperty('--bg-main','#123456')");
  await until("document.querySelector('.risu-panel iframe').contentDocument.documentElement.style.getPropertyValue('--webui-bg-main')==='#123456'", 'Host palette follows live changes');
  await evaluate("document.documentElement.style.removeProperty('--bg-main')");
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  assert.equal(await evaluate("document.querySelector('.risu-panel iframe').contentDocument.body.innerText.includes('{{#if') || document.querySelector('.risu-panel iframe').contentDocument.body.innerText.includes('CBS_HIDDEN')"), false, 'Mobile evaluates CBS instead of displaying command text');
  const desktop = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(root, 'node_modules/.risu-desktop.png'), Buffer.from(desktop.result.data, 'base64'));
  console.log('PASS live host palette synchronization');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(500);
  await evaluate(`(()=>{const picker=document.querySelector('.main-header .model-selector-container:not(.header-secondary)');const badge=document.createElement('div');badge.id='test-quota-badge';badge.className='cli-limit-badge';badge.innerHTML='<button class="dropdown-trigger"><span class="cli-limit-text">사용량 소진 · 23시간 59분 후 초기화</span></button>';picker.after(badge);picker.querySelector('button').click()})()`);
  await until("!!document.querySelector('.main-header .model-selector-container > .dropdown-menu')", 'Mobile model menu opens');
  assert.equal(await evaluate("(()=>{const r=document.querySelector('.main-header .model-selector-container > .dropdown-menu').getBoundingClientRect();return r.width>=innerWidth*.8&&r.left>=0&&r.right<=innerWidth})()"), true, 'Model menu stays wide with a long quota badge');
  const pickerShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(root, 'node_modules/.risu-mobile-models.png'), Buffer.from(pickerShot.result.data, 'base64'));
  await evaluate("document.querySelector('.main-header .model-selector-container:not(.header-secondary) > button').click();document.getElementById('test-quota-badge').remove()");
  console.log('PASS mobile model menu width with quota badge');
  assert.equal(await evaluate("document.querySelector('.risu-panel iframe').getBoundingClientRect().width <= window.innerWidth"), true);
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(root, 'node_modules/.risu-preview.png'), Buffer.from(screenshot.result.data, 'base64'));
  console.log('PASS WebUI roleplay tab, preserved frame and mobile layout');
  await evaluate("window.results=[];window.addEventListener('message',e=>{if(e.origin===location.origin)results.push(e.data)})");
  assert.equal((await importFile('unicode.CHARX')).ok, true);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 500, deviceScaleFactor: 1, mobile: true });
  await until("!!document.querySelector('.risu-panel iframe').contentDocument.querySelector('textarea.text-input-area')", 'Mobile composer available');
  await until("document.querySelector('.risu-panel iframe').contentDocument.body.innerText.includes('CBS_SCRIPT_VISIBLE')", 'Mobile display script condition evaluated');
  assert.equal(await evaluate("document.querySelector('.risu-panel iframe').contentDocument.body.innerText.includes('{{#if') || document.querySelector('.risu-panel iframe').contentDocument.body.innerText.includes('CBS_HIDDEN')"), false, 'No raw conditional command in mobile chat');
  await sleep(300);
  assert.equal(await evaluate("(()=>{const w=document.querySelector('.risu-panel iframe').contentWindow;const r=w.document.querySelector('textarea.text-input-area').getBoundingClientRect();return r.bottom<=w.innerHeight+2&&r.width>80&&r.height>=32})()"), true, 'Composer fits reduced mobile viewport');
  const mobileChat = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(root, 'node_modules/.risu-mobile-chat.png'), Buffer.from(mobileChat.result.data, 'base64'));
  console.log('PASS mobile composer in reduced-height viewport');
} finally {
  ws?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  chrome.close();
  syncDb.close();
}
