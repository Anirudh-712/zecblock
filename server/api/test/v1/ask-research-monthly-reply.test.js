'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {researchReply}=require('../../v1/lib/ask-research-reply');
const {answerTaskFor}=require('../../v1/lib/ask-chat');
const {compileResearchSQL,researchEvidence}=require('../../v1/lib/ask-research-sql');
const annual=require('../fixtures/ask-monthly-change-2025.json');
const annualQuestion='Use SQL research. Compare monthly shielded and transparent transaction counts during 2025, show the shielded share of all transactions (including unclassified) and a three-month rolling average of shielded transactions. Use partial windows for the first two months. Explain the largest absolute month-to-month change in shielded transaction count, whether an increase or decrease.';
const metadata={truncated:false,fingerprint:'a'.repeat(64),retrievedAt:'2026-10-28T00:00:00Z',indexedThrough:'2026-10-28T00:00:00Z',coverage:'verified canonical records',units:'exact decimal strings'};
const prose=summary=>({summary,observations:[],limitation:'',sources:['transactions']});
function evidence(shape){return {...structuredClone(shape),...metadata};}

test('the actual staging annual result explains October largest absolute increase without a model guess or receipt',async()=>{
 const result=evidence(annual),before=structuredClone(result);
 const reply=await researchReply(result,{question:annualQuestion,history:[]},()=>assert.fail('the supported endpoint comparison needs no model arithmetic'),'en',answerTaskFor);
 assert.match(reply.answer,/largest absolute month-to-month change in shielded transaction count was an increase of 35,724 transactions/);
 assert.match(reply.answer,/17,451 in September 2025 to 53,175 in October 2025/);
 assert.doesNotMatch(reply.answer,/decrease|December|23,078|Your query returned|could not be verified/);
 assert.deepEqual(reply.research,before);assert.deepEqual(result,before);assert.equal(reply.evidenceKey,before.fingerprint);
});

test('a source-unresolved complex SQL expression keeps its model explanation and exact SQL/results intact',async()=>{
 const sql="WITH monthly AS (SELECT date_trunc('month',date::timestamp)::date AS month,sum(shielded_transactions+0) AS n FROM activity_daily WHERE date>=DATE '2025-01-01' AND date<DATE '2026-01-01' GROUP BY 1) SELECT month,n,lag(n) OVER(ORDER BY month) AS previous FROM monthly ORDER BY month";
 const compiled=await compileResearchSQL({version:3,sql,limit:100},{extended:true});
 const result=researchEvidence(compiled,[['2025-01-01','10',null],['2025-02-01','20','10']],[{name:'month',dataTypeID:25},{name:'n',dataTypeID:1700},{name:'previous',dataTypeID:1700}],{indexed_through:metadata.indexedThrough},metadata.retrievedAt),before=structuredClone(result);let calls=0;
 const reply=await researchReply(result,{question:annualQuestion,history:[]},async(input,task)=>{calls++;assert.equal(input.evidence.query.sql,before.query.sql);assert.deepEqual(input.evidence.rows,before.rows);return task.validator.parse(prose('The returned shielded count for {{row_b_a}} was {{row_b_b}}.'));},'en',answerTaskFor);
 assert.equal(calls,1);assert.match(reply.answer,/returned shielded count.*20/);assert.deepEqual(result,before);assert.deepEqual(reply.research,before);assert.equal(reply.evidenceKey,before.fingerprint);
});

test('manual SQL text and supported relational operators are not rewritten by checked narration',async()=>{
 const sql="/* handwritten spacing retained */ WITH monthly(p,n) AS ( SELECT date_trunc('month',date::timestamp)::date,sum(shielded_transactions) FROM activity_daily GROUP BY 1 ) SELECT p AS month,n AS shielded_count, dense_rank() OVER(ORDER BY n DESC) AS ranking FROM monthly ORDER BY p";
 await compileResearchSQL({version:3,sql,limit:100},{extended:true});
 const result=evidence({query:{version:3,sql,limit:100},columns:[{key:'c0',label:'month',type:'text'},{key:'c1',label:'shielded_count',type:'number'},{key:'c2',label:'ranking',type:'number'}],rows:[['2025-09-01','17451','2'],['2025-10-01','53175','1']],datasets:['activity_daily']}),before=structuredClone(result);
 const reply=await researchReply(result,{question:annualQuestion,history:[]},()=>assert.fail('the exact checked family is supported'),'en',answerTaskFor);
 assert.equal(reply.research.query.sql,sql);assert.deepEqual(reply.research.rows,before.rows);assert.deepEqual(result,before);assert.match(reply.answer,/35,724/);
});

test('only strict valid UTC-midnight wire facts become human-readable dates',async()=>{
 const locale='en',day='2026-01-31',formatted=new Date(day+'T00:00:00Z').toLocaleDateString(locale,{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'});
 const normalized=[day,day+' 00:00:00',day+' 00:00:00.000',day+'T00:00:00Z',day+' 00:00:00+00',day+' 00:00:00+0000',day+' 00:00:00+00:00'];
 const untouched=[day+' 00:00:01',day+'T01:00:00Z',day+' 00:00:00+01',day+' 00:00:00-00:00','2026-02-30','2026-02-29 00:00:00','2026-13-01 00:00:00',day+' sample label'];
 for(const wire of [...normalized,...untouched]){
  const result=evidence({query:{version:3,sql:'SELECT timestamp::text AS observed_at,count(*) AS n FROM transactions GROUP BY 1',limit:100},columns:[{key:'c0',label:'observed_at',type:'text'},{key:'c1',label:'n',type:'number'}],rows:[[wire,'42']],datasets:['transactions']});let calls=0;
  const reply=await researchReply(result,{question:'Explain this returned count.',history:[]},async(input,task)=>{calls++;assert.equal(input.evidence.facts.row_a_a,normalized.includes(wire)?formatted:wire);return task.validator.parse(prose('The count at {{row_a_a}} was {{row_a_b}}.'));},locale,answerTaskFor);
  assert.equal(calls,1);assert.equal(reply.answer,`The count at ${normalized.includes(wire)?formatted:wire} was 42.`);assert.equal(reply.research.rows[0][0],wire);
 }
});
