'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { maintainAllocations } = require('../lib/subsidy-allocation-maintenance');

const genesis = '0'.repeat(64);
const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);
const activationHeight = 4_465_026;
const subsidy = { founders: 0, fundingstreamstotal: 0.04166666, miner: 0.41666668 };
const info = {
  chain: 'test', blocks: activationHeight + 10, bestblockhash: 'c'.repeat(64),
  upgrades: {
    blossom: { name: 'Blossom', activationheight: 584_000 },
    nu7: { name: 'NU7', activationheight: activationHeight, status: 'active' },
  },
};

// This fake models the external safety boundaries: the serving chain can
// reorganize before/after its height-pinned RPC, or before the guarded insert.
function harness(options = {}) {
  const queries = [];
  const rpcCalls = [];
  const inserts = [];
  let released = false;
  let allocationHashReads = 0;
  const candidates = options.candidates ?? [{ height: activationHeight, hash }];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: options.locked !== true }] };
      if (/pg_advisory_unlock/.test(sql)) return { rows: [{ pg_advisory_unlock: true }] };
      if (/pg_is_in_recovery/.test(sql)) return { rows: [{ recovery: options.recovery === true }] };
      if (/INSERT INTO (?:public\.)?block_subsidy_allocations/.test(sql)) {
        if (options.insertError) throw options.insertError;
        inserts.push({ sql, params });
        options.onInsert?.();
        return { rows: [], rowCount: options.inserted === false ? 0 : 1 };
      }
      if (/FROM (?:public\.)?blocks/.test(sql) && /height\s*=\s*0/.test(sql)) {
        return { rows: [{ hash: options.databaseGenesis ?? genesis }] };
      }
      if (/FROM (?:public\.)?blocks/.test(sql)) return { rows: candidates.slice(0, params[3]) };
      throw new Error(`Unexpected database query: ${sql}`);
    },
    release() { released = true; },
  };
  const pool = { connect: async () => client };
  const rpc = async (method, params = []) => {
    rpcCalls.push({ method, params });
    if (method === 'getblockchaininfo') return options.info ?? info;
    if (method === 'getblockhash') {
      if (Number(params[0]) === 0) return options.nodeGenesis ?? genesis;
      allocationHashReads++;
      if (options.hashes) return options.hashes[allocationHashReads - 1] ?? hash;
      return candidates.find(row => Number(row.height) === Number(params[0]))?.hash ?? hash;
    }
    if (method === 'getblocksubsidy') {
      if (options.rpcError) throw options.rpcError;
      return options.subsidy === undefined ? subsidy : options.subsidy;
    }
    throw new Error(`Unexpected RPC method: ${method}`);
  };
  return { pool, rpc, queries, rpcCalls, inserts, get released() { return released; } };
}

test('maintenance stores exact historical allocations without manufacturing reserve observations', async () => {
  const h = harness();
  const result = await maintainAllocations(h.pool, h.rpc, { network: 'testnet' });
  assert.equal(result.processed, 1);
  assert.equal(result.written, 1);
  assert.equal(h.inserts.length, 1);
  const values = h.inserts[0].params.map(String);
  for (const expected of [hash, String(activationHeight), 'test', '0', '4166666', '41666668']) {
    assert.ok(values.includes(expected), `missing exact allocation value ${expected}`);
  }
  assert.match(h.inserts[0].sql, /ON CONFLICT[^;]*DO NOTHING/is);
  assert.ok(h.queries.every(query => !/INSERT INTO (?:public\.)?node_accounting_observations/.test(query.sql)));
  assert.ok(h.queries.every(query => !/FOR (?:UPDATE|SHARE)/.test(query.sql)), 'job does not require UPDATE privilege on blocks');
  assert.equal(h.released, true);
});

test('zero founders and funding allocations after the halving are authoritative values', async () => {
  const h = harness({ subsidy: { founders: 0, fundingstreamstotal: 0, miner: 0.26041666 } });
  const result = await maintainAllocations(h.pool, h.rpc, { network: 'testnet' });
  assert.equal(result.written, 1);
  assert.ok(h.inserts[0].params.map(String).includes('26041666'));
});

test('a reorg before or after subsidy retrieval never persists the old allocation', async () => {
  for (const hashes of [[otherHash], [hash, otherHash]]) {
    const h = harness({ hashes });
    const result = await maintainAllocations(h.pool, h.rpc, { network: 'testnet' });
    assert.equal(result.written, 0);
    assert.equal(h.inserts.length, 0);
    assert.equal(h.released, true);
    if (hashes.length === 1) assert.equal(h.rpcCalls.filter(call => call.method === 'getblocksubsidy').length, 0);
  }
});

test('the guarded insert may lose a canonical race or find an existing immutable hash', async () => {
  const h = harness({ inserted: false });
  const result = await maintainAllocations(h.pool, h.rpc, { network: 'testnet' });
  assert.equal(result.processed, 1);
  assert.equal(result.written, 0);
  assert.equal(h.released, true);
});

