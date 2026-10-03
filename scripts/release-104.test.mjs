import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { registrationValues } from '../server/socialSetup.mjs';
test('Google setup does not suggest non-local HTTP origins', () => {
  assert.deepEqual(registrationValues({origin:'http://10.0.0.5.nip.io:5173'}).googleOrigins, ['http://localhost:5173']);
  assert.ok(registrationValues({origin:'https://chat.example.com'}).googleOrigins.includes('https://chat.example.com'));
});
test('split panel preserves chat at desktop sizes; narrow windows overlay', () => {
  const app=readFileSync(new URL('../src/App.jsx', import.meta.url),'utf8');
  const block=app.match(/const artifactMaxWidth = useCallback\(\(\) => \{([\s\S]*?)\}, \[isSidebarOpen, sidebarWidth\]\)/)[1];
  for(const width of [1281,1366,1440,1920,2560]) for(const sidebar of [200,340,480]) {
    const max=vm.runInNewContext('(function(){'+block+'})()', {window:{innerWidth:width},isSidebarOpen:true,sidebarWidth:sidebar,MIN_CHAT_WIDTH:480});
    assert.ok(max>=320);assert.ok(max<=Math.round(width*0.6));assert.ok(width-sidebar-max>=480);
  }
  const css=readFileSync(new URL('../src/extras.css',import.meta.url),'utf8');
  assert.match(css, /@media \(max-width: 1280px\)\s*\{\s*\.artifact-panel\s*\{\s*position: fixed/);
});
