'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {TABLES,publicationDDL,buildPreflightSQL,assessPreflight,buildPublicationPlan}=require('../../scripts/profile-ask-logical-sync');

function ready() {
 return {kind:'logical_sync_preflight',database:'zcash_explorer_mainnet',standby:false,version:'16.15',
  settings:{wal_level:{value:'logical'},max_slot_wal_keep_size:{value:'64'},max_replication_slots:{value:'8'},max_wal_senders:{value:'8'}},
  slots:{total:0},connected_wal_senders:0,
  core_keys:TABLES.map(t=>({relation:t.name,present:true,identity_valid:true,replica_identity:'d',identity_columns:t.key,missing_columns:[],columns:t.types}))};
}
test('operator preflight/plan stays fixed and activation remains separate from configuration readiness',()=>{
 assert.equal(assessPreflight(ready()).configuration_ready,true);
 assert.equal(assessPreflight(ready()).activation_authorized,false);
 const cases=[
  [r=>{r.settings.wal_level.value='replica';},'logical_wal_requires_planned_restart'],
  [r=>{r.settings.max_slot_wal_keep_size.value='-1';},'finite_positive_slot_wal_budget_required'],
  [r=>{r.settings.max_slot_wal_keep_size.value='0';},'finite_positive_slot_wal_budget_required'],
  [r=>{r.slots.total=7;},'snapshot_slot_headroom_required'],
  [r=>{r.connected_wal_senders=7;},'snapshot_sender_headroom_required'],
  [r=>{r.standby=true;},'verified_mainnet_primary_required'],
  [r=>{r.database='other';},'verified_mainnet_primary_required'],
  [r=>{r.version='14.18';},'reviewed_pg16_required'],
  [r=>{r.settings.wal_level.pending_restart=true;},'pending_settings_require_review'],
  [r=>{r.core_keys[2].identity_columns=['txid','flow_type'];},'reviewed_identity_and_columns_required:shielded_flows'],
  [r=>{r.core_keys[0].missing_columns=['previous_block_hash'];},'reviewed_identity_and_columns_required:blocks'],
  [r=>{r.core_keys[1].columns.fee='text';},'reviewed_types_required:transactions'],
 ];
 for(const [mutate,reason] of cases) {const r=structuredClone(ready());mutate(r);assert.ok(assessPreflight(r).blockers.includes(reason));}
 const sql=buildPreflightSQL();assert.match(sql,/BEGIN READ ONLY/);assert.match(sql,/ROLLBACK;/);
 assert.doesNotMatch(sql,/CREATE |ALTER |INSERT |UPDATE |DELETE |pg_create_logical_replication_slot/);
 const plan=buildPublicationPlan();assert.match(plan,/CREATE PUBLICATION/);assert.doesNotMatch(plan,/FOR ALL TABLES|CREATE SUBSCRIPTION|PASSWORD|ALTER SYSTEM|SELECT \*/);
 assert.deepEqual(TABLES.find(t=>t.name==='shielded_flows').key,['id']);
 assert.ok(Object.isFrozen(TABLES[0].columns));
});

