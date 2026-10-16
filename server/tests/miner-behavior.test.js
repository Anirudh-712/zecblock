'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../api/lib/miner-behavior');
const { processDates, selectSnapshotDates } = require('../jobs/snapshot-mining-behavior');

test('bounded UTC days and explicit legacy backfill retain their distinct selection', () => {
  const now=new Date('2026-10-16T00:01:00Z');
  assert.equal(selectSnapshotDates(['--days=30'],now).length,30);
  assert.deepEqual(selectSnapshotDates(['--backfill'],now,'2026-10-14'),['2026-10-14','2026-10-15']);
  assert.deepEqual(selectSnapshotDates(['--backfill'],now,null),[]);
  assert.throws(()=>selectSnapshotDates(['--backfill','--days=30'],now,'2026-10-14'));
});

test('empty snapshots stay unavailable rather than claiming zero earnings or active computation', () => {
  const data = summarize('30d', []);
  assert.equal(data.status, 'unavailable');
  assert.equal(data.summary, null);
  assert.equal(data.coverage, null);
  assert.doesNotMatch(data.message, /comput|snapshot job/i);
});

test('cohort totals preserve exact zatoshis and disclose tracked coverage and oldest refresh', () => {
  const data = summarize('30d', [
    { date:'2026-10-14',pool_name:'Other',earned_zat:'9007199254740993',spent_zat:'1',held_zat:'9007199254740992',blocks_mined:2,outputs_total:3,updated_at:'2026-10-16T10:00:00Z' },
    { date:'2026-10-15',pool_name:'Other',earned_zat:'7',spent_zat:'2',held_zat:'5',blocks_mined:1,outputs_total:1,updated_at:'2026-10-16T11:00:00Z' },
  ], Date.parse('2026-10-16T12:00:00Z'));
  assert.equal(data.summary.totalEarnedZat, '9007199254741000');
  assert.equal(data.summary.totalSpentZat, '3');
  assert.equal(data.summary.totalHeldZat, '9007199254740997');
  assert.deepEqual(data.coverage, { scope:'attributed_payout_outputs', spendingBasis:'current_indexed_canonical_spends', freshness:'current', staleAfterSeconds:172800, firstDate:'2026-10-14',lastDate:'2026-10-15',days:2,trackedBlocks:3,trackedOutputs:4,refreshedAt:'2026-10-16T10:00:00.000Z' });
  assert.throws(() => summarize('30d', [{date:'2026-10-15',earned_zat:'1',spent_zat:'2',held_zat:'0'}]));
});

async function api(query, fn) {
  const express = require('express'), app = express();
  app.locals.pool = { query }; app.locals.redisClient = null;
  app.use(require('../api/routes/mining'));
  const server = await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
}

test('API distinguishes missing, empty and failed snapshots without claiming a running job', async () => {
  for (const exists of [false, true]) {
    await api(async sql => ({ rows: sql.includes('information_schema') ? [{exists}] : [] }), async base => {
      const response = await fetch(base+'/api/mining/miner-behavior?period=30d');
      const data = await response.json();
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(data.summary, null); assert.deepEqual(data.series, []);
      assert.equal(data.reason, exists ? 'no_snapshots_in_period' : 'snapshots_not_configured');
      assert.doesNotMatch(data.message, /comput|snapshot job/i);
    });
  }
  await api(async () => { throw new Error('private database detail'); }, async base => {
    const response=await fetch(base+'/api/mining/miner-behavior?period=30d');
    assert.equal(response.status,503); assert.equal(response.headers.get('cache-control'),'no-store');
    assert.doesNotMatch(JSON.stringify(await response.json()),/private database detail/);
  });
});

test('testnet snapshot refuses a different database or missing canonical coinbase before publication', async () => {
  for (const database of ['zcash_crosslink', 'zcash_explorer_testnet']) {
    const writes=[];
    const writer={query:async sql => { writes.push(sql); return {rows:[{database,recovery:false,genesis:'05a60a92d99d85997cce3b87616c089f6124d7342af37106edc76126334a2c38'}]}; }};
    const reads=[];
    const reader={query:async sql => { reads.push(sql); if(sql.includes('ORDER BY height'))return {rows:[{height:2,hash:'tip',timestamp:1792108800}]};if(sql.includes('incomplete_coinbases'))return {rows:[{blocks:1,incomplete_coinbases:1}]};return {rows:[]}; },release(){}};
    await assert.rejects(processDates(writer,{connect:async()=>reader},['2026-10-14'],{network:'testnet',pauseMs:0}), database==='zcash_crosslink' ? /database\/network mismatch/ : /Incomplete canonical coinbase/);
    assert.ok(!writes.some(sql=>sql.includes('DELETE')||sql.includes('INSERT')));
    if(database==='zcash_explorer_testnet')assert.ok(reads.includes('ROLLBACK'));
    else assert.equal(reads.length,0);
  }
});

