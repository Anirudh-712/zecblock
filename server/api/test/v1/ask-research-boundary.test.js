'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {once}=require('node:events');
const {createAskRouter}=require('../../v1/routes/ask');
const {createWorker}=require('../../ask-analytics-worker');
const {createAnalyticsClient}=require('../../v1/lib/ask-analytics-client');
const {compileResearchSQL,researchEvidence}=require('../../v1/lib/ask-research-sql');
const {ADMIT,RESERVE}=require('../../v1/lib/ask-budget');
const settings={ASK_RESEARCH_ENABLED:'true',ASK_ANALYTICS_STORE:'logical_public_core',ASK_ENABLED:'false',ASK_DAILY_BUDGET_USD:'1',ASK_MONTHLY_BUDGET_USD:'10',ASK_MAX_INPUT_USD_PER_MILLION:'0.2',ASK_MAX_OUTPUT_USD_PER_MILLION:'0.75',ASK_ABUSE_SECRET:'x'.repeat(32),ASK_TURNSTILE_SECRET:'fixture-secret',ASK_TURNSTILE_HOSTNAME:'example.test',ASK_TURNSTILE_SITE_KEY:'fixture-site'};
const query={version:3,sql:'SELECT height,fees FROM blocks ORDER BY height DESC LIMIT 5',limit:5};
async function server(t,app){const s=app.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${s.address().port}`;}
const post=(url,body,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
async function evidence(input){const c=await compileResearchSQL(input);return {result:researchEvidence(c,[['9007199254740993',null]],[{name:'height',dataTypeID:20},{name:'fees',dataTypeID:1700}],{indexed_through:'2026-10-06T00:00:00Z'},'2026-10-06T00:00:01Z')};}
test('manual SQL enforces verification and shared admission without a provider or paid reservation',async t=>{
 let count=0,paid=0,admitted=0;const redis={isReady:true,eval:async script=>{if(script===RESERVE){paid++;throw Error('must not charge');}assert.equal(script,ADMIT);admitted++;return 1;}};
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.v1={network:'mainnet',requestId:'fixture',abortSignal:new AbortController().signal};next();});const router=createAskRouter(settings,{redis,analytics:{execute:async input=>{count++;return evidence(input);}},challengeFetch:async()=>Response.json({success:true,action:'ask',hostname:'example.test'}),fetch:async()=>{throw Error('must not call AI');}});t.after(()=>router.stop());app.use('/ask',router);const url=await server(t,app);
 assert.equal((await (await fetch(url+'/ask')).json()).data.researchEnabled,true);
 const response=await post(url+'/ask/research/query',{...query,challenge:'fixture'});assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);const body=await response.json();assert.equal(body.data.result.rows[0][0],'9007199254740993');assert.equal(body.data.mode,'research');assert.equal(paid,0);assert.equal(count,1);assert.equal(admitted,1);
 for(const sql of ['DELETE FROM blocks',"SELECT pg_read_file('/etc/passwd') FROM blocks",'SELECT * FROM pg_subscription'])assert.equal((await post(url+'/ask/research/query',{...query,sql,challenge:'fixture'})).status,400);
 assert.equal(count,1);assert.equal(admitted,1);
 assert.equal((await post(url+'/ask/research/query',query)).status,400);assert.equal((await post(url+'/ask/research/plan',{question:'Latest blocks',challenge:'fixture'})).status,503);assert.equal(count,1);
 redis.isReady=false;assert.equal((await post(url+'/ask/research/query',{...query,challenge:'fixture'})).status,503);assert.equal(count,1);
});
test('worker/client validate research fingerprint, reject writes before execute and fail closed on malformed evidence',async t=>{
 const key='private-test-worker-key-at-least-32-characters';let calls=0;
 const app=createWorker({...settings,ASK_ANALYTICS_SERVICE_KEY:key},{redis:{isReady:true},analytics:{execute:async input=>{calls++;return evidence(input);}}});const url=await server(t,app);
 const clientEnv={...settings,ASK_ANALYTICS_ENABLED:'true',ASK_ANALYTICS_SERVICE_KEY:key,ASK_ANALYTICS_SERVICE_URL:url+'/'};
 const client=createAnalyticsClient(clientEnv);const result=await client.execute(query);assert.equal(result.result.rows[0][0],'9007199254740993');assert.equal(calls,1);
 assert.equal((await post(url+'/query',{...query,sql:'DELETE FROM blocks'},{Authorization:'Bearer '+key})).status,400);assert.equal(calls,1);assert.equal((await post(url+'/query',query)).status,401);
 const valid=await evidence(query);for(const changed of [{...valid.result,fingerprint:'a'.repeat(64)},{...valid.result,query:{...valid.result.query,sql:'SELECT secret FROM private'}},{...valid.result,credentials:'secret'},{...valid.result,rows:[['width mismatch']]},{...valid.result,datasets:['transactions']}]){const bad=createAnalyticsClient(clientEnv,async()=>Response.json({research:changed}));await assert.rejects(bad.execute(query));}
 const disabled=createAnalyticsClient({...clientEnv,ASK_RESEARCH_ENABLED:'false'});await assert.rejects(disabled.execute(query));assert.equal(calls,1);
});


test('natural language executes only a validated draft, with one challenge and one paid reservation',async t=>{
 let paid=0,verified=0,admitted=0,calls=0,executed=0;
 let sql='SELECT height,fees FROM blocks ORDER BY height DESC LIMIT 5';
 const redis={isReady:true,eval:async script=>{if(script===RESERVE)paid++;else{assert.equal(script,ADMIT);admitted++;}return 1;},zRem:async()=>{}};
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.v1={network:'mainnet',requestId:'fixture',abortSignal:new AbortController().signal};next();});
 const router=createAskRouter({...settings,ASK_ENABLED:'true',ASK_PROVIDER:'openai',ASK_MODEL:'fixture-model',ASK_API_KEY:'fixture-provider-key',ASK_DAILY_CALL_LIMIT:'10'},
 {redis,analytics:{execute:async input=>{executed++;return evidence(input);}},challengeFetch:async()=>{verified++;return Response.json({success:true,action:'ask',hostname:'example.test'});},fetch:async(url,options)=>{calls++;assert.equal(url,'https://api.openai.com/v1/chat/completions');const body=JSON.parse(options.body);assert.equal(body.store,false);assert.doesNotMatch(JSON.stringify(body),/fixture-provider-key|fixture-secret|fixture-challenge/);return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({sql})}}]});}});
 t.after(()=>router.stop());app.use('/ask',router);const url=await server(t,app);
 const submit=execute=>post(url+'/ask/research/plan',{question:'Show latest blocks',challenge:'fixture-challenge',execute});
 let response=await submit(true);assert.equal(response.status,200);let body=await response.json();assert.equal(body.data.result.rows[0][0],'9007199254740993');assert.equal(body.data.query.sql,body.data.result.query.sql);assert.equal(executed,1);assert.equal(verified,1);assert.equal(admitted,1);assert.equal(paid,1);assert.equal(calls,1);
 response=await submit(false);assert.equal(response.status,200);body=await response.json();assert.equal(body.data.result,undefined);assert.equal(executed,1);
 sql='DELETE FROM blocks';response=await submit(true);assert.equal(response.status,503);assert.equal(executed,1);assert.doesNotMatch(await response.text(),/DELETE/);
 sql=null;response=await submit(true);assert.equal(response.status,200);assert.equal((await response.json()).data.query,null);assert.equal(executed,1);
 assert.equal((await submit('yes')).status,400);assert.equal(verified,4);assert.equal(paid,4);
});

test('research SQL reports fixed timeout/validation categories without leaking PostgreSQL diagnostics',async()=>{
 const {createAnalytics,CORE_GUARD}=require('../../v1/lib/ask-analytics');
 for(const [code,kind]of [['57014','timeout'],['42703','query'],['XX000','source']]){
  const releases=[];
  const client={release:value=>releases.push(value),query:async statement=>{
   if(statement===CORE_GUARD)return{rows:[Object.fromEntries(['dedicated','identity','restricted','disk_bounded','no_memberships','no_create','only_public_view','no_sequences','no_definers'].map(key=>[key,true]))]};
   if(statement==='SELECT * FROM analytics_public.coverage')return{rows:[{schema_version:1,authority:'logical_public_core',network:'mainnet',ready:true}]};
   if(typeof statement==='string'&&statement.startsWith('SELECT NULL::int'))return{rows:[{indexed_through:'2026-10-06T00:00:00Z'}]};
   if(typeof statement==='object')throw Object.assign(Error('private DSN and SQL diagnostic'),{code});
   return{rows:[]};
  }};
  const service=createAnalytics({...settings,ASK_ANALYTICS_ENABLED:'true',ASK_ANALYTICS_DATABASE_URL:'peer-only',ASK_ANALYTICS_SOCKET:'/run/ask-public-db',ASK_ANALYTICS_DAILY_QUERY_LIMIT:'100'},{pool:{on(){},end(){},connect:async()=>client}});
  await assert.rejects(service.execute(query,{redis:{isReady:true,eval:async()=>1,zRem:async()=>{} }}),error=>error.askKind===kind&&!error.message.includes('private')&&(kind==='source'?error.code===undefined:error.code===code));
  assert.deepEqual(releases,[true]);await service.close();
 }
});

test('the Ask chat routes custom research and follow-ups through SQL without a second workspace',async()=>{
 const {chat}=require('../../v1/lib/ask-chat');
 const {coreCatalogue}=require('../../v1/lib/ask-core-catalogue');
 const input={question:'Which recent blocks collected the highest fees?',page:'ask',context:null,locale:'auto',history:['Show latest blocks'],challenge:'secret-challenge',currentResearch:query};
 let stages=0,executions=0;
 const analytics={researchEnabled:true,catalogue:coreCatalogue,execute:async compiled=>{executions++;return evidence(compiled);}};
 const reply=await chat(input,async(body,task)=>{
  assert.doesNotMatch(JSON.stringify(body),/secret-challenge/);
  if(++stages===1){assert.deepEqual(body.currentResearch,query);assert.match(task.instruction,/three public tables/);return task.validator.parse({intent:'research',sql:query.sql,spec:null,blockQuery:null,transactionQuery:null,flowQuery:null,topics:['block'],locale:'en'});}
  assert.equal(body.evidence.facts.row_a_a,'9,007,199,254,740,993');
  assert.equal(body.evidence.facts.row_a_b,'Unavailable');
  assert.equal(task.validator.safeParse({summary:'Block 123 collected lots of fees.',observations:[],limitation:'',sources:['block']}).success,false);
  return task.validator.parse({summary:'The first returned block is {{row_a_a}}; its fee value is {{row_a_b}}.',observations:[],limitation:'',sources:['block']});
 },null,new AbortController().signal,'fixed chart instructions',{},analytics);
 assert.equal(stages,2);assert.equal(executions,1);assert.equal(reply.research.rows[0][0],'9007199254740993');assert.match(reply.answer,/9,007,199,254,740,993/);assert.equal(reply.spec,null);
 for(const selection of [{intent:'research',sql:'DELETE FROM blocks'}, {intent:'unsupported',sql:null}]){
  let calls=0;const pending=chat({...input,question:'Make cupcakes',history:[]},async(body,task)=>{calls++;return task.validator.parse({...selection,spec:null,blockQuery:null,transactionQuery:null,flowQuery:null,topics:[],locale:'en'});},null,new AbortController().signal,'',{},analytics);
  if(selection.intent==='research')await assert.rejects(pending,error=>error.askKind==='answer');else assert.match((await pending).answer,/Zcash/);
  assert.equal(calls,1);assert.equal(executions,1);
 }
});
