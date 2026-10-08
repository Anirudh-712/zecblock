'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {draftDiagnostics,compileResearchDraft}=require('../../v1/lib/ask-research-plan-quality');
const {compileResearchSQL}=require('../../v1/lib/ask-research-sql');
const base="WITH observed_days AS(SELECT date,shielded_transactions FROM activity_daily WHERE date>=DATE '2026-08-02' AND date<DATE '2026-10-01'), rolling_counts AS(SELECT date,count(*) OVER(ORDER BY date ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING) AS prior_days FROM observed_days FILTER_HERE) SELECT * FROM rolling_counts WHERE prior_days=30";
const broken=base.replace('FILTER_HERE',"WHERE date>=DATE '2026-09-01' AND date<DATE '2026-10-01'");const fixed=base.replace('FILTER_HERE','');
test('a required full baseline cannot fit after same-level output filtering',async()=>{
 assert.match((await draftDiagnostics(broken))[0],/lookback dates/);assert.deepEqual(await draftDiagnostics(fixed),[]);
 assert.deepEqual(await draftDiagnostics(broken.replace('WHERE prior_days=30','')),[],'partial windows are valid when a full count is not required');
 assert.deepEqual(await draftDiagnostics(broken.replace('activity_daily','transactions')),[],'unknown one-row-per-date lineage is not guessed');
});
test('published direction checks resolve direct dataset aliases without inspecting unrelated text',async()=>{
 for(const sql of ["SELECT * FROM swaps WHERE direction='out'","SELECT * FROM swaps s WHERE s.direction='in'","SELECT * FROM flow_daily WHERE direction='outflow'"])assert.match((await draftDiagnostics(sql))[0],/published direction/);
 for(const sql of ["SELECT * FROM swaps WHERE direction='outflow'","SELECT * FROM flows WHERE direction='deshield'","SELECT 'out' AS note FROM swaps","SELECT * FROM blocks WHERE miner='out'"])assert.deepEqual(await draftDiagnostics(sql),[]);
 await compileResearchSQL({version:3,sql:"SELECT * FROM swaps WHERE direction='out'",limit:100},{extended:true});
});
test('one model repair precedes execution and retains every security check',async()=>{
 let calls=0;const query=await compileResearchDraft(broken,{question:'Thirty preceding days'},async(input,task)=>{calls++;assert.equal(task.name,'research_sql');assert.equal(input.sql,broken);return {sql:fixed};},{extended:true});
 assert.equal(calls,1);assert.match(query.sql,/activity_daily_query/);
 calls=0;await assert.rejects(compileResearchDraft("SELECT * FROM swaps WHERE direction='out'",{question:'Outflow'},async()=>{calls++;return {sql:"SELECT * FROM swaps WHERE direction='out'"};},{extended:true}),e=>e.askKind==='answer');assert.equal(calls,1);
 await assert.rejects(compileResearchDraft("SELECT * FROM swaps WHERE direction='out'",{},async()=>({sql:'DELETE FROM swaps'}),{extended:true}));
 await assert.rejects(compileResearchDraft('DELETE FROM swaps',{},async()=>assert.fail('Unsafe SQL never gets a repair call'),{extended:true}));
});
test('empty English research gets an honest receipt without spending on a fabricated explanation',async()=>{
 const {researchReply}=require('../../v1/lib/ask-research-reply');const result={query:{version:3,sql:'SELECT height FROM blocks',limit:100},columns:[{key:'c0',label:'height',type:'number'}],rows:[],truncated:false,datasets:['blocks'],fingerprint:'a'.repeat(64),retrievedAt:'2026-10-08T00:00:00Z',indexedThrough:'2026-10-07T00:00:00Z',coverage:'verified canonical records',units:'exact'};
 const reply=await researchReply(result,{},()=>assert.fail('No paid empty-result narrative'),'en',()=>assert.fail());assert.match(reply.answer,/does not establish zero activity/);assert.match(reply.answer,/Edit query/);
});

