import { readFileSync, mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readdirSync } from 'node:fs';
import { rolldown } from 'rolldown';
import { utils, write } from 'xlsx';
import { zipSync, strToU8, gzipSync } from 'fflate';

const root = process.cwd();
const browser = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
  .flatMap(p => [path.join(p, 'Google/Chrome/Application/chrome.exe'), path.join(p, 'Microsoft/Edge/Application/msedge.exe')]).find(existsSync);
assert.ok(browser, 'Chromium browser is installed');
const bundle = await rolldown({ input: path.join(root, 'src/rag.js'), external: ['pdfjs-dist'], platform: 'browser' });
const { output } = await bundle.generate({ format: 'esm' });
await bundle.close();
const moduleCode = output.find(o => o.type === 'chunk').code;
const workerName = readdirSync(path.join(root, 'dist/assets')).find(n => /^spreadsheet\.worker-.*\.js$/.test(n));
assert.ok(workerName, 'Run npm run build first');
const workerCode = readFileSync(path.join(root, 'dist/assets', workerName));
const server = createServer((req, res) => {
  if (req.url === '/src/rag.js') { res.setHeader('Content-Type','text/javascript'); res.end(moduleCode); }
  else if (req.url.endsWith('/spreadsheet.worker.js')) { res.setHeader('Content-Type','text/javascript'); res.end(workerCode); }
  else { res.setHeader('Content-Type','text/html'); res.end('<!doctype html><title>Spreadsheet test</title>'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
mkdirSync(path.join(root, 'native/artifacts'), { recursive: true });
const profile = mkdtempSync(path.join(root, 'native/artifacts/spreadsheet-browser-'));
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-sync', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const delay = ms => new Promise(r => setTimeout(r, ms));
let ws;
try {
  let port;
  for (let i = 0; i < 100; i++) { try { port = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch {} await delay(100); }
  assert.ok(port);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(pages.find(p => p.type === 'page' && p.url === 'about:blank').webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const run = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 70000 });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await send('Page.navigate', { url: origin + '/spreadsheet-test' });
  console.log('Spreadsheet browser ready');
  await delay(500);
  for (const bookType of ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods']) {
    const book = utils.book_new();
    utils.book_append_sheet(book, utils.aoa_to_sheet([['상품', '금액'], ['사과', 1200]]), '매출');
    utils.book_append_sheet(book, utils.aoa_to_sheet([['한글 시트']]), '메모');
    const encoded = write(book, { type: 'base64', bookType });
    const result = await run(`(async () => {
      const { extractDocument } = await import('/src/rag.js');
      const bytes = Uint8Array.from(atob(${JSON.stringify(encoded)}), c => c.charCodeAt(0));
      let progress = 0;
      const pages = await extractDocument(new File([bytes], 'test.${bookType}'), () => progress++);
      return { pages, progress };
    })()`);
    assert.equal(result.pages.length, 2);
    assert.match(result.pages[0].text, /B2="1200"/);
    assert.match(result.pages[1].text, /한글 시트/);
    assert.equal(result.progress, 1);
    console.log(`PASS ${bookType}: browser file attachment extraction through real Web Worker`);
  }
  const archive = entries => Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, strToU8(text)])))).toString('base64');
  const fixtures = [
    ['pptx', archive({
      'ppt/presentation.xml': '<p:presentation xmlns:p="urn:p" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/></Relationships>',
      'ppt/slides/slide1.xml': '<a:p xmlns:a="urn:a"><a:t>두 번째</a:t></a:p>',
      'ppt/slides/slide2.xml': '<a:p xmlns:a="urn:a"><a:t>한글 &amp; 1200</a:t></a:p>',
    }), 2],
    ['odt', archive({ 'content.xml': '<o:document xmlns:o="urn:o" xmlns:t="urn:t"><o:body><t:p>한글 &amp; 1200</t:p><t:p>다음 문단</t:p></o:body></o:document>' }), 1],
    ['odp', archive({ 'content.xml': '<o:document xmlns:o="urn:o" xmlns:d="urn:d" xmlns:t="urn:t"><o:body><d:page><t:p>한글 &amp; 1200</t:p></d:page><d:page><t:p>두 번째</t:p></d:page></o:body></o:document>' }), 2],
    ['hwpx', archive({ 'Contents/section0.xml': '<h:section xmlns:h="urn:h"><h:p><h:t>한글 &amp; 1200</h:t></h:p></h:section>' }), 1],
    ['html', Buffer.from('<html><body><p>한글 &amp; 1200</p><script>DO_NOT_INCLUDE</script><style>DO_NOT_INCLUDE</style></body></html>').toString('base64'), 1],
    ['txt', Buffer.from('\ufeff한글 & 1200', 'utf16le').toString('base64'), 1],
    ['unknown', Buffer.from('한글 & 1200').toString('base64'), 1],
    ['csv', Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, ...Buffer.from(' & 1200')]).toString('base64'), 1],
    ['rtf', Buffer.from('{\\rtf1\\ansi\\uc1 {\\fonttbl DO_NOT_INCLUDE;}\\u54620?\\u44544? & 1200\\par next}').toString('base64'), 1],
    ['gz', Buffer.from(gzipSync(strToU8('한글 & 1200'))).toString('base64'), 1],
    ['zip', archive({ 'folder/readme.custom': '한글 & 1200', 'setup.exe': 'MZ\x00\x01' }), 2],
    ['renamed', archive({ 'word/document.xml': '<w:document xmlns:w="urn:w"><w:p><w:t>한글 &amp; 1200</w:t></w:p></w:document>' }), 1],
    ['epub', archive({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
      'OEBPS/book.opf': '<package><manifest><item id="b" href="b.xhtml"/><item id="a" href="a.xhtml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>',
      'OEBPS/a.xhtml': '<html><body><p>한글 &amp; 1200</p></body></html>',
      'OEBPS/b.xhtml': '<html><body><p>second chapter</p></body></html>',
    }), 2],
  ];
  for (const [ext, encoded, count] of fixtures) {
    const pages = await run(`(async () => {
      const { extractDocument } = await import('/src/rag.js');
      return extractDocument(new File([Uint8Array.from(atob(${JSON.stringify(encoded)}), c => c.charCodeAt(0))], 'test.${ext}'));
    })()`);
    assert.equal(pages.length, count);
    assert.match(pages[0].text, /한글 & 1200/);
    assert.ok(!pages[0].text.includes('DO_NOT_INCLUDE'));
    console.log(`PASS ${ext}: document extraction, text order and Unicode`);
  }
  assert.equal(await run(`(async () => {
    const { extractDocument } = await import('/src/rag.js');
    try { await extractDocument(new File([new Uint8Array([80,75,3,4])], 'broken.xlsx')); return false; }
    catch (e) { return !!e.message; }
  })()`), true);
  console.log('PASS corrupt spreadsheet reports an error');
  for (const [ext, entries] of [['pptx', { 'content.xml': '<root/>' }], ['odt', { 'content.xml': '<broken>' }]]) {
    const encoded = archive(entries);
    assert.equal(await run(`(async () => {
      const { extractDocument } = await import('/src/rag.js');
      try { await extractDocument(new File([Uint8Array.from(atob(${JSON.stringify(encoded)}), c => c.charCodeAt(0))], 'broken.${ext}')); return false; }
      catch (e) { return !!e.message; }
    })()`), true);
  }
  console.log('PASS missing office parts and malformed XML report errors');
  assert.equal(await run(`(async () => {
    const { extractDocument } = await import('/src/rag.js');
    try { await extractDocument(new File([new Uint8Array([77,90,0,1])], 'renamed.txt')); return false; }
    catch (e) { return e.code === 'binary'; }
  })()`), true);
  console.log('PASS renamed executable remains rejected');
  await send('Browser.close');
} finally {
  ws?.close();
  await new Promise(r => server.close(r));
  if (child.exitCode === null && child.signalCode === null) child.kill();
}
