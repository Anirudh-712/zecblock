'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compileResearchSQL,researchEvidence}=require('../../v1/lib/ask-research-sql');
const {researchObservedColumns,poolProvenanceMatches,researchGroundedSummary}=require('../../v1/lib/ask-research-grounded-summary');
const {researchReply}=require('../../v1/lib/ask-research-reply');
const {answerTaskFor}=require('../../v1/lib/ask-chat');
const sql='SELECT date AS observed_date,orchard::numeric/100000000 AS stock_a,ironwood::numeric/100000000 AS stock_b FROM daily ORDER BY date';
const rows=[['2026-08-31','100','50'],['2026-09-30','90','60']],labels=['observed_date','stock_a','stock_b'];
const question='Compare the observed Orchard and Ironwood balances and explain the larger Ironwood balance.';
const date=value=>new Date(value+'T00:00:00Z').toLocaleDateString('en',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'});
async function fixture(statement=sql,values=rows,names=labels,types=names.map((_,i)=>i?'number':'text')){
 const compiled=await compileResearchSQL({version:3,sql:statement,limit:100},{extended:true});
 return researchEvidence(compiled,values,names.map((name,i)=>({name,dataTypeID:types[i]==='text'?25:1700})),{indexed_through:'2026-10-28T00:00:00Z'},'2026-10-28T00:00:01Z');
}
async function summary(result,input=question,locale='en'){return researchGroundedSummary(result,await researchObservedColumns(result.query.sql),input,locale);}
const prose=summary=>({summary,observations:[],limitation:'',sources:['pools']});

test('direct source meanings survive harmless aliases and position changes without trusting output names',async()=>{
 const result=await fixture(),metadata=await researchObservedColumns(result.query.sql);
 assert.deepEqual(metadata.map(({source,field,kind,unit})=>({source,field,kind,unit})),[{source:'daily',field:'date',kind:'observation-date',unit:'date'},{source:'daily',field:'orchard',kind:'measure',unit:'zec'},{source:'daily',field:'ironwood',kind:'measure',unit:'zec'}]);
 const answer=await summary(result);assert.match(answer,/the Ironwood balance was larger/);assert.ok(answer.includes(`at 60 ZEC, compared with 50 ZEC on ${date('2026-08-31')}`));assert.ok(answer.indexOf('Ironwood')<answer.indexOf('Orchard'));
 const reordered=await fixture('SELECT ironwood::numeric/100000000 AS another, date AS actual_day, orchard::numeric/100000000 AS anything FROM daily ORDER BY date',rows.map(row=>[row[2],row[0],row[1]]),['another','actual_day','anything'],['number','text','number']);
 assert.equal(await summary(reordered),answer);
});

test('simple CTE, subquery and column aliases preserve direct origins through exact conversions',async()=>{
 for(const statement of [
  'WITH sample(d,a,b) AS(SELECT date,orchard,ironwood FROM daily) SELECT d AS observed_date,a::numeric/100000000 AS stock_a,b::numeric/100000000 AS stock_b FROM sample ORDER BY d',
  'SELECT s.d AS observed_date,s.a::numeric/1e8 AS stock_a,0.00000001*s.b AS stock_b FROM (SELECT date,orchard,ironwood FROM daily) AS s(d,a,b) ORDER BY s.d',
  'WITH sample AS(SELECT date,orchard::numeric AS a,ironwood::numeric AS b FROM daily) SELECT date AS observed_date,a/100000000 AS stock_a,b*1e-8 AS stock_b FROM sample ORDER BY date',
 ])assert.match(await summary(await fixture(statement)),/Ironwood balance was larger/);
});

test('the actual monthly closing shape keeps the observation date and ignores an unproven lag difference',async()=>{
 const statement="WITH ranked AS(SELECT date,date_trunc('month',date::timestamp)::date AS month_bucket,orchard,ironwood,row_number() OVER(PARTITION BY date_trunc('month',date::timestamp) ORDER BY date DESC) AS position FROM daily WHERE date>=DATE '2026-08-01' AND date<DATE '2026-10-01'), selected AS(SELECT month_bucket,date AS observed_date,orchard::numeric/100000000 AS orchard_zec,ironwood::numeric/100000000 AS ironwood_zec FROM ranked WHERE position=1) SELECT month_bucket,observed_date,orchard_zec,ironwood_zec,ironwood_zec-lag(ironwood_zec) OVER(ORDER BY month_bucket) AS ironwood_change_vs_prior_observation_zec FROM selected ORDER BY month_bucket";
 const result=await fixture(statement,[['2026-08-01','2026-08-31','100','50',null],['2026-09-01','2026-09-30','90','60','10']],['month_bucket','observed_date','orchard_zec','ironwood_zec','ironwood_change_vs_prior_observation_zec'],['text','text','number','number','number']);
 const before=structuredClone(result),metadata=await researchObservedColumns(result.query.sql);
 assert.equal(metadata[0].kind,'month-bucket');assert.equal(metadata[1].kind,'observation-date');assert.equal(metadata[4].unit,'unknown');
 for(const generated of ["Ironwood's larger closing balance was observed in September, at {{row_b_d}} ZEC, compared with {{row_a_d}} ZEC in August.","September had the larger Ironwood balance at {{row_b_d}} ZEC. Orchard held {{row_b_c}} ZEC."]){
  let calls=0;const reply=await researchReply(result,{question,history:[]},async()=>{calls++;return prose(generated);},'en',answerTaskFor);
  assert.equal(calls,1,'proven fallback avoids an unnecessary paid format repair');assert.match(reply.answer,/Among the returned observations, the Ironwood balance was larger/);assert.ok(reply.answer.includes(date('2026-09-30')));assert.ok(reply.answer.includes(date('2026-08-31')));assert.doesNotMatch(reply.answer,/Your query returned|could not be verified|month.end|crossing|change was/);assert.deepEqual(reply.research,before);assert.equal(reply.evidenceKey,result.fingerprint);
 }
 assert.equal(await summary(result,'Which observation had the greatest Ironwood change?'),null);
});

test('valid generated prose is preserved and no grounded or format retry adds a provider call',async()=>{
 const result=await fixture();let calls=0;
 const reply=await researchReply(result,{question,history:[]},async()=>{calls++;return prose('The Ironwood balance was {{row_b_c}} ZEC on {{row_b_a}}.');},'en',answerTaskFor);
 assert.equal(calls,1);assert.equal(reply.answer,`The Ironwood balance was 60 ZEC on ${date('2026-09-30')}.`);
});

test('old paired-pool answers and evidence require actual pool identities, not matching labels and units',async()=>{
 const swapped=await fixture('SELECT date,ironwood::numeric/1e8 AS orchard_zec,orchard::numeric/1e8 AS ironwood_zec FROM daily',rows.map(row=>[row[0],row[2],row[1]]),['date','orchard_zec','ironwood_zec']);
 const metadata=await researchObservedColumns(swapped.query.sql);assert.equal(poolProvenanceMatches(swapped,metadata),false);assert.equal(await summary(swapped),null);
 let calls=0;const reply=await researchReply(swapped,{question,history:[]},async(input)=>{calls++;assert.equal(input.evidence.comparison,undefined);assert.equal(input.evidence.facts.first_returned_ironwood_lead_date,undefined);return prose('The table is available below.');},'en',answerTaskFor);
 assert.equal(calls,1);assert.match(reply.answer,/^Your query returned 2 records/);assert.deepEqual(reply.research,swapped);
 const proper=await fixture('SELECT date,orchard::numeric/1e8 AS orchard_zec,ironwood::numeric/1e8 AS ironwood_zec FROM daily',rows,['date','orchard_zec','ironwood_zec']);
 assert.equal(poolProvenanceMatches(proper,await researchObservedColumns(proper.query.sql)),true);
 const checked=await researchReply(proper,{question,history:[]},()=>assert.fail('proven existing shortcut stays deterministic'),'en',answerTaskFor);
 assert.match(checked.answer,/Ironwood balance was larger/,'the checked shortcut answers the requested leader explicitly');
 assert.ok(checked.answer.includes(date('2026-09-30')));assert.ok(checked.answer.includes('60 ZEC'));
});

test('constant, aggregated, composed, coalesced and cross-joined values never acquire observed stock meaning',async()=>{
 for(const statement of [
  "SELECT DATE '2026-09-30' AS observed_date,orchard::numeric/1e8 AS stock_a,ironwood::numeric/1e8 AS stock_b FROM daily",
  "SELECT date_trunc('month',date::timestamp)::date AS observed_date,orchard::numeric/1e8 AS stock_a,ironwood::numeric/1e8 AS stock_b FROM daily",
  'SELECT date AS observed_date,sum(orchard)::numeric/1e8 AS stock_a,avg(ironwood)::numeric/1e8 AS stock_b FROM daily GROUP BY date',
  'SELECT max(date) AS observed_date,min(orchard)::numeric/1e8 AS stock_a,max(ironwood)::numeric/1e8 AS stock_b FROM daily',
  'SELECT date AS observed_date,(orchard+0)::numeric/1e8 AS stock_a,(ironwood-orchard)::numeric/1e8 AS stock_b FROM daily',
  'SELECT date AS observed_date,coalesce(orchard,0)::numeric/1e8 AS stock_a,coalesce(ironwood,0)::numeric/1e8 AS stock_b FROM daily',
  'SELECT a.date AS observed_date,a.orchard::numeric/1e8 AS stock_a,b.ironwood::numeric/1e8 AS stock_b FROM daily a JOIN daily b ON a.date=b.date',
  'SELECT date AS observed_date,100::numeric AS stock_a,count(*) OVER() AS stock_b FROM daily',
 ])assert.equal(await summary(await fixture(statement)),null,statement);
});

test('integer truncation, floating casts, precision casts and repeated conversion cannot inherit exact stock meanings',async()=>{
 for(const expression of ['ironwood/100000000','ironwood::float8/1e8','ironwood::numeric(3,0)/1e8','(ironwood::numeric/1e8)::numeric(3,0)','(ironwood::numeric/1e8)::bigint','ironwood::numeric/1e8/1e8','round(ironwood::numeric/1e8,2)','sqrt(ironwood)']){
  const result=await fixture(`SELECT date AS observed_date,${expression} AS stock_b FROM daily`,rows.map(row=>[row[0],row[2]]),['observed_date','stock_b']);assert.equal(await summary(result,'Compare the observed Ironwood balances.'),null,expression);
 }
 const raw=await fixture('SELECT date AS observed_date,ironwood AS stock_b FROM daily',[['2026-08-31','5000000000'],['2026-09-30','6000000000']],['observed_date','stock_b']);
 assert.match(await summary(raw,'Compare the observed Ironwood balances.'),/6,000,000,000 zatoshis/);
 const mislabeled=await fixture('SELECT date AS observed_date,ironwood AS ironwood_zec FROM daily',[['2026-08-31','5000000000'],['2026-09-30','6000000000']],['observed_date','ironwood_zec']);assert.equal(await summary(mislabeled,'Compare Ironwood balances.'),null);
});

test('nulls, true zero, ties and very large exact decimals retain their distinct meanings',async()=>{
 const make=values=>fixture('SELECT date AS observed_date,ironwood::numeric/1e8 AS value FROM daily',values,['observed_date','value']);
 assert.match(await summary(await make([['2026-08-31','0'],['2026-09-30','0']]),'Compare Ironwood balances.'),/joint highest.*at 0 ZEC, compared with 0 ZEC/);
 assert.match(await summary(await make([['2026-08-31',null],['2026-09-30','0']]),'Compare Ironwood balances.'),/was 0 ZEC.*other returned observations had no known value/);
 assert.equal(await summary(await make([['2026-08-31',null],['2026-09-30',null]]),'Compare Ironwood balances.'),'The Ironwood balance was unavailable in all returned observations.');
 const exact=await summary(await make([['2026-08-31','9007199254740993.12345678901234567890'],['2026-09-30','9007199254740993.12345678901234567891']]),'Compare Ironwood balances.');assert.ok(exact.includes('9,007,199,254,740,993.12345678901234567891 ZEC'));assert.ok(exact.indexOf(date('2026-09-30'))<exact.indexOf(date('2026-08-31')));
 assert.equal(await summary(await make([['2026-08-31','-1'],['2026-09-30','0']]),'Compare Ironwood balances.'),null);
});

test('more than two observations use exact available maxima and acknowledge ties and missing observations',async()=>{
 const result=await fixture('SELECT date AS observed_date,ironwood::numeric/1e8 AS value FROM daily',[['2026-09-30','10'],['2026-08-31','10'],['2026-07-31',null],['2026-06-30','9']],['observed_date','value']);
 const answer=await summary(result,'Show the highest observed Ironwood balance.');assert.match(answer,/returned observations with known values/);assert.match(answer,/highest Ironwood balance was 10 ZEC/);assert.match(answer,/Other returned observations tied this value/);assert.ok(answer.includes(date('2026-08-31')));assert.doesNotMatch(answer,/uniqu|month.end|closing/);
});

test('intent selection abstains from unsupported changes, shares, forecasts, minima and ambiguous metric requests',async()=>{
 const result=await fixture();
 for(const input of ['Show the Ironwood percentage share.','Explain the largest Ironwood change.','Compare Ironwood growth.','What will the Ironwood balance be next month?','Show the lowest Ironwood balance.','Explain average Ironwood balances.','Why did Ironwood increase?','Compare Sapling balances.','Which pool had the largest balance?'])assert.equal(await summary(result,input),null,input);
});

test('daily activity counts use reviewed source meanings while fees and bytes require proven zero missing counts',async()=>{
 const counts=await fixture('SELECT date AS observed_date,shielded_transactions AS n FROM activity_daily',[['2026-08-31','10'],['2026-09-30','20']],['observed_date','n']);assert.match(await summary(counts,'Compare shielded transaction counts.'),/shielded transaction count.*20 transactions/);
 for(const [field,values]of [['fees',['0.1','0.2']],['bytes',['1000','2000']]]){
  const expression=field==='fees'?'fees::numeric/1e8':field,make=(missing=['0','0'])=>fixture(`SELECT date AS observed_date,${expression} AS v,missing_${field} AS m FROM activity_daily`,[['2026-08-31',values[0],missing[0]],['2026-09-30',values[1],missing[1]]],['observed_date','v','m']);
  const input=`Compare the daily ${field}.`;assert.ok(await summary(await make(),input));assert.equal(await summary(await make(['0','1']),input),null);
  const absent=await fixture(`SELECT date AS observed_date,${expression} AS v FROM activity_daily`,[['2026-08-31',values[0]],['2026-09-30',values[1]]],['observed_date','v']);assert.equal(await summary(absent,input),null);
 }
});

test('invalid, partial, duplicate or unreturned dates and mismatched metadata never become observations',async()=>{
 const result=await fixture();
 for(const change of [{truncated:true},{rows:[]},{rows:[rows[0]]},{rows:[['2026-08','100','50'],rows[1]]},{rows:[['2026-02-30','100','50'],rows[1]]},{rows:[rows[0],rows[0]]},{rows:[rows[0],['2026-09-30','90']]},{columns:result.columns.map((column,i)=>i===1?{...column,label:'wrong_name'}:column)}])assert.equal(await summary({...result,...change}),null,JSON.stringify(change));
 assert.equal(await summary(result,question,'fr'),null);
});


test('full catalogue order and partial source-column aliases cannot turn daily counts into pool stocks',async()=>{
 const positive=await fixture('SELECT d AS observed_date,o::numeric/1e8 AS stock_a,i::numeric/1e8 AS stock_b FROM daily AS x(d,t,s,u,o,i)');
 assert.match(await summary(positive),/Ironwood balance was larger/);
 const star=await fixture('WITH all_fields AS(SELECT * FROM daily) SELECT date AS observed_date,orchard::numeric/1e8 AS stock_a,ironwood::numeric/1e8 AS stock_b FROM all_fields');assert.match(await summary(star),/Ironwood balance was larger/);
 const negative=await fixture('SELECT d AS observed_date,a::numeric/1e8 AS stock_a,b::numeric/1e8 AS stock_b FROM daily AS x(d,a,b,c,e)');assert.equal(await summary(negative),null);
});

test('the legacy paired-level shortcut cannot answer a share, change or forecast question',async()=>{
 const result=await fixture('SELECT date,orchard::numeric/1e8 AS orchard_zec,ironwood::numeric/1e8 AS ironwood_zec FROM daily',rows,['date','orchard_zec','ironwood_zec']);
 for(const input of ['Explain the Ironwood share.','Explain the largest Ironwood change.','Predict the next Ironwood balance.']){
  let calls=0;const reply=await researchReply(result,{question:input,history:[]},async(supplied)=>{calls++;assert.ok(supplied.evidence.comparison);return prose('The requested derived measure is not present in these returned columns.');},'en',answerTaskFor);
  assert.equal(calls,1,input);assert.match(reply.answer,/^Your query returned 2 records/);assert.deepEqual(reply.research,result);
 }
});