test('research summaries retain complete sentences without treating decimal points as boundaries',()=>{
 const {completeSummary}=require('../../v1/lib/ask-research-reply');
 assert.equal(completeSummary('The peak was 944.58% above baseline. The result card shows a'),'The peak was 944.58% above baseline.');
 assert.equal(completeSummary('The peak was 944.58'),null);
 assert.equal(completeSummary('A complete finding.'),'A complete finding.');
 assert.equal(completeSummary('There were 944.58 records'),null);
 assert.equal(completeSummary('観測値が増加しました。 表は'), '観測値が増加しました。');
 assert.equal(completeSummary('A finding. Values are a; b; c; d. A useful interpretation.'),'A finding. A useful interpretation.');
 assert.equal(completeSummary('A finding. Its meaning. An unrelated third sentence.'),'A finding. Its meaning.');
});

test('swap time filters must not compare timestamptz to numeric Unix bounds',async()=>{
 for(const bound of ["EXTRACT(EPOCH FROM DATE '2026-09-01')::bigint",'1788220800','1788220800.5'])assert.match((await draftDiagnostics('SELECT * FROM swaps s WHERE s.timestamp>='+bound))[0],/UTC timestamptz/);
 assert.deepEqual(await draftDiagnostics("SELECT * FROM swaps WHERE timestamp>=TIMESTAMPTZ '2026-09-01 00:00:00+00'"),[]);
 assert.deepEqual(await draftDiagnostics('SELECT * FROM flows WHERE timestamp>=1788220800'),[]);
});

test('daily joins reject a resolved text/date mismatch, not a valid cast or unrelated output',async()=>{
 const brokenJoin="WITH swap_totals AS(SELECT to_char(timestamp,'YYYY-MM-DD') AS date,sum(usd) AS amount FROM swaps GROUP BY 1), flow_totals AS(SELECT date,sum(amount) AS amount FROM flow_daily GROUP BY date) SELECT f.date FROM flow_totals f JOIN swap_totals s ON f.date=s.date";
 assert.match((await draftDiagnostics(brokenJoin))[0],/matching DATE types/);
 assert.deepEqual(await draftDiagnostics(brokenJoin.replace("to_char(timestamp,'YYYY-MM-DD')",'timestamp::date')),[]);
 assert.deepEqual(await draftDiagnostics("SELECT to_char(timestamp,'YYYY-MM-DD') AS date FROM swaps"),[]);
 assert.match((await draftDiagnostics("SELECT * FROM flow_daily WHERE pool='all'"))[0],/no synthetic all pool/);
 assert.deepEqual(await draftDiagnostics("SELECT * FROM flow_daily WHERE pool='orchard'"),[]);
});

