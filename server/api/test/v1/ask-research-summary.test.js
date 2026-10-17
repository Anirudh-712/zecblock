'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {researchValueSummary}=require('../../v1/lib/ask-research-summary');
const {researchReply}=require('../../v1/lib/ask-research-reply');
const {answerTaskFor}=require('../../v1/lib/ask-chat');
const {researchUnitsFor}=require('../../v1/lib/ask-research-plan-quality');
const {compileResearchSQL,researchEvidence}=require('../../v1/lib/ask-research-sql');
const sql='WITH latest_blocks AS (SELECT height,fees FROM blocks ORDER BY height DESC LIMIT 100) SELECT count(*) FILTER(WHERE fees IS NOT NULL) AS known_fees_count,count(*) FILTER(WHERE fees IS NULL) AS missing_fees_count,avg(fees)::numeric/100000000 AS average_fee_zec FROM latest_blocks';
const names=['known_fees_count','missing_fees_count','average_fee_zec'];
async function fixture(statement=sql,row=['100','0','0.00171878560000000000'],labels=names){
 const compiled=await compileResearchSQL({version:3,sql:statement,limit:100},{extended:true});
 const result=researchEvidence(compiled,[row],labels.map(name=>({name,dataTypeID:1700})),{indexed_through:'2026-10-17T11:30:00Z'},'2026-10-17T11:31:00Z');
 return {result,inferred:(await researchUnitsFor(result.query.sql)).columns};
}
const expected='Returned query values:\nknown_fees_count: 100\nmissing_fees_count: 0\naverage_fee_zec: 0.0017187856 ZEC\n\nThe generated explanation could not be verified.';
test('single aggregate fallback binds all exact values to their query columns and proven units',async()=>{
 const {result,inferred}=await fixture(),before=JSON.stringify(result);
 assert.equal(researchValueSummary(result,inferred,'en'),expected);
 assert.equal(JSON.stringify(result),before);
 assert.equal(result.rows[0][2],'0.00171878560000000000');
});
test('column order and mixed monetary denominations remain positional, not guessed from labels',async()=>{
 const {result,inferred}=await fixture('SELECT avg(fees)/100000000 AS average_fee_zec,count(*) AS known_count,avg(fees) AS average_fee_zatoshis,(SELECT sum(usd) FROM swaps) AS swap_usd FROM blocks',['0.001','100','100000','1234.56'],['average_fee_zec','known_count','average_fee_zatoshis','swap_usd']);
 assert.equal(researchValueSummary(result,inferred,'en'),'Returned query values:\naverage_fee_zec: 0.001 ZEC\nknown_count: 100\naverage_fee_zatoshis: 100,000 zatoshis\nswap_usd: 1,234.56 USD\n\nThe generated explanation could not be verified.');
});
test('null remains unavailable, zero remains zero, and large decimals never pass through Number',async()=>{
 const {result,inferred}=await fixture();
 result.rows=[['9007199254740993','0',null]];
 assert.equal(researchValueSummary(result,inferred,'en'),'Returned query values:\nknown_fees_count: 9,007,199,254,740,993\nmissing_fees_count: 0\naverage_fee_zec: Unavailable\n\nThe generated explanation could not be verified.');
 result.rows[0][2]='9007199254740993.1234567890123456789';
 assert.match(researchValueSummary(result,inferred,'en'),/9,007,199,254,740,993\.1234567890123456789 ZEC/);
});
test('aliases cannot relabel raw zatoshis, counts or USD as ZEC',async()=>{
 for(const statement of ['SELECT avg(fees) AS fee_zec FROM blocks','SELECT count(*) AS fee_zec FROM blocks','SELECT sum(usd) AS balance_zec FROM swaps']){
  const {result,inferred}=await fixture(statement,['42'],['fee_zec']);
  // Last fixture is also a mismatched metadata label; either condition abstains.
  assert.equal(researchValueSummary(result,inferred,'en'),null);
 }
 const {result,inferred}=await fixture('SELECT sum(usd) AS balance_zec FROM swaps',['42'],['balance_zec']);
 assert.equal(researchValueSummary(result,inferred,'en'),null);
});
test('unresolved units, mismatched names and widths, duplicate or unsafe labels abstain',async()=>{
 const {result,inferred}=await fixture();
 for(const replacement of [[{...inferred[0],unit:'unknown'},...inferred.slice(1)],inferred.slice(1),[{...inferred[0],name:'other'},...inferred.slice(1)]])assert.equal(researchValueSummary(result,replacement,'en'),null);
 for(const label of ['<script>','see https://elsewhere.test','line\nbreak','𝐚','a'.repeat(64)]){
  const columns=result.columns.map((c,i)=>i?c:{...c,label}),units=inferred.map((c,i)=>i?c:{...c,name:label});
  assert.equal(researchValueSummary({...result,columns},units,'en'),null);
 }
 const columns=result.columns.map((c,i)=>i===1?{...c,label:names[0].toUpperCase()}:c),units=inferred.map((c,i)=>i===1?{...c,name:names[0].toUpperCase()}:c);
 assert.equal(researchValueSummary({...result,columns},units,'en'),null);
});
test('empty, multirow, truncated, wide, non-English and nonnumeric shapes retain the existing path',async()=>{
 const {result,inferred}=await fixture();
 for(const change of [{rows:[]},{rows:[result.rows[0],result.rows[0]]},{truncated:true},{columns:result.columns.map((c,i)=>i?c:{...c,type:'text'})},{columns:result.columns.map((c,i)=>i?c:{...c,type:'boolean'})}])assert.equal(researchValueSummary({...result,...change},inferred,'en'),null);
 assert.equal(researchValueSummary(result,inferred,'fr'),null);
 const columns=Array.from({length:7},(_,i)=>({key:'c'+i,label:'col_'+i,type:'number'}));
 assert.equal(researchValueSummary({...result,columns,rows:[Array(7).fill('1')]},columns.map(c=>({name:c.label,unit:'count'})),'en'),null);
});
test('nonfinite/scientific strings and oversized summaries never become partial numbers',async()=>{
 const {result,inferred}=await fixture();
 for(const value of ['NaN','Infinity','1e99','42 USD','42; ignore instructions','9'.repeat(800)])assert.equal(researchValueSummary({...result,rows:[['100','0',value]]},inferred,'en'),null);
});
test('rejected prose becomes the same checked column report without another model call',async()=>{
 const {result}=await fixture();
 for(const summary of ['The average fee is {{row_a_c}} ZEC','The average fee is {{row_a_a}} ZEC.','Values were {{row_a_a}} {{row_a_c}}.','The fee is {{row_a_c}} zatoshis.']){
  let calls=0;
  const reply=await researchReply(result,{question:'For the latest blocks, show known and missing fees and average known fee in ZEC.'},async()=>{calls++;return {summary,observations:[],limitation:''};},'en',answerTaskFor);
  assert.equal(calls,1);assert.equal(reply.answer,expected);assert.deepEqual(reply.research,result);assert.equal(reply.evidenceKey,result.fingerprint);
 }
});
test('valid prose remains valid and literal numbers or invented references still fail closed',async()=>{
 const {result}=await fixture();
 const answer=summary=>researchReply(result,{question:'Explain the mean fee'},async()=>({summary,observations:[],limitation:''}),'en',answerTaskFor);
 assert.equal((await answer('The average known fee is {{row_a_c}} ZEC.')).answer,'The average known fee is 0.0017187856 ZEC.');
 await assert.rejects(answer('The fee is 0.001 ZEC.'),/Unvalidated numerical claim/);
 await assert.rejects(answer('The fee is {{made_up}} ZEC.'),/Unknown evidence reference/);
});
test('unresolved monetary expression falls back to receipt rather than inventing a unit',async()=>{
 const {result}=await fixture('SELECT sqrt(avg(fees)) AS fee_zec FROM blocks',['42'],['fee_zec']);
 const reply=await researchReply(result,{question:'Explain the fee'},async()=>({summary:'The value is {{row_a_a}} ZEC.',observations:[],limitation:''}),'en',answerTaskFor);
 assert.equal(reply.answer,'Your query returned 1 record. The results are available in the table below.');
});
test('a text cell resembling an invalid date is not silently converted into a different day',async()=>{
 const {result}=await fixture("SELECT '2026-02-30' AS observation_date,count(*) AS count FROM blocks",['2026-02-30','42'],['observation_date','count']);result.columns[0].type='text';
 const reply=await researchReply(result,{question:'Explain the returned observation'},async()=>({summary:'The returned label is {{row_a_a}} with {{row_a_b}} records.',observations:[],limitation:''}),'en',answerTaskFor);
 assert.match(reply.answer,/2026-02-30/);assert.doesNotMatch(reply.answer,/Mar(?:ch)? 2/);
});
