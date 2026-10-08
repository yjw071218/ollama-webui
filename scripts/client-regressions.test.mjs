import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {networkSetup,publicIPv4} from '../server/networkSetup.mjs';
import {readEnvValue,writeEnvValue} from '../server/envFile.js';
const app=readFileSync(new URL('../src/App.jsx',import.meta.url),'utf8');
test('catalogue refresh does not undo manual model selection; changing chat restores',()=>{
 const body=app.match(/const restoredModelRef = useRef\(null\);\s*useEffect\(\(\) => \{([\s\S]*?)\n  \},/)[1];
 const c={restoredModelRef:{current:null},storageKey:'account',currentSessionId:1,sessions:[{id:1,lastModel:'old'},{id:2,lastModel:'other'}],models:[{name:'old'},{name:'other'}]};
 let selected='';c.setSelectedModel=v=>selected=v;
 vm.runInNewContext('(function(){'+body+'})()',c);assert.equal(selected,'old');
 selected='new';c.models=[...c.models];vm.runInNewContext('(function(){'+body+'})()',c);assert.equal(selected,'new');
 c.currentSessionId=2;vm.runInNewContext('(function(){'+body+'})()',c);assert.equal(selected,'other');
});
test('panel leaves room for chat and is capped at 720px',()=>{
 const body=app.match(/const artifactMaxWidth = useCallback\(\(\) => \{([\s\S]*?)\}, \[isSidebarOpen, shownSidebarWidth\]\)/)[1];
 for(const width of [1281,1366,1440,1920,2560])for(const sidebar of [200,340,480]){
 const max=vm.runInNewContext('(function(){'+body+'})()',{window:{innerWidth:width},isSidebarOpen:true,shownSidebarWidth:sidebar,MIN_CHAT_WIDTH:480});
 assert.ok(max<=720);assert.ok(width-sidebar-max>=480);assert.ok(max<=(width-sidebar)/2);
 }
});
test('known quota rejection is not hidden when numeric windows are absent',()=>{
 const source=readFileSync(new URL('../src/CliLimits.jsx',import.meta.url),'utf8');
 const condition=source.match(/if \((!limits[^\n]+?)\) return <div/)[1];
 assert.equal(vm.runInNewContext(condition,{limits:{windows:[],status:'rejected'}}),false);
 assert.equal(vm.runInNewContext(condition,{limits:{windows:[]}}),true);
});
test('external setup is opt-in and saves the WAN nip.io origin and instructions',async()=>{
 let env='PORT=5173\n';let guide='';const answers=['192.168.1.2','8.8.8.8'];
 await networkSetup({env:()=>env,readEnvValue,save:(k,v)=>env=writeEnvValue(env,k,v),ask:async()=>answers.shift(),yes:async()=>true,log:()=>{},writeGuide:t=>guide=t});
 assert.equal(readEnvValue(env,'PUBLIC_ORIGIN'),'http://8.8.8.8.nip.io:5173');
 assert.equal(readEnvValue(env,'EXTERNAL_ACCESS'),'1');assert.match(guide,/CGNAT/);assert.match(guide,/TCP/);
 await networkSetup({env:()=>env,readEnvValue,save:(k,v)=>env=writeEnvValue(env,k,v),yes:async()=>false,log:()=>{}});
 assert.equal(readEnvValue(env,'EXTERNAL_ACCESS'),'0');
 for(const ip of ['127.0.0.1','100.64.1.1','172.16.0.1','224.0.0.1','bad'])assert.equal(publicIPv4(ip),false);
});