// Numerical oracle in one disposable PG16 cluster, never a configured DB URL.
test('isolated PG16 reviewed baselines and pool windows preserve dates and missing measures',{skip:process.env.ASK_PLAN_TEST_POSTGRES!=='1'},async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process'),{Pool,types}=require('pg');
 const bin=process.env.ASK_LOGICAL_PG_BIN;
 assert.ok(bin&&path.isAbsolute(bin),'Explicit local PG16 binary directory required');
 const command=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
 assert.match(command('postgres',['--version']),/^postgres \(PostgreSQL\) 16\./);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ask-plan-fixture-')),data=path.join(root,'data'),socket=path.join(root,'socket');
 fs.chmodSync(root,0o700);fs.mkdirSync(socket,{mode:0o700});let active=false,pool;
 t.after(async()=>{await pool?.end();if(active){command('pg_ctl',['-D',data,'-m','fast','-w','stop']);active=false;}if(!active)fs.rmSync(root,{recursive:true,force:true});});
 command('initdb',['-D',data,'-U','ask_plan_fixture','-A','trust','--no-locale','--encoding=UTF8']);
 fs.appendFileSync(path.join(data,'postgresql.conf'),"\nlisten_addresses=''\nunix_socket_directories='"+socket+"'\nshared_buffers='16MB'\nlog_min_messages=warning\n");
 command('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-w','start']);active=true;
 pool=new Pool({host:socket,port:5432,user:'ask_plan_fixture',database:'postgres',max:1,ssl:false,types:{getTypeParser:(oid,format)=>oid===1082?value=>value:types.getTypeParser(oid,format)}});
 await pool.query(`SET TIME ZONE 'UTC';CREATE SCHEMA analytics_public;
 CREATE TABLE analytics_public.activity_daily_query(date date PRIMARY KEY,shielded_transactions bigint,transactions bigint);
 INSERT INTO analytics_public.activity_daily_query SELECT DATE '2026-08-02'+i,CASE WHEN DATE '2026-08-02'+i=DATE '2026-09-01' THEN 1000 ELSE 100 END,2000 FROM generate_series(0,59) i;
 CREATE TABLE analytics_public.flow_daily_query(date date,pool text,direction text,amount numeric,missing_amounts bigint);
 INSERT INTO analytics_public.flow_daily_query SELECT DATE '2026-08-25'+i,p,'deshield',CASE WHEN DATE '2026-08-25'+i=DATE '2026-09-02' AND p='orchard' THEN NULL ELSE CASE WHEN p='orchard' THEN 6000000000 ELSE 4000000000 END*CASE WHEN DATE '2026-08-25'+i IN(DATE '2026-09-03',DATE '2026-09-17',DATE '2026-09-30') THEN 2 ELSE 1 END END,CASE WHEN DATE '2026-08-25'+i=DATE '2026-09-02' AND p='orchard' THEN 1 ELSE 0 END FROM generate_series(0,36) i CROSS JOIN(VALUES('orchard'),('ironwood')) pools(p);
 CREATE TABLE analytics_public.swaps_query(timestamp timestamptz,direction text,usd numeric);
 INSERT INTO analytics_public.swaps_query SELECT (DATE '2026-08-25'+i)::timestamptz,'outflow',CASE WHEN DATE '2026-08-25'+i IN(DATE '2026-09-01',DATE '2026-09-26') THEN NULL WHEN DATE '2026-08-25'+i IN(DATE '2026-09-03',DATE '2026-09-17',DATE '2026-09-30') THEN 2000 ELSE 1000 END FROM generate_series(0,36) i;
 INSERT INTO analytics_public.swaps_query VALUES ('2026-09-17','inflow',999999);
 CREATE TABLE analytics_public.daily_query(date date PRIMARY KEY,orchard numeric,ironwood numeric);
 INSERT INTO analytics_public.daily_query SELECT DATE '2025-12-25'+i,(1000-10*i)::numeric*100000000,(100+12*i)::numeric*100000000 FROM generate_series(0,16) i;`);
 const {benchmarks}=require('../../v1/lib/ask-research-benchmarks');
 const run=async id=>{const c=await compileResearchSQL({version:3,sql:benchmarks.find(x=>x.id===id).sql,limit:100},{extended:true});return(await pool.query(c.text,c.values)).rows;};
 await t.test('September output keeps August lookback and ranks the known spike',async()=>{
  const rows=await run('shielded_30d_baseline');assert.equal(rows.length,10);assert.equal(rows[0].date,'2026-09-01');assert.equal(rows[0].shielded_transactions,'1000');assert.equal(rows[0].preceding_30_day_average,'100.00');assert.equal(rows[0].percentage_above_baseline,'900.00');assert.equal(rows[0].shielded_transaction_share_percent,'50.00');
 });
 await t.test('both baselines exclude missing values, combine pools and ignore inflows',async()=>{
  const rows=await run('independent_flow_swap_baselines');assert.equal(rows.length,1);assert.equal(rows[0].date,'2026-09-17');assert.equal(Number(rows[0].deshield_zec),200);assert.equal(Number(rows[0].preceding_7d_avg_deshield_zec),100);assert.equal(Number(rows[0].outflow_usd),2000);assert.equal(Number(rows[0].preceding_7d_avg_outflow_usd),1000);assert.equal(rows[0].swap_count,'1');assert.equal(rows[0].missing_amounts,'0');assert.equal(rows[0].missing_usd,'0');
 });
 await t.test('seven-day stock deltas include the previous-year starting observations',async()=>{
  const rows=await run('orchard_7d_decreases');assert.equal(rows.length,5);assert.equal(rows[0].starting_observation_date,'2025-12-25');assert.equal(rows[0].ending_observation_date,'2026-01-01');assert.equal(Number(rows[0].orchard_change_zec),-70);assert.equal(Number(rows[0].ironwood_change_zec),84);assert.equal(Number(rows[0].combined_balance_change_zec),14);
 });
});
