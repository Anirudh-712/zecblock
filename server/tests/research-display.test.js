'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {defaultResearchChart,shortLabel,supportsLine,cellLink}=require('../../lib/ask/research-display');
const result={columns:[{key:'c0',label:'txid',type:'text'},{key:'c1',label:'height',type:'number'},{key:'c2',label:'miner',type:'text'},{key:'c3',label:'public_deshield_zec',type:'number'}],rows:[['a'.repeat(64),'3508500','Miner A','279.99975'],['b'.repeat(64),'3508499','Miner A','242.00015']]};
test('transaction rankings choose the returned amount rather than block height; display does not mutate source rows',()=>{
 const original=JSON.stringify(result);assert.deepEqual(defaultResearchChart(result),{view:'table',x:0,y:3});
 assert.equal(shortLabel(result.rows[0][0]),'aaaaaaaaaa…aaaaaa');assert.equal(JSON.stringify(result),original);
 assert.equal(defaultResearchChart({columns:[{key:'c0',label:'timestamp',type:'number'},{key:'c1',label:'fees_zec',type:'number'}]}).y,1);
 assert.equal(defaultResearchChart({columns:[{key:'c0',label:'miner',type:'text'}]}).y,0);
});
test('lines require an ordered numeric/date axis, never repeated categories or unordered rankings',()=>{
 assert.equal(supportsLine(result,0),false);assert.equal(supportsLine(result,2),false);assert.equal(supportsLine(result,1),true);
 for(const rows of [[['1'],['1']],[['1'],['3'],['2']],[['1'],[null]],[['1']]])assert.equal(supportsLine({columns:[{type:'number'}],rows},0),false);
 assert.equal(supportsLine({columns:[{type:'text'}],rows:[['2026-10-01'],['2026-10-02']]},0),true);
 assert.equal(supportsLine({columns:[{type:'text'}],rows:[['2026-10-01'],['invalid']]},0),false);
});
test('identifier links preserve complete values and never accept URLs or executable text',()=>{
 assert.equal(cellLink('txid','a'.repeat(64)),'/tx/'+'a'.repeat(64));assert.equal(cellLink('height','3508500'),'/block/3508500');assert.equal(cellLink('miner','t1'+'A'.repeat(33)),'/address/t1'+'A'.repeat(33));
 for(const value of ['javascript:alert(1)','https://evil.test','../secret',null,'0','1.5'])assert.equal(cellLink('txid',value),null);
 assert.equal(cellLink('miner','Unattributed'),null);assert.equal(shortLabel(null),'Unavailable');
});
test('result cells retain exact decimals and complete safe identifiers; numeric headers carry the same alignment type as cells',()=>{
 const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript'),React=require('react');
 const filename=path.resolve(__dirname,'../../app/ask/ResearchWorkbench.tsx'),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));const base=m.require.bind(m);
 const imports={'next/dynamic':{default:()=>()=>null},'next/link':{default:props=>React.createElement('a',props)},'@/lib/ask/research-display':require('../../lib/ask/research-display'),'@/lib/ask/research-contract':require('../../lib/ask/research-contract'),'@/lib/ask/research-library':require('../../lib/ask/research-library')};
 m.require=name=>Object.hasOwn(imports,name)?imports[name]:name.endsWith('.module.css')?new Proxy({},{get:(_,key)=>key}):base(name);
 m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText,filename);
 const data={...result,rows:[result.rows[0],['<script>secret()</script>','3508499','Unattributed',null]],indexedThrough:'2026-10-07T00:00:00Z',retrievedAt:'2026-10-07T00:01:00Z',coverage:'Public data',units:'ZEC',fingerprint:'a'.repeat(64)};
 const html=require('react-dom/server').renderToStaticMarkup(React.createElement(m.exports.ResearchData,{result:data,chart:defaultResearchChart(data)}));
 assert.match(html,/<th scope="col" data-numeric="true">public deshield zec/);assert.match(html,/<td data-numeric="true"><span title="279.99975">279.99975/);
 assert.match(html,new RegExp('href="/tx/'+'a'.repeat(64)+'"'));assert.match(html,/Unavailable/);assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
});
