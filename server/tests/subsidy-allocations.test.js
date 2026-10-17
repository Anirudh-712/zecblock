const test = require('node:test');
const assert = require('node:assert/strict');
const { exactCoinZat, parseRpcSubsidyAllocations, hasSubsidyAllocations, sampledAllocationsSql } = require('../api/lib/subsidy-allocations');

test('node allocation parsing preserves exact zatoshis across the real testnet halving', () => {
  assert.deepEqual(parseRpcSubsidyAllocations({ founders: 0, fundingstreamstotal: 0.04166666, miner: 0.41666668 }),
    { foundersZat: '0', fundingStreamsZat: '4166666', minerZat: '41666668' });
  assert.deepEqual(parseRpcSubsidyAllocations({ founders: '0.00000000', fundingstreamstotal: '0', miner: '0.26041666' }),
    { foundersZat: '0', fundingStreamsZat: '0', minerZat: '26041666' });
  assert.deepEqual(parseRpcSubsidyAllocations({ founders: 0, fundingstreamstotal: 0 }),
    { foundersZat: '0', fundingStreamsZat: '0', minerZat: null });
  assert.equal(exactCoinZat(0.00000001), '1');
  for (const value of [null, undefined, '', '-1', '1e-8', '0.000000001', 0.000000001, Infinity, NaN, 21000001, '21000000.00000001']) {
    assert.equal(exactCoinZat(value), null, `invalid amount ${value}`);
    assert.equal(parseRpcSubsidyAllocations({ founders: 0, fundingstreamstotal: value }), null);
  }
});

test('optional allocation-table detection coalesces concurrent reads and propagates query failures', async () => {
  let calls = 0;
  const pool = { query: async () => { calls++; return { rows: [{ available: true }] }; } };
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => hasSubsidyAllocations(pool))), [true, true, true, true, true]);
  assert.equal(calls, 1);
  assert.equal(await hasSubsidyAllocations({ query: async () => ({ rows: [{ available: false }] }) }), false);
  let fail = true;
  const recovering = { query: async () => { if (fail) throw new Error('unavailable'); return { rows: [{ available: true }] }; } };
  await assert.rejects(hasSubsidyAllocations(recovering), /unavailable/);
  fail = false;
  assert.equal(await hasSubsidyAllocations(recovering), true);
});

test('worker and receipts share guarded numeric sample allocation expressions', () => {
  const fields = sampledAllocationsSql('sample');
  assert.deepEqual(Object.keys(fields), ['founders', 'funding', 'miner']);
  assert.ok(fields.founders.includes("jsonb_typeof(sample.subsidy->'founders')='number'"));
  assert.ok(fields.funding.includes("sample.subsidy->>'fundingstreamstotal'"));
  assert.ok(fields.miner.includes("sample.subsidy->>'miner'"));
});
