'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compileResearchSQL,instructionsFor}=require('../../v1/lib/ask-research-sql');
const {catalogueFor}=require('../../../../lib/ask/research-catalogue');
const {metricFields,recordMetrics}=require('../../v1/lib/ask-research-metrics');
const {cacheKey}=require('../../v1/lib/ask-research-cache');
test('extended schemas remain explicit opt-in at every compiler boundary',async()=>{
 for(const d of catalogueFor(true).slice(3)){const q={version:3,sql:'SELECT * FROM '+d.id,limit:10};await assert.rejects(compileResearchSQL(q));const c=await compileResearchSQL(q,{extended:true});assert.deepEqual(c.datasets,[d.id]);assert.match(c.text,new RegExp('analytics_public.'+d.id+'_query'));}
 assert.match(instructionsFor(true),/Prefer activity_daily/);assert.match(instructionsFor(true),/Never pass a date or timestamp into to_timestamp/);assert.match(instructionsFor(true),/array_agg, arrays and subscripting are not enabled/);assert.match(instructionsFor(true),/unfinished\/stale dataset fails/);assert.doesNotMatch(instructionsFor(false),/Additional published schemas/);
});
test('extension never permits dangerous constructs or raw/metadata access',async()=>{
 for(const sql of ["DELETE FROM addresses","SELECT * FROM public.addresses","SELECT * FROM analytics_meta.dataset_state","SELECT pg_read_file('/etc/passwd') FROM swaps","SELECT subconninfo FROM pg_subscription","SELECT pg_sleep(10) FROM daily","WITH address_activity AS(SELECT height FROM blocks) SELECT * FROM address_activity","SELECT * INTO broken FROM activity_daily"]){await assert.rejects(compileResearchSQL({version:3,sql,limit:1},{extended:true}));}
});
test('anonymous telemetry accepts only fixed categories and contains no input or identifiers',async()=>{
 const fields=metricFields({outcome:'success',datasets:['swaps','daily','swaps'],elapsedMs:1250,question:'private',sql:'secret',ip:'1.2.3.4',address:'t1private'});
 assert.deepEqual(fields,['requests','outcome:success','duration:1_5s','dataset:daily','dataset:swaps']);
 for(const record of [{outcome:'secret',elapsedMs:1},{outcome:'success',datasets:['t1private'],elapsedMs:1},{outcome:'success',elapsedMs:NaN}])assert.throws(()=>metricFields(record));
 let request;await recordMetrics({isReady:true,eval:async(_,value)=>{request=value;}},{outcome:'timeout',datasets:['flows'],elapsedMs:31000},Date.UTC(2026,9,7));
 assert.deepEqual(request,{keys:['ask:{mainnet}:research-counts:v1:2026-10-07'],arguments:['requests','outcome:timeout','duration:30s_plus','dataset:flows']});
 await recordMetrics({isReady:true,eval:async()=>{throw Error('Redis failed');}},{outcome:'success',elapsedMs:10});
});
test('independent refresh generations invalidate cached joined results',async()=>{
 const c=await compileResearchSQL({version:3,sql:'SELECT * FROM swaps',limit:10},{extended:true});const checkpoint={tip_hash:'a'.repeat(64),verified_at:'2026-10-07T00:00:00Z',covered_from:0,covered_through:100,datasetCheckpoints:[{dataset:'swaps',generation:'0/10'}]};
 assert.notEqual(cacheKey(c,checkpoint),cacheKey(c,{...checkpoint,datasetCheckpoints:[{dataset:'swaps',generation:'0/11'}]}));
});

test('reviewed research benchmark recipes compile against their declared datasets',async()=>{
 const {benchmarks}=require('../../v1/lib/ask-research-benchmarks');
 for(const b of benchmarks){const c=await compileResearchSQL({version:3,sql:b.sql,limit:100},{extended:true});assert.deepEqual(c.datasets,[...b.datasets].sort());}
});

