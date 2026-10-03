// Local exposure inventory; read-only, no values or file contents in output.
import {readdirSync,readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {unzipSync} from 'fflate';
const needle = process.env.PRIVATE_IP;
if (!needle) throw new Error('Supply PRIVATE_IP locally.');
const search = Buffer.from(needle), wide = Buffer.from(needle,'utf16le');
const excluded = new Set(['.git','node_modules','.tools','.gradle','engines','comfyui','integrations']);
const findings=[], skipped=[]; let scanned=0;
function walk(dir) {
  for (const e of readdirSync(dir,{withFileTypes:true})) {
    const file=path.join(dir,e.name);
    if (e.isSymbolicLink()) {skipped.push(file);continue;}
    if(e.isDirectory()) { if(excluded.has(e.name)) skipped.push(file); else walk(file); continue; }
    try {
      if(statSync(file).size>32*1024*1024) {skipped.push(file);continue;}
      const bytes=readFileSync(file);scanned++;
      let found=bytes.includes(search)||bytes.includes(wide);
      if(file.endsWith('.apk')) {
        const zip=unzipSync(bytes);
        found ||= Object.values(zip).some(b=>Buffer.from(b).includes(search)||Buffer.from(b).includes(wide));
      }
      if(found) findings.push(file);
    } catch {skipped.push(file);}
  }
}
walk('.');
console.log(JSON.stringify({scanned,findings,excludedOrUnreadable:skipped,limitations:'Exact supplied IP only; archives except APK are not decompressed. Dependencies, tools and large files excluded.'},null,2));
if(process.argv.includes('--remote')) {
 const r=await fetch('https://api.github.com/repos/yjw071218/ollama-webui/releases?per_page=100',{signal:AbortSignal.timeout(10000)});
 if(!r.ok) throw new Error('GitHub release metadata HTTP '+r.status);
 const releases=await r.json();
 console.log(JSON.stringify({remoteReleaseMetadata:releases.map(r=>({tag:r.tag_name,containsSuppliedIP:(r.body||'').includes(needle),assetCount:r.assets?.length||0})),remoteAssetContents:'not downloaded or scanned'},null,2));
}
