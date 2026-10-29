'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {researchReply}=require('../../v1/lib/ask-research-reply');
const {answerTaskFor}=require('../../v1/lib/ask-chat');
const {compileResearchSQL,researchEvidence}=require('../../v1/lib/ask-research-sql');
const sql="SELECT date_trunc('month',date::timestamp)::date AS month,sum(transactions) AS total_non_coinbase_transactions,sum(shielded_transactions) AS shielded_transactions,sum(transparent_transactions) AS transparent_transactions,sum(unclassified_transactions) AS unclassified_transactions,round(100.0*sum(shielded_transactions)/nullif(sum(transactions),0),2) AS shielded_pct_of_all_transactions FROM activity_daily WHERE date>=DATE '2026-09-01' AND date<DATE '2026-10-01' GROUP BY date_trunc('month',date::timestamp)::date";
const labels=['month','total_non_coinbase_transactions','shielded_transactions','transparent_transactions','unclassified_transactions','shielded_pct_of_all_transactions'];
const rows=[['2026-09-01','363162','209837','153325','0','57.78']];
const locale='en',month=new Date('2026-09-01T00:00:00Z').toLocaleDateString(locale,{timeZone:'UTC',month:'long',year:'numeric'}),day=value=>new Date(value+'T00:00:00Z').toLocaleDateString(locale,{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'});
const question='For September 2026 show total, shielded, transparent and unclassified non-coinbase counts, plus shielded percentage of all transactions including unclassified. Explain the share.';
const prose=summary=>({summary,observations:[],limitation:'',sources:['transactions']});
async function fixture(statement=sql,values=rows,names=labels,types=names.map((_,i)=>i?'number':'text')){const compiled=await compileResearchSQL({version:3,sql:statement,limit:100},{extended:true});return researchEvidence(compiled,values,names.map((name,i)=>({name,dataTypeID:types[i]==='text'?25:1700})),{indexed_through:'2026-10-28T00:00:00Z'},'2026-10-28T00:00:01Z');}

test('the reported monthly classification aggregate supplies a calendar period instead of a first-day observation',async()=>{
 const result=await fixture(),before=structuredClone(result);let calls=0;
 const reply=await researchReply(result,{question,history:[]},async(input,task)=>{calls++;assert.equal(input.evidence.facts.row_a_a,month);assert.equal(input.evidence.columns[0].calendarBucket,'month');assert.equal(input.evidence.facts.row_a_b,'363,162');assert.equal(input.evidence.facts.row_a_f,'57.78');return task.validator.parse(prose('For {{row_a_a}}, there were {{row_a_b}} total non-coinbase transactions. Shielded transactions were {{row_a_f}}% of all transactions.'));},locale,answerTaskFor);
 assert.equal(calls,1);assert.ok(reply.answer.startsWith('For '+month+','));assert.doesNotMatch(reply.answer,/Sep(?:tember)? 1,/);assert.deepEqual(result,before);assert.deepEqual(reply.research,before);assert.equal(reply.evidenceKey,before.fingerprint);
});

test('source month lineage survives CTE positional aliases and reordered projection',async()=>{
 const statement='WITH counts(bucket,total,shielded,transparent,unclassified,share) AS('+sql+') SELECT total AS n,bucket AS period,share AS pct FROM counts';
 const result=await fixture(statement,[['363162','2026-09-01','57.78']],['n','period','pct'],['number','text','number']),before=structuredClone(result);let calls=0;
 const reply=await researchReply(result,{question,history:[]},async(input,task)=>{calls++;assert.equal(input.evidence.facts.row_a_b,month);assert.equal(input.evidence.columns[1].calendarBucket,'month');assert.equal(input.evidence.columns[0].calendarBucket,undefined);return task.validator.parse(prose('For {{row_a_b}}, the total count was {{row_a_a}}.'));},locale,answerTaskFor);
 assert.equal(calls,1);assert.equal(reply.answer,'For '+month+', the total count was 363,162.');assert.deepEqual(reply.research,before);
});

test('an arbitrary column named month containing an actual source date remains a daily observation',async()=>{
 const result=await fixture("SELECT date AS month,transactions AS n FROM activity_daily WHERE date=DATE '2026-09-01'",[['2026-09-01','100']],['month','n']);
 const reply=await researchReply(result,{question:'Explain the returned count.',history:[]},async(input,task)=>{assert.equal(input.evidence.columns[0].calendarBucket,undefined);assert.equal(input.evidence.facts.row_a_a,day('2026-09-01'));return task.validator.parse(prose('The observed count on {{row_a_a}} was {{row_a_b}}.'));},locale,answerTaskFor);
 assert.ok(reply.answer.includes(day('2026-09-01')));assert.equal(reply.research.rows[0][0],'2026-09-01');
});

test('ordinary source daily observations keep their exact dates and raw cells',async()=>{
 const result=await fixture("SELECT date,transactions AS n FROM activity_daily WHERE date>=DATE '2026-09-01' AND date<DATE '2026-09-03' ORDER BY date",[['2026-09-01','100'],['2026-09-02','200']],['date','n']),before=structuredClone(result);
 const reply=await researchReply(result,{question:'Describe these returned values.',history:[]},async(input,task)=>{assert.equal(input.evidence.columns[0].calendarBucket,undefined);assert.equal(input.evidence.facts.row_a_a,day('2026-09-01'));assert.equal(input.evidence.facts.row_b_a,day('2026-09-02'));return task.validator.parse(prose('The later returned count was {{row_b_b}} on {{row_b_a}}.'));},locale,answerTaskFor);
 assert.deepEqual(reply.research,before);assert.ok(reply.answer.includes(day('2026-09-02')));
});

test('fabricated, offset and unresolved date expressions cannot gain month meaning from aliases',async()=>{
 const statements=["SELECT DATE '2026-09-01' AS month,sum(transactions) AS n FROM activity_daily","SELECT (date_trunc('month',date::timestamp)+INTERVAL '1 day')::date AS month,sum(transactions) AS n FROM activity_daily GROUP BY 1","SELECT date_trunc('month',date::timestamptz)::date AS month,sum(transactions) AS n FROM activity_daily GROUP BY 1"];
 for(const statement of statements){const result=await fixture(statement,[['2026-09-01','100']],['month','n']);const reply=await researchReply(result,{question:'Explain this returned count.',history:[]},async(input,task)=>{assert.equal(input.evidence.columns[0].calendarBucket,undefined,statement);assert.equal(input.evidence.facts.row_a_a,day('2026-09-01'),statement);return task.validator.parse(prose('The returned count at {{row_a_a}} was {{row_a_b}}.'));},locale,answerTaskFor);assert.ok(reply.answer.includes(day('2026-09-01')));}
});

test('month provenance requires exact result column-name, key and width association',async()=>{
 for(const alter of [result=>{result.columns[0].label='some_day';},result=>{result.columns[1].label='different_count';},result=>{result.columns.push({key:'c6',label:'extra',type:'number'});result.rows[0].push('1');}]){
  const result=await fixture();alter(result);const before=structuredClone(result);
  await researchReply(result,{question:'Explain this returned count.',history:[]},async(input,task)=>{assert.equal(input.evidence.columns[0].calendarBucket,undefined);assert.equal(input.evidence.facts.row_a_a,day('2026-09-01'));return task.validator.parse(prose('The returned count at {{row_a_a}} was {{row_a_b}}.'));},locale,answerTaskFor);assert.deepEqual(result,before);
 }
});

test('only strict valid first-of-month UTC-midnight wires receive calendar-month formatting',async()=>{
 const valid=['2026-09-01','2026-09-01 00:00:00','2026-09-01T00:00:00.000Z','2026-09-01 00:00:00+00'];
 for(const wire of valid){const result=await fixture(sql,[[wire,...rows[0].slice(1)]]);await researchReply(result,{question,history:[]},async(input,task)=>{assert.equal(input.evidence.facts.row_a_a,month,wire);return task.validator.parse(prose('The returned count for {{row_a_a}} was {{row_a_b}}.'));},locale,answerTaskFor);}
 for(const wire of ['2026-09-02','2026-09-01 00:00:01','2026-09-01 00:00:00+01','2026-02-30']){const result=await fixture(sql,[[wire,...rows[0].slice(1)]]);await researchReply(result,{question,history:[]},async(input,task)=>{assert.equal(input.evidence.columns[0].calendarBucket,undefined,wire);assert.notEqual(input.evidence.facts.row_a_a,month,wire);assert.equal(input.evidence.facts.row_a_a,wire==='2026-09-02'?day(wire):wire,wire);return task.validator.parse(prose('The returned count at {{row_a_a}} was {{row_a_b}}.'));},locale,answerTaskFor);}
});
