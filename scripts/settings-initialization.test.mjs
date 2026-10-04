import { test } from 'node:test';
import assert from 'node:assert/strict';
import {setActiveScope,setSetting,settingStamps,getSetting,writeScopeSettings} from '../src/settingsStore.js';
test('fresh device defaults do not outrank downloaded account settings',()=>{
 const data=new Map(); globalThis.localStorage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)};
 setActiveScope('srv-new'); setSetting('temperature','0.8');
 assert.equal(settingStamps('srv-new').temperature,0);
 setSetting('temperature','0.6'); assert.ok(settingStamps('srv-new').temperature>0);
 localStorage.setItem('syncRev@srv-new','10');setSetting('topP','0.9');assert.ok(settingStamps('srv-new').topP>0);
 setActiveScope('srv-empty');localStorage.setItem('initialSyncPending@srv-empty','0');
 setSetting('temperature','0.4');assert.ok(settingStamps('srv-empty').temperature>0);
 const stamp=settingStamps('srv-empty').temperature;
 setSetting('temperature','0.4');assert.equal(settingStamps('srv-empty').temperature,stamp);
 setActiveScope('');setSetting('theme','dark');assert.ok(settingStamps('').theme>0);
});