test('pool comparisons preserve exact decimal order, units, missing values and observed date scope',()=>{
 const {compare,poolComparisons}=require('../../v1/lib/ask-research-comparison');
 assert.equal(compare('9007199254740993.01','9007199254740993.00'),'left');assert.equal(compare('1.000','1'),'equal');assert.equal(compare(null,'0'),null);
 const result={datasets:['daily'],columns:[{label:'date',type:'text'},{label:'orchard_zec',type:'number'},{label:'ironwood_zec',type:'number'}]};
 const rows=[['2026-09-30','378875.33','4060872.68'],['2026-07-31','3097385.74','652626.41'],['2026-08-31','470512.11','3840173.43']];
 const c=poolComparisons(result,rows);assert.equal(c.firstRightDate,'2026-08-31');assert.deepEqual(c.observations.map(r=>r.leader),['right','left','right']);assert.match(c.scope,/not proof/);
 assert.equal(poolComparisons({...result,columns:[result.columns[0],result.columns[1],{label:'ironwood_zatoshis',type:'number'}]},rows),null);
 assert.equal(poolComparisons({...result,datasets:['transactions']},rows),null);
});

test('paired pool snapshot finding binds every amount to its actual date without an AI interval guess',()=>{
 const {poolComparisonAnswer}=require('../../v1/lib/ask-research-comparison');
 const result={datasets:['daily'],truncated:false,query:{version:3,sql:"WITH closing AS(SELECT date_trunc('month',date::timestamp) FROM daily)",limit:100},columns:[{label:'date',type:'text'},{label:'orchard_zec',type:'number'},{label:'ironwood_zec',type:'number'}],rows:[['2026-07-31','3097385.74932661','652626.41075424'],['2026-08-31','470512.11868503','3840173.43322017'],['2026-10-06','376843.04444626','4063861.48021676']]};
 const answer=poolComparisonAnswer(result,'en');assert.match(answer,/Jul 31, 2026 to Oct 6, 2026/);assert.match(answer,/652,626.41 to 4,063,861.48/);assert.match(answer,/first returned snapshot with Ironwood ahead was Aug 31, 2026/);assert.match(answer,/partial-month/);assert.doesNotMatch(answer,/between those/);
 assert.equal(poolComparisonAnswer({...result,truncated:true},'en'),null);assert.equal(poolComparisonAnswer({...result,rows:[['2026-07-31',null,'0']]},'en'),null);assert.equal(poolComparisonAnswer(result,'fr'),null);
 const already=poolComparisonAnswer({...result,rows:result.rows.slice(1)},'en');assert.match(already,/already ahead/);assert.doesNotMatch(already,/first returned snapshot with/);
});

test('real research reply contract returns a dated pool finding without a second model call',async()=>{
 const {researchReply}=require('../../v1/lib/ask-research-reply');
 const result={query:{version:3,sql:"SELECT date,orchard::numeric/100000000 AS orchard_zec,ironwood::numeric/100000000 AS ironwood_zec FROM daily ORDER BY date",limit:100},columns:[{key:'c0',label:'date',type:'text'},{key:'c1',label:'orchard_zec',type:'number'},{key:'c2',label:'ironwood_zec',type:'number'}],rows:[['2026-07-31','3097385.74932661','652626.41075424'],['2026-08-31','470512.11868503','3840173.43322017']],truncated:false,datasets:['daily'],fingerprint:'a'.repeat(64),retrievedAt:'2026-10-07T16:00:00Z',indexedThrough:'2026-10-07T15:59:00Z',coverage:'verified canonical core; history unverified',units:'exact zatoshis unless query converts'};
 const reply=await researchReply(result,{question:'Compare pool snapshots'},async()=>{assert.fail('Checked pool finding should not call the model');},'en',()=>{assert.fail('No generated explanation needed');});
 assert.match(reply.answer,/Aug 31, 2026/);assert.match(reply.answer,/652,626.41 to 3,840,173.43/);assert.deepEqual(reply.research,result);assert.ok(reply.sources.length);
});

test('monthly pool rows never promote bucket dates to actual snapshot dates',()=>{
 const {poolComparisonAnswer}=require('../../v1/lib/ask-research-comparison');
 const result={datasets:['daily'],truncated:false,retrievedAt:'2026-10-07T16:00:00Z',query:{version:3,sql:'SELECT month FROM daily',limit:100},columns:[{label:'month',type:'text'},{label:'orchard_zec',type:'number'},{label:'ironwood_zec',type:'number'}],rows:[['2026-07-01','3097385.74932661','652626.41075424'],['2026-08-01','470512.11868503','3840173.43322017'],['2026-10-01','376843.04444626','4063861.48021676']]};
 const answer=poolComparisonAnswer(result,'en');assert.match(answer,/first returned month with Ironwood ahead was Aug 2026/);assert.match(answer,/ongoing month/);assert.match(answer,/not the actual snapshot dates/);assert.doesNotMatch(answer,/Aug 1|snapshot with/);
});
