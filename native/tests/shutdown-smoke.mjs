import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
app.on('window-all-closed', () => {});
const timer = setTimeout(() => app.exit(1), 20000);
app.whenReady().then(() => {
  try {
    const source = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
    const body = source.match(/win\.on\('closed', \(\) => \{([\s\S]*?)\r?\n    \}\);/)[1];
    const destroyed = new BrowserWindow({show:false});
    destroyed.destroy();
    assert.throws(() => destroyed.isVisible(), /destroyed/);
    let cases = 0;
    for (const [setupWindow, connecting, expected] of [
      [destroyed, false, 1], [undefined, false, 1], [destroyed, true, 0],
      [{isDestroyed:()=>false,isVisible:()=>true},false,0],
      [{isDestroyed:()=>false,isVisible:()=>false},false,1],
    ]) {
      let quits=0, closes=0;
      const current = {close:()=>closes++};
      const context={setupWindow,connecting,current,gateway:current,app:{quit:()=>quits++}};
      vm.runInNewContext(body,context);
      assert.equal(quits,expected);assert.equal(closes,1);assert.equal(context.gateway,undefined);
      cases++;
    }
    console.log('SHUTDOWN_SMOKE passed: '+cases+' cases; original destroyed-window exception reproduced');
    clearTimeout(timer);app.exit(0);
  } catch(error) {console.error(error);app.exit(1);}
});
