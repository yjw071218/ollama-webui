import test from 'node:test';
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { remarkTableBreaks } from '../src/answerPresentation.js';
import { parseInfoBlocks, safeSourceUrl } from '../src/infoBlockData.js';
import { searchScholarly, scholarlyRecord } from '../server/scholarly.js';
import { slideScene, SLIDE_LAYOUTS, OFFICE_THEMES, parseOfficeProposal } from '../src/officeDesign.js';

test('tables render only bare breaks; code and unsafe HTML stay inert', async () => {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkTableBreaks);
  const tree = await processor.run(processor.parse('| A | B |\n|---|---|\n|one<br>two<BR />three|`<br>` <img src=x onerror=bad()>|'));
  const cells = tree.children[0].children[1].children;
  assert.equal(cells[0].children.filter(x => x.type === 'break').length, 2);
  assert.equal(cells[1].children.find(x=>x.type==='inlineCode').value,'<br>');
  assert.ok(cells[1].children.some(x=>x.type==='html' && x.value.includes('onerror')));
});
test('infographic variants preserve numeric changes, media and nested chart panels', () => {
  const data = parseInfoBlocks(JSON.stringify({ title:'성과', blocks:[
    {type:'Metrics',data:[{title:'변화',value:'47% → 19%'}]},
    {type:'image-list',items:[{title:'나라',description:'설명',imageUrl:'https://example.org/a.png'}]},
    {type:'panel',blocks:[{type:'stats',items:[{label:'전체',value:25026}]},{type:'progress',items:[{label:'유지',value:22.22}]},{type:'chart',chart:{type:'bar',labels:['A'],data:[2]}}]}
  ]}));
  assert.equal(data.blocks.length,3);assert.equal(data.blocks[0].items[0].value,'47% → 19%');
  assert.equal(data.blocks[1].items[0].text,'설명');assert.equal(data.blocks[2].blocks.length,3);
  assert.equal(parseInfoBlocks('{"type":"stats","items":'),null);
  assert.equal(parseInfoBlocks('{"type":"stats","items":[{"label":"literal ,}","value":2,},],}').blocks[0].items[0].label,'literal ,}');
  assert.equal(parseInfoBlocks('{"type":"proscons","pros":42}'),null);
  assert.equal(safeSourceUrl('javascript:alert(1)'),'');
});
test('paper records are retrieved, missing DOI fails closed and upstream errors are not evidence', async () => {
  const work={DOI:'10.1234/example',title:['Actual record'],author:[{given:'A',family:'Researcher'}],published:{'date-parts':[[2024]]}};
  assert.equal(scholarlyRecord(work).year,2024);assert.equal(scholarlyRecord({title:['Imagined']}),null);
  const results=await searchScholarly('10.1234/example',{fetcher:async url=>{assert.equal(url.hostname,'api.crossref.org');return {ok:true,json:async()=>({message:work})};}});
  assert.equal(results[0].doi,work.DOI);assert.match(results[0].snippet,/not been verified/);
  assert.deepEqual(await searchScholarly('10.1234/missing',{fetcher:async()=>({status:404})}),[]);
  await assert.rejects(searchScholarly('paper',{fetcher:async()=>({status:503,ok:false})}));
});
test('all presentation layouts stay on canvas and retain editable text', () => {
  const items=Array.from({length:6},(_,i)=>({title:'항목 '+i,body:'구체적인 설명'}));
  for(const theme of Object.keys(OFFICE_THEMES)) for(const layout of SLIDE_LAYOUTS) {
    const slide={title:'핵심 메시지',body:'내용',layout,theme,items,chart:[{label:'A',value:-3},{label:'B',value:5}]};
    const shapes=slideScene(slide);
    assert.ok(shapes.some(s=>s.text==='핵심 메시지'));
    for(const s of shapes){assert.ok(s.x>=0 && s.y>=0 && s.w>=0 && s.h>=0,layout);assert.ok(s.x+s.w<=13.334 && s.y+s.h<=7.501,`${layout} ${JSON.stringify(s)}`);}
  }
  assert.equal(parseOfficeProposal('{"slides":[{"layout":"split","accent":"bad<script>"}]}','pptx').slides[0].accent,'');
});
