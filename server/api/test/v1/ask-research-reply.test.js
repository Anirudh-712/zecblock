'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {researchReply,researchFacts,researchTemplate,captionTask}=require('../../v1/lib/ask-research-reply');
const metadata={truncated:false,fingerprint:'a'.repeat(64),retrievedAt:'2026-10-29T00:00:00Z',indexedThrough:'2026-10-29T00:00:00Z',coverage:'verified canonical records',units:'exact decimal strings'};
const research=(sql,columns,rows,extra={})=>({query:{version:3,sql,limit:100},columns:columns.map(([label,type],i)=>({key:'c'+i,label,type})),rows,datasets:['blocks'],...metadata,...extra});
const caption=summary=>async()=>({summary});

// Observed on mainnet staging: last 1,000 blocks payout share. The model
// caption failed number checks and the reply fell back to a bare receipt.
const payout=research("WITH recent AS (SELECT miner FROM blocks ORDER BY height DESC LIMIT 1000) SELECT miner,count(*) AS blocks,round(100.0*count(*)/sum(count(*)) OVER(),2) AS share_pct FROM recent GROUP BY miner ORDER BY blocks DESC",
 [['miner','text'],['blocks','number'],['share_pct','number']],
 [['t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7','285','28.50'],['t1SqwRAAdSig6dE4EBPLonAait219VmkUjP','172','17.20'],['t1PEp2GJLSdhDfCKqc2J211WKDUS1NfoQNy','145','14.50'],[null,'51','5.10']]);
const payoutTemplate='The first of 4 returned rows is t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7, with 285 blocks and share_pct 28.5%. Next are t1SqwRAAdSig6dE4EBPLonAait219VmkUjP (172 blocks) and t1PEp2GJLSdhDfCKqc2J211WKDUS1NfoQNy (145 blocks).';

test('payout share regression: a failed caption falls back to a readable fact template, never a bare receipt',async()=>{
 const before=structuredClone(payout);let calls=0;
 for(const summary of ['The leading payout address found 285 blocks.','The leader holds {{row_a_c}} of {{total_blocks}} blocks.','{{row_a_b}} {{row_a_c}} blocks.','The leader holds {{row_a_b}} ZEC.']){
  const reply=await researchReply(payout,{question:'Who received the most payouts in the last 1,000 blocks?'},async()=>{calls++;return {summary};},'en');
  assert.equal(reply.answer,payoutTemplate,summary);assert.doesNotMatch(reply.answer,/Your query returned|table below/);
  assert.deepEqual(reply.research,before);assert.equal(reply.evidenceKey,before.fingerprint);assert.ok(reply.sources.length);
 }
 // Exactly one provider call per reply: there is no paid repair retry.
 assert.equal(calls,4);assert.deepEqual(payout,before);
});

test('payout share regression: a valid caption uses only checked facts and the column-label unit',async()=>{
 let seen;
 const reply=await researchReply(payout,{question:'Who received the most payouts?',history:[]},async(input,task)=>{
  seen=input;assert.equal(task.name,'research_caption');
  assert.equal(task.validator.safeParse({summary:'The leader found 285 blocks.'}).success,false);
  assert.equal(task.validator.safeParse({summary:'Ok.',observations:[]}).success,false);
  return task.validator.parse({summary:'{{row_a_a}} leads with {{row_a_b}} blocks, a {{row_a_c}} share; the smallest returned share is {{min_c}}.'});
 },'en');
 assert.equal(reply.answer,'t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7 leads with 285 blocks, a 28.5% share; the smallest returned share is 5.1%.');
 assert.deepEqual(seen.evidence.facts,{
  row_count:'4',
  row_a_a:'t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7',row_a_b:'285',row_a_c:'28.5%',
  row_b_a:'t1SqwRAAdSig6dE4EBPLonAait219VmkUjP',row_b_b:'172',row_b_c:'17.2%',
  row_c_a:'t1PEp2GJLSdhDfCKqc2J211WKDUS1NfoQNy',row_c_b:'145',row_c_c:'14.5%',
  max_b:'285',max_b_at:'t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7',min_b:'51',min_b_at:'null',
  max_c:'28.5%',max_c_at:'t1MKn34KBa8Xh4g8qU8psibBXvURafphVn7',min_c:'5.1%',min_c_at:'null',
 });
 assert.deepEqual(seen.evidence.columns.map(c=>c.unit),['unlabelled','unlabelled','percent']);
 assert.equal(seen.evidence.sql,payout.query.sql);
 // A percent fact already carries its unit; repeating it is de-duplicated.
 assert.equal((await researchReply(payout,{},caption('The leader holds {{row_a_c}} percent of payouts.'),'en')).answer,'The leader holds 28.5% of payouts.');
});

test('facts preserve NULL, skip NULL in extrema and never name a tied extreme',async()=>{
 const result=research('SELECT pool,amount FROM flows',[['pool','text'],['amount','number']],[[null,'10'],['orchard',null],['sapling','10'],['ironwood','3']]);
 const {facts}=researchFacts(result,[],'en');
 assert.equal(facts.row_a_a,'null');assert.equal(facts.row_b_b,'unavailable');
 assert.equal(facts.max_b,'10');assert.equal(facts.max_b_at,undefined,'tied maximum has no single row');
 assert.equal(facts.min_b,'3');assert.equal(facts.min_b_at,'ironwood');
 assert.equal(researchFacts(research('SELECT 1 AS n',[['n','number']],[['1']]),[],'en').facts.max_a,undefined,'one value has no range');
});