const enabled=process.env.ASK_LOGICAL_TEST_POSTGRES==='1';
test('isolated PG16: filtered initial copy, atomic CDC, pause/resume, restart and restricted reader', {skip:!enabled},async t=>{
 const {Pool}=require('pg');
 const bin=process.env.ASK_LOGICAL_PG_BIN;
 if(!bin || !path.isAbsolute(bin)) throw new Error('Explicit absolute PG16 fixture binary directory required');
 const command=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
 assert.match(command('postgres',['--version']),/^postgres \(PostgreSQL\) 16\./);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ask-logical-fixture-'));
 fs.chmodSync(root,0o700);
 const clusters=['source','target'].map(name=>({name,data:path.join(root,name),socket:path.join(root,`${name}-socket`),active:false}));
 const pools=[];let source,target,reader;
 const start=c=>{command('pg_ctl',['-D',c.data,'-l',path.join(root,`${c.name}.log`),'-w','start']);c.active=true;};
 const stop=c=>{command('pg_ctl',['-D',c.data,'-m','fast','-w','stop']);c.active=false;};
 const close=async pool=>{if(pool && pools.includes(pool)) {pools.splice(pools.indexOf(pool),1);await pool.end();}};
 const pool=(cluster,user='ask_fixture_admin')=>{const p=new Pool({host:cluster.socket,port:5432,user,database:'ask_logical_fixture',max:2,ssl:false});pools.push(p);return p;};
 t.after(async()=>{
  for(const p of [...pools]) await close(p);
  try {for(const c of clusters.reverse()) if(c.active) stop(c);}
  finally {if(clusters.every(c=>!c.active)) fs.rmSync(root,{recursive:true,force:true});}
 });
 for(const c of clusters) {
  fs.mkdirSync(c.socket,{mode:0o700});
  command('initdb',['-D',c.data,'-U','ask_fixture_admin','-A','trust','--no-locale','--encoding=UTF8']);
  fs.appendFileSync(path.join(c.data,'postgresql.conf'),`\nlisten_addresses=''\nunix_socket_directories='${c.socket.replaceAll("'","''")}'\nwal_level=logical\nmax_replication_slots=8\nmax_wal_senders=8\nmax_logical_replication_workers=4\nmax_worker_processes=8\nmax_slot_wal_keep_size='64MB'\nshared_buffers='32MB'\nlog_min_messages=warning\n`);
  start(c);
  const admin=new Pool({host:c.socket,port:5432,user:'ask_fixture_admin',database:'postgres',max:1,ssl:false});
  try {await admin.query('CREATE DATABASE ask_logical_fixture');}finally {await admin.end();}
 }
 source=pool(clusters[0]);target=pool(clusters[1]);
 for(const table of TABLES) {
  const columns=table.columns.map(k=>`${k} ${table.types[k]}`);
  await source.query(`CREATE TABLE public.${table.name}(${columns.join(',')},private_marker text,PRIMARY KEY(${table.key.join(',')}))`);
  await target.query(`CREATE TABLE public.${table.name}(${columns.join(',')},PRIMARY KEY(${table.key.join(',')}))`);
 }
 await source.query(`CREATE TABLE public.private_fixture(secret text);INSERT INTO public.private_fixture VALUES('secret-fixture');
  CREATE ROLE ask_fixture_replicator LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 4;`);
 for(const table of TABLES) await source.query(`GRANT SELECT(${table.columns.join(',')}) ON public.${table.name} TO ask_fixture_replicator`);
 await source.query(publicationDDL());
 await target.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC;
  REVOKE TEMP ON DATABASE ask_logical_fixture FROM PUBLIC;
  CREATE ROLE ask_fixture_view_owner NOLOGIN NOINHERIT;
  CREATE ROLE ask_fixture_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  CREATE SCHEMA analytics_public AUTHORIZATION ask_fixture_view_owner;
  GRANT USAGE ON SCHEMA public TO ask_fixture_view_owner;
  GRANT SELECT ON public.blocks,public.transactions,public.shielded_flows TO ask_fixture_view_owner;
  SET ROLE ask_fixture_view_owner;
  CREATE VIEW analytics_public.blocks WITH(security_barrier=true) AS SELECT * FROM public.blocks;
  CREATE VIEW analytics_public.transactions WITH(security_barrier=true) AS SELECT t.* FROM public.transactions t JOIN public.blocks b ON b.height=t.block_height AND b.hash=t.block_hash AND b.timestamp=t.block_time;
  CREATE VIEW analytics_public.flows WITH(security_barrier=true) AS SELECT f.txid,f.block_height,f.block_time,f.flow_type,f.pool,f.amount_zat FROM public.shielded_flows f JOIN public.transactions t ON t.txid=f.txid AND t.block_height=f.block_height AND t.block_time=f.block_time JOIN public.blocks b ON b.height=t.block_height AND b.hash=t.block_hash AND b.timestamp=t.block_time;
  RESET ROLE;
  GRANT USAGE ON SCHEMA analytics_public TO ask_fixture_reader;
  GRANT SELECT ON analytics_public.blocks,analytics_public.transactions,analytics_public.flows TO ask_fixture_reader;`);
 const insertBlock=async(c,height,hash)=>{
  const columns=TABLES[0].columns;
  await c.query(`INSERT INTO blocks(${columns.join(',')},private_marker) VALUES($1,$2,$3,$4,2,100,7,'fixture-miner','excluded-secret')`,[height,hash,height===1?'parent':'b1',1700000000+height]);
  for(const coinbase of [true,false]) {
   const txid=`${hash}-${coinbase?'coinbase':'tx'}`;
   const values={txid,block_height:height,block_hash:hash,block_time:String(1700000000+height),is_coinbase:coinbase,fee:coinbase?'0':'7',size:'50',has_sapling:false,has_orchard:!coinbase,has_ironwood:false,has_sprout:false,value_balance_orchard:null,value_balance_ironwood:null};
   const fields=TABLES[1].columns;
   await c.query(`INSERT INTO transactions(${fields.join(',')},private_marker) VALUES(${fields.map((_,i)=>`$${i+1}`).join(',')},'excluded-secret')`,fields.map(k=>values[k]));
  }
  await c.query("INSERT INTO shielded_flows VALUES($1,$2,$3,$4,'shield','orchard',9007199254740993,'excluded-secret')",[height*10,`${hash}-tx`,height,1700000000+height]);
 };
 await insertBlock(source,1,'b1');
 await source.query("INSERT INTO shielded_flows VALUES(11,'b1-tx',1,1700000001,'deshield','orchard',100,'excluded-secret')");
 const conn=`host=${clusters[0].socket} port=5432 dbname=ask_logical_fixture user=ask_fixture_replicator application_name=ask_fixture`;
 await target.query(`CREATE SUBSCRIPTION ask_public_core_v1 CONNECTION '${conn.replaceAll("'","''")}' PUBLICATION ask_public_core_v1 WITH(copy_data=true,streaming=off)`);
 reader=pool(clusters[1],'ask_fixture_reader');
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const wait=async(fn)=>{const until=Date.now()+10000;while(Date.now()<until) {if(await fn()) return;await sleep(40);}throw new Error('Fixture replication deadline exceeded');};
 const counts=async()=>(await reader.query(`SELECT (SELECT count(*) FROM analytics_public.blocks)::text AS blocks,
  (SELECT count(*) FROM analytics_public.transactions)::text AS transactions,
  (SELECT count(*) FROM analytics_public.flows)::text AS flows`)).rows[0];
 await t.test('column-filtered snapshot synchronizes all tables and retains exact amounts',async()=>{
  await wait(async()=>Number((await target.query("SELECT count(*) FROM pg_subscription_rel WHERE srsubstate='r'")).rows[0].count)===3);
  await wait(async()=>(await counts()).flows==='2');
  assert.deepEqual(await counts(),{blocks:'1',transactions:'2',flows:'2'});
  assert.equal((await reader.query("SELECT amount_zat::text FROM analytics_public.flows WHERE flow_type='shield'")).rows[0].amount_zat,'9007199254740993');
  const attrs=(await target.query("SELECT count(*) FROM pg_attribute WHERE attname='private_marker' AND attrelid IN ('public.blocks'::regclass,'public.transactions'::regclass,'public.shielded_flows'::regclass)")).rows[0];assert.equal(attrs.count,'0');
 });
 await t.test('source transaction publishes block, transactions and flows atomically',async()=>{
  const client=await source.connect();
  try {await client.query('BEGIN');await insertBlock(client,2,'b2');await sleep(100);assert.deepEqual(await counts(),{blocks:'1',transactions:'2',flows:'2'});await client.query('COMMIT');}
  finally {await client.query('ROLLBACK');client.release();}
  await wait(async()=>(await counts()).blocks==='2');
  assert.deepEqual(await counts(),{blocks:'2',transactions:'4',flows:'3'});
 });
 await t.test('disabled consumer catches historical updates/deletes and reorg rollback on resume',async()=>{
  await target.query('ALTER SUBSCRIPTION ask_public_core_v1 DISABLE');
  await wait(async()=>Number((await target.query('SELECT count(*) FROM pg_stat_subscription WHERE pid IS NOT NULL')).rows[0].count)===0);
  await source.query(`BEGIN;UPDATE transactions SET fee=42 WHERE txid='b1-tx';UPDATE shielded_flows SET amount_zat=123 WHERE id=10;
    DELETE FROM shielded_flows WHERE id=11 OR block_height=2;DELETE FROM transactions WHERE block_height=2;DELETE FROM blocks WHERE height=2;COMMIT`);
  assert.deepEqual(await counts(),{blocks:'2',transactions:'4',flows:'3'});
  assert.equal((await reader.query("SELECT fee::text FROM analytics_public.transactions WHERE txid='b1-tx'")).rows[0].fee,'7');
  await target.query('ALTER SUBSCRIPTION ask_public_core_v1 ENABLE');
  await wait(async()=>(await counts()).blocks==='1');
  assert.deepEqual(await counts(),{blocks:'1',transactions:'2',flows:'1'});
  assert.equal((await reader.query("SELECT fee::text FROM analytics_public.transactions WHERE txid='b1-tx'")).rows[0].fee,'42');
  assert.equal((await reader.query('SELECT amount_zat::text FROM analytics_public.flows')).rows[0].amount_zat,'123');
 });
 await t.test('subscriber process restart resumes durable native checkpoint',async()=>{
  await close(reader);await close(target);stop(clusters[1]);
  await source.query('BEGIN');await insertBlock(source,2,'replacement-b2');await source.query('COMMIT');
  start(clusters[1]);target=pool(clusters[1]);reader=pool(clusters[1],'ask_fixture_reader');
  await wait(async()=>(await counts()).blocks==='2');
  assert.deepEqual(await counts(),{blocks:'2',transactions:'4',flows:'2'});
  assert.equal((await reader.query('SELECT hash FROM analytics_public.blocks WHERE height=2')).rows[0].hash,'replacement-b2');
 });
 await t.test('truncate changes are carried; WAL budget is finite and identity unchanged',async()=>{
  await source.query('TRUNCATE shielded_flows');await wait(async()=>(await counts()).flows==='0');
  const report=(await source.query("SELECT current_setting('max_slot_wal_keep_size') AS budget,(SELECT count(*) FROM pg_replication_slots WHERE slot_type='logical')::text AS slots")).rows[0];
  assert.equal(report.budget,'64MB');assert.equal(report.slots,'1');
  const flowPK=(await source.query("SELECT attname FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) key(attnum) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=key.attnum WHERE i.indrelid='shielded_flows'::regclass AND i.indisprimary")).rows.map(r=>r.attname);assert.deepEqual(flowPK,['id']);
 });
 await t.test('replication credentials/private columns are inaccessible to query reader',async()=>{
  for(const attack of ['SELECT * FROM public.transactions','SELECT subconninfo FROM pg_subscription','DELETE FROM analytics_public.blocks','CREATE TEMP TABLE attack(x int)',
    "SELECT pg_read_file('/etc/passwd')",'SET ROLE ask_fixture_admin','ALTER SUBSCRIPTION ask_public_core_v1 DISABLE']) await assert.rejects(reader.query(attack),/permission|must be|not permitted/i,attack);
  const replicator=pool(clusters[0],'ask_fixture_replicator');
  await assert.rejects(replicator.query('SELECT private_marker FROM public.blocks'),/permission denied/);
  await assert.rejects(replicator.query('SELECT secret FROM public.private_fixture'),/permission denied/);
  await close(replicator);
 });
 await target.query('DROP SUBSCRIPTION ask_public_core_v1');
 assert.equal((await source.query('SELECT count(*) FROM pg_replication_slots')).rows[0].count,'0');
});
