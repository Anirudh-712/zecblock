'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {answerTaskFor}=require('../../v1/lib/ask-chat');
const {researchReply}=require('../../v1/lib/ask-research-reply');
const {getKnowledge}=require('../../v1/lib/ask-knowledge');
const records=getKnowledge(['transactions']);
const facts={row_a_a:'1 Sept 2026',row_a_b:'1,000',row_a_c:'25'};
const result={query:{version:3,sql:"SELECT date,shielded_transactions,round(100*shielded_transactions::numeric/nullif(transactions,0),2) AS shielded_share_percent FROM activity_daily WHERE date=DATE '2026-09-01'",limit:100},columns:[{key:'c0',label:'date',type:'text'},{key:'c1',label:'shielded_transactions',type:'number'},{key:'c2',label:'shielded_share_percent',type:'number'}],rows:[['2026-09-01','1000','25.00']],truncated:false,datasets:['activity_daily'],fingerprint:'a'.repeat(64),retrievedAt:'2026-10-28T00:00:00Z',indexedThrough:'2026-10-28T00:00:00Z',coverage:'verified canonical records',units:'exact decimal strings'};

test('raw SQL-cell instructions distinguish unit-free cells from preformatted chart facts',()=>{
 const cellTask=answerTaskFor(facts,records,false,true,'cells'),chartTask=answerTaskFor(facts,records,true,true);
 assert.doesNotMatch(cellTask.instruction,/Facts already include units: do not append duplicate units/);
 assert.match(cellTask.instruction,/SQL cell facts contain their displayed value/);
 assert.match(cellTask.instruction,/percentage already calculated in SQL needs a percent sign/);
 assert.match(cellTask.instruction,/Calendar labels, including month names and years, must use their supplied/);
 assert.match(cellTask.instruction,/largest absolute change from the largest increase/);
 assert.match(chartTask.instruction,/Facts already include units: do not append duplicate units/);
 assert.doesNotMatch(chartTask.instruction,/SQL cell facts contain their displayed value/);
});

test('SQL explanations attach a percent unit without changing the exact result',async()=>{
 let calls=0;
 const reply=await researchReply(result,{question:'Explain the shielded percentage on the selected day.',history:[]},async(input,task)=>{
  calls++;assert.match(task.instruction,/SQL cell facts contain their displayed value/);
  assert.match(task.instruction,/largestMagnitude/);
  assert.deepEqual(input.evidence.rows,result.rows);
  assert.deepEqual(input.evidence.extrema.find(column=>column.column==='c2').maximum,{facts:['row_a_c'],additionalTies:false});
  return {summary:'On {{row_a_a}}, shielded transactions were {{row_a_b}}, or {{row_a_c}}% of all transactions.',observations:[],limitation:'',sources:['transactions']};
 },'en',answerTaskFor);
 assert.equal(calls,1);assert.match(reply.answer,/25% of all transactions/);assert.deepEqual(reply.research,result);
});

test('calendar and monetary validation remain independent of clearer model instructions',async()=>{
 const reply=await researchReply(result,{question:'Explain the selected share.',history:[]},async()=>({summary:'September had {{row_a_b}} shielded transactions.',observations:[],limitation:'',sources:['transactions']}),'en',answerTaskFor);
 assert.match(reply.answer,/^Your query returned 1 record\./);
 const wrongUnit=await researchReply(result,{question:'Explain the selected count.',history:[]},async()=>({summary:'The shielded transaction count was {{row_a_b}} ZEC.',observations:[],limitation:'',sources:['transactions']}),'en',answerTaskFor);
 assert.match(wrongUnit.answer,/^Your query returned 1 record\./);
});