test('monetary units need SQL lineage; aliases alone never relabel zatoshis',async()=>{
 const one=(sql,label,value)=>research(sql,[[label,'number']],[[value]]);
 const fact=async result=>{let facts;await researchReply(result,{},async input=>{facts=input.evidence.facts;return {summary:'x'};},'en');return facts.row_a_a;};
 assert.equal(await fact(one('SELECT avg(fees) AS average_fee FROM blocks','average_fee','225510.400')),'225,510.4 zatoshis');
 assert.equal(await fact(one('SELECT avg(fees)::numeric/100000000 AS fee_zec FROM blocks','fee_zec','0.002255104')),'0.002255104 ZEC');
 assert.equal(await fact(one('SELECT avg(fees) AS fee_zec FROM blocks','fee_zec','225510.4')),'225,510.4','contradicting alias stays unlabelled');
 assert.equal(await fact(one('SELECT sqrt(avg(fees)) AS fee_zec FROM blocks','fee_zec','474.9')),'474.9','unproven lineage stays unlabelled');
 assert.equal(await fact(one('SELECT count(*) AS n_usd FROM blocks','n_usd','4')),'4');
});

test('dates: strict UTC-midnight wires become readable; a month-labelled first-day column names the month',async()=>{
 const day='2026-01-31',formatted=new Date(day+'T00:00:00Z').toLocaleDateString('en',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'});
 for(const wire of [day,day+' 00:00:00',day+'T00:00:00Z',day+' 00:00:00+00:00'])assert.equal(researchFacts(research('SELECT d',[['d','text'],['n','number']],[[wire,'1']]),[],'en').facts.row_a_a,formatted,wire);
 for(const wire of [day+' 00:00:01',day+'T01:00:00Z','2026-02-30','2026-13-01 00:00:00',day+' sample label'])assert.equal(researchFacts(research('SELECT d',[['d','text'],['n','number']],[[wire,'1']]),[],'en').facts.row_a_a,wire,wire);
 const monthly=research('SELECT month',[['month','text'],['n','number']],[['2025-09-01','1'],['2025-10-01 00:00:00+00','2']]);
 assert.equal(researchFacts(monthly,[],'en').facts.row_b_a,'October 2025');
 assert.equal(researchFacts(monthly,[],'fr').facts.row_a_a,'septembre 2025');
 // A month label over a non-first day is an observation date, not a month.
 assert.match(researchFacts({...monthly,rows:[['2025-09-03','1']]},[],'en').facts.row_a_a,/3/);
 assert.match(researchFacts({...monthly,columns:[{key:'c0',label:'day',type:'text'},monthly.columns[1]]},[],'en').facts.row_a_a,/Sep 1, 2025/);
});

test('captions reject literal numbers, calendar names, tables and invented placeholders without a second call',async()=>{
 const result=research('SELECT date,shielded_transactions FROM activity_daily ORDER BY date',[['date','text'],['shielded_transactions','number']],[['2025-09-01','17451'],['2025-10-01','53175']]);
 const template=researchTemplate(result,researchFacts(result,[],'en'));
 assert.equal(template,'The first of 2 returned rows is Sep 1, 2025, with 17,451 shielded_transactions. It is followed by Oct 1, 2025 (53,175 shielded_transactions).');
 for(const summary of ['October had the most shielded transactions at {{max_b}}.','Shielded transactions grew by 35,724.','Date | Count\n{{row_a_a}} | {{row_a_b}}','The peak was {{row_z_b}}.','The peak was {{max_b}}','No figure is cited here.']){
  let calls=0;
  const reply=await researchReply(result,{question:'Explain'},async()=>{calls++;return {summary};},'en');
  assert.equal(calls,1);assert.equal(reply.answer,template,summary);
 }
 assert.equal((await researchReply(result,{},caption('The peak of {{max_b}} came on {{max_b_at}}.'),'en')).answer,'The peak of 53,175 came on Oct 1, 2025.');
});

test('template covers single rows, unlabelled numeric results and truncation',()=>{
 const single=research('SELECT count(*) AS total FROM transactions',[['total','number']],[['542746']]);
 assert.equal(researchTemplate(single,researchFacts(single,[],'en')),'The single returned row has total 542,746.');
 const heights=research('SELECT height FROM blocks',[['height','number']],[['100'],['101']],{truncated:true});
 assert.equal(researchTemplate(heights,researchFacts(heights,[],'en')),'The first of 2 returned rows (truncated at the query limit) has height 100. Across all returned rows, height ranges from 100 to 101.');
 const labels=research('SELECT pool FROM flows',[['pool','text']],[['orchard'],['sapling']]);
 assert.equal(researchTemplate(labels,researchFacts(labels,[],'en')),'The first of 2 returned rows is orchard. It is followed by sapling.');
});

test('evidence stays bounded for wide and long results',async()=>{
 const wide=research('SELECT *',Array.from({length:24},(_,i)=>['measure_'+i,'text']),Array.from({length:200},()=>Array(24).fill('x'.repeat(2048))));
 let size=0;await researchReply(wide,{},async input=>{size=Buffer.byteLength(JSON.stringify(input.evidence));return {summary:'{{row_a_a}}.'};},'en');
 assert.ok(size<12000,String(size));
 assert.ok(Object.keys(captionTask(researchFacts(wide,[],'en').facts).schema.properties).length===1);
});

test('empty results and a wholly wrong requested year never call the model',async()=>{
 const empty=await researchReply(research('SELECT height FROM blocks',[['height','number']],[]),{},()=>assert.fail('no paid caption'),'fr');
 assert.match(empty.answer,/does not establish zero activity/);
 const months=research("SELECT date_trunc('month',date) AS month,sum(transactions) FROM activity_daily GROUP BY 1",[['month','text'],['n','number']],[['2020-01-01','1']]);
 await assert.rejects(researchReply(months,{question:'Monthly counts during 2025'},()=>assert.fail('wrong year'),'en'),e=>e.askKind==='answer');
});
