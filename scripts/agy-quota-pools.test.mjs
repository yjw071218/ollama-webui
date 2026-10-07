import {test} from 'node:test';
import assert from 'node:assert/strict';
import {agyQuotaForModel as quota} from '../src/agyQuota.js';
const now=10000000;
test('Gemini exhaustion does not block Claude/GPT, and the reverse',()=>{
 for(const full of ['gemini','claude-gpt']) {
  const entry={status:'rejected',windows:[{id:'gemini',usedPercent:full==='gemini'?100:20},{id:'claude-gpt',usedPercent:full==='claude-gpt'?100:20}]};
  for(const model of ['gemini-3-pro','claude-sonnet-4','gpt-5']) {
   const group=model.startsWith('gemini')?'gemini':'claude-gpt';
   assert.equal(quota(entry,model,now).status,group===full?'rejected':'allowed');
   assert.equal(quota(entry,model,now).windows.length,1);
  }
 }
});
test('errors are group-scoped, expire, and legacy errors are not attributed to every model',()=>{
 const entry={status:'rejected',source:'error',poolErrors:{gemini:{updatedAt:now,message:'quota exceeded'}}};
 assert.equal(quota(entry,'gemini-pro',now).status,'rejected');
 assert.equal(quota(entry,'claude-sonnet',now).status,'unknown');
 assert.equal(quota(entry,'gpt-5',now).status,'unknown');
 assert.equal(quota(entry,'gemini-pro',now+16*60000).status,'unknown');
 assert.equal(quota({status:'rejected',lastError:'quota exceeded'},'claude-sonnet',now).status,'unknown');
});
test('expired measured window no longer blocks',()=>{
 assert.equal(quota({windows:[{id:'gemini',usedPercent:100,resetsAt:now-1}]},'gemini-pro',now).status,'allowed');
});
