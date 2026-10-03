// Renders every phase of the update window and checks what the reader sees.
import { app, BrowserWindow, ipcMain } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../desktop');
const shots = path.join(path.dirname(fileURLToPath(import.meta.url)), '../artifacts/update-ui');
setTimeout(() => { console.error('UPDATE_UI timeout'); app.exit(1); }, 30000);
const info = { version: '1.0.7', current: '1.0.6', size: 111_267_923, kind: 'setup',
  notes: '- 앱 안에서 바로 업데이트\n- 다운로드 진행률(%) 표시\n- <img src=x onerror=alert(1)> 는 글자로만 보입니다' };
const phases = [
  ['checking', {}, '업데이트 확인 중…', ['닫기']],
  ['latest', { current: '1.0.6' }, '최신 버전입니다', ['확인']],
  ['available', { info }, '새 버전 1.0.7 사용 가능', ['이 버전 건너뛰기', '나중에', '지금 업데이트']],
  ['downloading', { info, progress: { received: 48_200_000, total: 111_267_923, percent: 43, bytesPerSecond: 5_100_000 } }, '1.0.7 다운로드 중', ['취소']],
  ['ready', { info, progress: { percent: 100 } }, '1.0.7 설치 준비 완료', ['종료할 때 설치', '지금 다시 시작하여 설치']],
  ['error', { error: '다운로드하지 못했습니다.', detail: '설치 파일 검증(SHA-256)에 실패했습니다. 다시 시도하세요.' }, '업데이트 오류', ['릴리스 페이지 열기', '닫기', '다시 시도']],
];
app.whenReady().then(async () => {
  try {
    await mkdir(shots, { recursive: true });
    const actions = [];
    let current = { phase: 'idle' };
    ipcMain.on('update:ready', e => e.sender.send('update:state', current));
    ipcMain.on('update:action', (_e, a) => actions.push(a));
    const win = new BrowserWindow({ show: false, frame: false, width: 560, height: 560, backgroundColor: '#292620',
      webPreferences: { preload: path.join(root, 'update-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await win.loadURL(pathToFileURL(path.join(root, 'update.html')).href);
    assert.equal(await win.webContents.executeJavaScript('typeof require'), 'undefined');
    for (const [phase, extra, title, labels] of phases) {
      current = { phase, ...extra };
      win.webContents.send('update:state', current);
      await new Promise(r => setTimeout(r, 120));
      const seen = await win.webContents.executeJavaScript(`({
        title: document.getElementById('title').textContent,
        buttons: [...document.querySelectorAll('footer button')].map(b => b.textContent),
        notes: [...document.querySelectorAll('#notes li')].map(li => li.textContent),
        images: document.querySelectorAll('#notes img').length,
        percent: document.getElementById('percent').textContent,
        progressShown: getComputedStyle(document.getElementById('progressBox')).display !== 'none',
        errorShown: getComputedStyle(document.getElementById('error')).display !== 'none',
      })`);
      assert.equal(seen.progressShown, phase === 'downloading' || phase === 'ready', phase + ' progress bar');
      assert.equal(seen.errorShown, phase === 'error', phase + ' error box');
      assert.equal(seen.title, title, phase);
      assert.deepEqual(seen.buttons, labels, phase);
      if (extra.info && phase !== 'available') assert.equal(seen.notes.length, 3);
      assert.equal(seen.images, 0, 'notes are text, never HTML');
      if (phase === 'downloading') { assert.equal(seen.percent, '43%'); assert.ok(seen.progressShown); }
      win.showInactive();
      await new Promise(r => setTimeout(r, 150));
      await writeFile(path.join(shots, phase + '.png'), (await win.webContents.capturePage()).toPNG());
    }
    await win.webContents.executeJavaScript(`document.querySelector('footer button:last-child').click()`);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(actions.at(-1), 'retry');
    console.log('UPDATE_UI passed: ' + phases.map(p => p[0]).join(', '));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