test('malformed, missing, negative and fractional-zatoshi RPC amounts remain missing', async () => {
  for (const response of [
    null,
    { ...subsidy, founders: undefined },
    { ...subsidy, founders: -1 },
    { ...subsidy, fundingstreamstotal: 0.041666661 },
    { ...subsidy, fundingstreamstotal: 21_000_001 },
    { ...subsidy, founders: 'not reported' },
    { ...subsidy, founders: Number.NaN },
  ]) {
    const h = harness({ subsidy: response });
    await assert.rejects(maintainAllocations(h.pool, h.rpc, { network: 'testnet' }), /allocations unavailable/);
    assert.equal(h.inserts.length, 0);
    assert.equal(h.released, true);
  }
});

test('missing optional miner subsidy does not hide known compulsory allocations', async () => {
  const h = harness({ subsidy: { founders: 0, fundingstreamstotal: 0.04166666 } });
  const result = await maintainAllocations(h.pool, h.rpc, { network: 'testnet' });
  assert.equal(result.written, 1);
  assert.ok(h.inserts[0].params.includes(null));
  assert.ok(h.inserts[0].params.map(String).includes('4166666'));
});

test('standby, wrong-network and genesis mismatches cannot write allocations', async () => {
  for (const options of [
    { recovery: true },
    { info: { ...info, chain: 'main' } },
    { databaseGenesis: otherHash },
    { nodeGenesis: otherHash },
  ]) {
    const h = harness(options);
    await assert.rejects(maintainAllocations(h.pool, h.rpc, { network: 'testnet' }));
    assert.equal(h.inserts.length, 0);
    assert.equal(h.rpcCalls.filter(call => call.method === 'getblocksubsidy').length, 0);
    assert.equal(h.released, true);
  }
});

test('a second maintenance run exits when another worker owns its advisory lock', async () => {
  const h = harness({ locked: true });
  const result = await maintainAllocations(h.pool, h.rpc, { network: 'testnet' });
  assert.equal(result.written, 0);
  assert.equal(h.inserts.length, 0);
  assert.equal(h.released, true);
});

test('an unscheduled mainnet does not backfill arbitrary historical allocations', async () => {
  const h = harness({ info: { ...info, chain: 'main', upgrades: {
    blossom: { name: 'Blossom', activationheight: 653_600 },
  } } });
  const result = await maintainAllocations(h.pool, h.rpc, { network: 'mainnet' });
  assert.equal(result.written, 0);
  assert.equal(h.rpcCalls.filter(call => call.method === 'getblocksubsidy').length, 0);
  assert.equal(h.inserts.length, 0);
  assert.equal(h.released, true);
});

test('an exhausted wall-clock budget starts no historical subsidy work', async () => {
  const h = harness();
  let ticks = 0;
  await assert.rejects(maintainAllocations(h.pool, h.rpc, {
    network: 'testnet', timeBudgetMs: 10, now: () => ticks++ === 0 ? 0 : 11,
  }), /time budget exhausted/);
  assert.equal(h.rpcCalls.filter(call => call.method === 'getblocksubsidy').length, 0);
  assert.equal(h.released, true);
});

test('maintenance stops between rows when its budget expires', async () => {
  let currentTime = 0;
  const h = harness({ candidates: [
    { height: activationHeight, hash },
    { height: activationHeight + 1, hash: otherHash },
  ], onInsert: () => { currentTime = 11; } });
  const result = await maintainAllocations(h.pool, h.rpc, {
    network: 'testnet', timeBudgetMs: 10, now: () => currentTime,
  });
  assert.equal(result.status, 'budget');
  assert.equal(result.processed, 1);
  assert.equal(result.written, 1);
  assert.equal(h.rpcCalls.filter(call => call.method === 'getblocksubsidy').length, 1);
  assert.equal(h.released, true);
});

test('the requested candidate limit bounds historical RPC and insert work', async () => {
  const h = harness({ candidates: [
    { height: activationHeight, hash },
    { height: activationHeight + 1, hash: otherHash },
  ] });
  const result = await maintainAllocations(h.pool, h.rpc, { network: 'testnet', limit: 1 });
  assert.equal(result.processed, 1);
  assert.equal(result.written, 1);
  assert.equal(h.rpcCalls.filter(call => call.method === 'getblocksubsidy').length, 1);
});

test('invalid invocation cannot connect to the database or node', async () => {
  const h = harness();
  for (const options of [
    {}, { network: 'crosslink' }, { network: 'testnet', limit: 0 },
    { network: 'testnet', limit: 501 }, { network: 'testnet', limit: 1.5 },
    { network: 'testnet', timeBudgetMs: 0 }, { network: 'testnet', timeBudgetMs: 60_001 },
  ]) await assert.rejects(maintainAllocations(h.pool, h.rpc, options));
  assert.equal(h.queries.length, 0);
  assert.equal(h.rpcCalls.length, 0);
});

test('RPC and insertion failures release the worker session and write no successful rows', async () => {
  for (const options of [{ rpcError: new Error('RPC unavailable') }, { insertError: new Error('database unavailable') }]) {
    const h = harness(options);
    await assert.rejects(maintainAllocations(h.pool, h.rpc, { network: 'testnet' }));
    assert.equal(h.released, true);
    assert.ok(h.queries.some(query => /pg_advisory_unlock/.test(query.sql)));
  }
});
