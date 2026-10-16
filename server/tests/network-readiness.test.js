const test = require('node:test');
const assert = require('node:assert/strict');
const { blockAccounting, signedZat } = require('../api/lib/network-accounting');
const { cadencePoints } = require('../api/lib/block-cadence');
const schedule = { nu7Height: 1000, eras: [{ height: 0, seconds: 75 }, { height: 1000, seconds: 25 }] };
const row = { height: 1000, hash: 'abc', transaction_count: 3, tx_count: 3, coinbases: 1, invalid_fees: 0, fees: '3', coinbase_value: '100000004' };
test('fee recycling rounds once per block, and miner receipts exclude funding payouts', () => {
  const r = blockAccounting(row, { miner: 0.8, founders: 0, fundingstreamstotal: 0.2 }, schedule);
  assert.equal(r.feesPaidZat, 3); assert.equal(r.feesToNsmZat, 1); assert.equal(r.minerFeeAllocationZat, 2);
  assert.equal(r.minerReceiptsZat, 80000004);
  assert.equal(r.reissuanceZat, null);
  assert.equal(blockAccounting({ ...row, height: 999 }, {}, schedule).feesToNsmZat, 0);
});
test('incomplete or malformed accounting never becomes a zero fee observation', () => {
  for (const change of [{ tx_count: 2 }, { invalid_fees: 1 }, { fees: null }, { fees: '-1' }, { fees: '1.5' }]) assert.equal(blockAccounting({ ...row, ...change }, {}, schedule).feesPaidZat, null);
  assert.equal(blockAccounting(row, {}, null).feesToNsmZat, null);
  assert.equal(blockAccounting(row, {}, schedule).minerReceiptsZat, null);
});
test('signed NSM counters preserve exact integers, independent of circulating supply bounds', () => {
  assert.equal(signedZat('-1'), '-1'); assert.equal(signedZat('9223372036854775807'), '9223372036854775807');
  for (const n of [null, undefined, '', 0.1, Number.MAX_SAFE_INTEGER + 1, '9223372036854775808']) assert.equal(signedZat(n), null);
});
test('cadence retains non-monotonic header intervals and does not bridge missing heights', () => {
  const rows = Array.from({ length: 122 }, (_, i) => ({ height: 900 + i, timestamp: 10000 + i * 25 }));
  rows[60].timestamp = rows[59].timestamp - 1;
  let points = cadencePoints(rows, schedule, 0);
  assert.equal(points[60].intervalSeconds, -1); assert.equal(points[120].averageSeconds, 25);
  assert.equal(points[100].targetSeconds, 25);
  points = cadencePoints(rows.filter((_, i) => i !== 70), schedule, 0);
  assert.equal(points.at(-1).averageSeconds, null);
});
const { historyPoints } = require('../api/lib/accounting-history');
test('history preserves exact reserve values, misses and decreases without inferring reissuance', () => {
  const base = { ...row, chain: 'test', observed_at: '2026-09-28T00:00:00Z', subsidy: { miner: 0.8, founders: 0, fundingstreamstotal: 0.2 } };
  const points = historyPoints([
    { ...base, height: 1000, nsm_balance_zat: '9007199254740993' },
    { ...base, height: 1001, nsm_balance_zat: '9007199254740992' },
    { ...base, height: 1002, nsm_balance_zat: null },
    { ...base, height: 1003, nsm_balance_zat: '100' },
    { ...base, height: 1005, nsm_balance_zat: '200' },
  ], schedule, 'test');
  assert.equal(points[0].nsmBalanceZat, '9007199254740993');
  assert.equal(points[1].nsmNetChangeZat, '-1');
  for (const i of [0, 2, 3, 4]) assert.equal(points[i].nsmNetChangeZat, null);
  assert.equal(points[0].minerReceiptsZat, '80000004');
  assert.equal(points[0].receiptSource, 'indexed-coinbase-and-retained-tip-subsidy');
  assert.equal(points[0].reissuanceZat, null);
  assert.equal(historyPoints([base], schedule, 'main')[0].minerReceiptsZat, null);
});
test('block rounding occurs before historical aggregation, including across activation', () => {
  const points = historyPoints([999, 1000, 1001].map(height => ({ ...row, height })), schedule, 'test');
  assert.deepEqual(points.map(p => p.feesToNsmZat), ['0', '1', '1']);
  assert.equal(points.reduce((sum, p) => sum + BigInt(p.feesToNsmZat), 0n), 2n);
  assert.equal(points[0].nsmBalanceZat, null);
  assert.match(points[0].accountingUnavailableReason, /No matching/);
});

test('canonical historical allocations recover actual receipts while NSM samples remain missing', () => {
  const cached = { ...row, coinbase_value: '100000001',
    allocation_founders_zat: '0', allocation_funding_streams_zat: '20000000', allocation_miner_zat: '80000000' };
  const [point] = historyPoints([cached], schedule, 'test');
  assert.equal(point.minerReceiptsZat, '80000001');
  assert.equal(point.receiptSource, 'indexed-coinbase-and-historical-node-subsidy');
  assert.equal(point.minerSubsidyZat, '80000000');
  assert.equal(point.minerFeeAllocationZat, '2');
  assert.notEqual(BigInt(point.minerReceiptsZat), BigInt(point.minerSubsidyZat) + BigInt(point.minerFeeAllocationZat), 'actual coinbase underclaim is preserved');
  assert.equal(point.nsmBalanceZat, null); assert.equal(point.nsmNetChangeZat, null);
  assert.equal(point.observedAt, null); assert.match(point.accountingUnavailableReason, /No matching/);
  assert.equal(historyPoints([{ ...cached, allocation_miner_zat: null }], schedule, 'test')[0].minerReceiptsZat, '80000001');
  assert.equal(historyPoints([{ ...cached, allocation_founders_zat: '-1' }], schedule, 'test')[0].minerReceiptsZat, null);
  assert.equal(historyPoints([{ ...cached, allocation_founders_zat: '-1' }], schedule, 'test')[0].receiptSource, null);
  const sampled = { ...cached, allocation_founders_zat: '-1', chain: 'test', subsidy: { miner: 0.8, founders: 0, fundingstreamstotal: 0.2 } };
  assert.equal(historyPoints([sampled], schedule, 'test')[0].minerReceiptsZat, '80000001', 'invalid cache falls back to the matching real sample');
});
