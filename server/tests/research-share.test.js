'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {MAX_LINK_BYTES,queryShare,dashboardShare,researchLink,readResearchLink,sharedLibrary}=require('../../lib/ask/research-share');
const doc=()=>({format:'zecblock-research',version:1,id:randomUUID(),title:'Fees · 手数料',notes:'private notes are excluded',query:{version:3,sql:"SELECT '🛡️' AS label, sum(fees) FROM blocks",limit:100},chart:{view:'table',x:0,y:0},result:null,savedAt:'2026-10-16T00:00:00Z'});
test('share query is UTF8 portable and excludes notes, results, origin identity and saved timestamps',()=>{
 const d=doc(),share=queryShare(d),url=new URL(researchLink(share,'https://zecblock.com/path?ignored=1'));
 assert.equal(url.origin,'https://zecblock.com');assert.equal(url.pathname,'/ask');assert.equal(url.search,'');assert.deepEqual(readResearchLink(url.hash),share);
 assert.equal(JSON.stringify(share).includes(d.notes),false);assert.equal(JSON.stringify(share).includes(d.id),false);assert.equal(JSON.stringify(share).includes('savedAt'),false);
 const imported=sharedLibrary(share,randomUUID,'2026-10-16T01:00:00Z');assert.equal(imported.documents[0].result,null);assert.equal(imported.documents[0].notes,'');assert.equal(imported.documents[0].query.sql,d.query.sql);assert.notEqual(imported.documents[0].id,d.id);
});
test('dashboard share preserves query order and chart settings without automatic runs or snapshots',()=>{
 const a=doc(),b={...doc(),title:'Other',chart:{view:'bar',x:0,y:1}},board={id:randomUUID(),title:'Daily research',items:[b.id,a.id]};
 const share=dashboardShare({format:'zecblock-library',version:1,documents:[a,b],dashboards:[board]},board.id),opened=sharedLibrary(share,randomUUID,'2026-10-16T01:00:00Z');
 assert.deepEqual(opened.documents.map(d=>d.title),['Other',a.title]);assert.deepEqual(opened.documents[0].chart,b.chart);assert.deepEqual(opened.dashboards[0].items,opened.documents.map(d=>d.id));assert.ok(opened.documents.every(d=>d.result===null));
});
test('oversized links, hidden fields, invalid UTF8 and malformed base64 are rejected before import',()=>{
 for(const hash of ['#research=',''+ '#research='+ 'A'.repeat(MAX_LINK_BYTES),'#research=%%%','#research=__8','#research=YQ=','#research=YQ!'])assert.throws(()=>readResearchLink(hash));
 const encode=value=>'#research='+Buffer.from(JSON.stringify(value)).toString('base64url');
 for(const value of [{...queryShare(doc()),endpoint:'https://evil.test'},{...queryShare(doc()),queries:[{...queryShare(doc()).queries[0],apiKey:'hidden'}]},{...queryShare(doc()),queries:[]},{...queryShare(doc()),queries:Array(13).fill(queryShare(doc()).queries[0])}])assert.throws(()=>readResearchLink(encode(value)));
 const large={...queryShare(doc()),kind:'dashboard',queries:Array.from({length:12},()=>({...queryShare(doc()).queries[0],query:{version:3,sql:'SELECT '+ 'x'.repeat(8000),limit:200}}))};assert.throws(()=>researchLink(large,'https://zecblock.com'),/too large/);
 assert.throws(()=>researchLink(queryShare(doc()),'javascript:alert(1)'));assert.equal(readResearchLink('#other=value'),null);
});
test('shared SQL remains an untrusted draft: no fetch, execution, provider or storage dependency',()=>{
 const share=queryShare({...doc(),query:{version:3,sql:'DELETE FROM blocks',limit:10}});let ids=0;
 const imported=sharedLibrary(share,()=>{ids++;return randomUUID();},'2026-10-16T00:00:00Z');assert.equal(ids,1);assert.equal(imported.documents[0].query.sql,'DELETE FROM blocks');assert.equal(imported.documents[0].result,null);
});