test('one unavailable day does not starve other testnet reward dates', async () => {
  const inserted=[];
  const writer={query:async(sql,args)=>{
    if(sql.includes('pg_is_in_recovery'))return {rows:[{database:'zcash_explorer_testnet',recovery:false,genesis:'05a60a92d99d85997cce3b87616c089f6124d7342af37106edc76126334a2c38'}]};
    if(sql.includes('INSERT INTO mining_behavior_daily'))inserted.push(args[0]);
    return {rowCount:1,rows:[]};
  }};
  const reader={query:async(sql,args)=>{
    if(sql.includes('ORDER BY height'))return {rows:[{height:2,hash:'tip',timestamp:1792108800}]};
    if(sql.includes('incomplete_coinbases'))return {rows:[{blocks:1,incomplete_coinbases:args[0]===Date.parse('2026-10-13T00:00:00Z')/1000?1:0}]};
    if(sql.includes('output_count'))return {rows:[{miner_address:'test-miner',blocks:1,output_count:1,total_earned:'7',total_spent:'0',spent_count:0}]};
    return {rows:[]};
  },release(){}};
  const result=await processDates(writer,{connect:async()=>reader},['2026-10-13','2026-10-14'],{network:'testnet',pauseMs:0,continueOnError:true});
  assert.deepEqual(result,{processed:1,failedDates:['2026-10-13']});
  assert.deepEqual(inserted,['2026-10-14']);
});

const databaseUrl=process.env.TEST_ANALYTICS_DATABASE_URL||process.env.TEST_UTXO_DATABASE_URL;
test('native PostgreSQL snapshot replaces one cohort atomically and rolls back failed publication', {skip:!databaseUrl}, async () => {
  const {Client}=require('pg'), client=new Client({connectionString:databaseUrl}); await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE blocks(height bigint PRIMARY KEY,hash text,timestamp bigint,miner_address text);
      CREATE TEMP TABLE transactions(txid text PRIMARY KEY,block_height bigint,block_hash text,is_coinbase boolean);
      CREATE TEMP TABLE transaction_outputs(txid text,vout_index int,value bigint,address text);
      CREATE TEMP TABLE transaction_inputs(txid text,prev_txid text,prev_vout int);
      CREATE TEMP TABLE mining_behavior_daily(date date,pool_name text,miner_address text,earned_zat bigint,spent_zat bigint,held_zat bigint,blocks_mined int,outputs_spent int,outputs_total int,updated_at timestamptz DEFAULT now());
      INSERT INTO blocks VALUES(0,'00040fe8ec8471911baa1db1266ea15dd06b4a8a5c453883c000b031973dce08',0,NULL),(1,'canonical',1791936001,'test-miner'),(2,'tip',1792108800,NULL);
      INSERT INTO transactions VALUES('coinbase',1,'canonical',true),('orphan',1,'orphan-hash',true),('spend',2,'tip',false),('orphan-spend',1,'orphan-hash',false);
      INSERT INTO transaction_outputs VALUES('coinbase',0,9007199254740993,'test-miner'),('coinbase',1,7,'test-miner'),('orphan',0,42,'test-miner');
      INSERT INTO transaction_inputs VALUES('spend','coinbase',1),('spend','coinbase',1),('orphan-spend','coinbase',0);`);
    const readers={connect:async()=>({query:client.query.bind(client),release(){}})};
    await processDates(client,readers,['2026-10-14'],{pauseMs:0});
    const before=(await client.query('SELECT * FROM mining_behavior_daily')).rows;
    assert.equal(before.length,1); assert.equal(before[0].earned_zat,'9007199254741000');
    assert.equal(before[0].spent_zat,'7');assert.equal(before[0].held_zat,'9007199254740993');
    const failing={query:async(sql,args)=>{if(sql.includes('INSERT INTO mining_behavior_daily'))throw new Error('Injected write failure');return client.query(sql,args);}};
    await assert.rejects(processDates(failing,readers,['2026-10-14'],{pauseMs:0}),/Injected write failure/);
    assert.deepEqual((await client.query('SELECT * FROM mining_behavior_daily')).rows,before);
  } finally {await client.end();}
});
