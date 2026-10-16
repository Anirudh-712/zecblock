'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { checkAllocationHealth } = require('../lib/subsidy-allocation-health');
const { initialState } = require('../lib/subsidy-allocation-state');

const now = Date.parse('2026-10-16T03:00:00Z');
const genesis = '0'.repeat(64);
const anchorHash = 'd'.repeat(64);
const activation = 4465026;
const state = { ...initialState('testnet'), status: 'complete', lastAttempt: new Date(now - 10_000).toISOString(),
  lastFinished: new Date(now - 9000).toISOString(), lastSuccess: new Date(now - 9000).toISOString() };
const systemd = { timerActive: 'active', timerEnabled: 'enabled', serviceResult: 'success' };

function harness(options = {}) {
  const queries = [];
  const pool = { async query(sql, params) {
    queries.push({ sql, params });
    if (options.databaseError) throw new Error('password=private database inaccessible');
    if (/pg_is_in_recovery/.test(sql)) return { rows: [{ recovery: options.passive === true }] };
    if (/height=0/.test(sql)) return { rows: [{ hash: genesis }] };
    if (/SELECT height, hash/.test(sql)) return { rows: options.anchorMissing ? [] : [{ height: options.anchorHeight ?? options.height ?? activation + 100, hash: anchorHash }] };
    if (/WHERE height=\$1/.test(sql)) return { rows: [{ hash: options.anchorChanged ? 'e'.repeat(64) : anchorHash }] };
    return { rows: options.missingHeight == null ? [] : [{ height: options.missingHeight }] };
  } };
  const rpc = async (method, params = []) => {
    if (options.rpcError) throw new Error('https://user:private@example.invalid failed');
    if (method === 'getblockhash') {
      if (params[0] === 0) return options.genesis ?? genesis;
      if (options.anchorRpcError) throw new Error('Node checkpoint unavailable');
      return options.nodeAnchor ?? anchorHash;
    }
    return options.info ?? { chain: 'test', blocks: options.height ?? activation + 100, upgrades: {
      blossom: { name: 'Blossom', activationheight: 584000 }, nu7: { name: 'NU7', activationheight: activation },
    } };
  };
  return { queries, check: extra => checkAllocationHealth({ pool, rpc, network: 'testnet', state, systemd, now, ...extra }) };
}

test('health verifies recent execution and canonical allocation gaps with the serving-node grace window', async () => {
  const h = harness();
  const health = await h.check();
  assert.deepEqual(health, { version: 1, network: 'testnet', checkedAt: new Date(now).toISOString(), status: 'healthy', reason: 'ok' });
  const candidates = h.queries.find(query => /ORDER BY b.height/.test(query.sql));
  assert.deepEqual(candidates.params, [activation, activation + 76, 'test', 1, []]);
  assert.ok(h.queries.every(query => /^SELECT/.test(query.sql)), 'monitor never writes observations or cache records');
});

test('old allocation gaps are unhealthy even when a fresh successful worker is deferring the failed hash', async () => {
  const h = harness({ missingHeight: activation + 1 });
  const health = await h.check({ state: { ...state, retries: { ['a'.repeat(64)]: { nextRetryAt: new Date(now + 900000).toISOString() } } } });
  assert.equal(health.status, 'unhealthy');
  assert.equal(health.reason, 'allocation_gap');
  assert.equal(health.missingHeight, activation + 1);
  assert.deepEqual(h.queries.find(query => /ORDER BY b.height/.test(query.sql)).params[4], [], 'monitor must not hide deferred failed heights');
});

test('missing state, wrong network, stale completion and stale success remain unhealthy', async () => {
  for (const [changed, reason] of [
    [null, 'state_unavailable'], [initialState('testnet'), 'state_unavailable'],
    [{ ...state, status: 'unknown' }, 'state_unavailable'],
    [{ ...state, network: 'mainnet' }, 'state_unavailable'],
    [{ ...state, lastFinished: new Date(now - 300001).toISOString() }, 'job_completion_stale'],
    [{ ...state, lastSuccess: new Date(now - 300001).toISOString() }, 'job_success_stale'],
    [{ ...state, lastSuccess: new Date(now + 30001).toISOString() }, 'job_success_stale'],
  ]) {
    const h = harness();
    const health = await h.check({ state: changed });
    assert.equal(health.reason, reason);
    assert.equal(health.status, 'unhealthy');
    assert.equal(h.queries.length, 0);
  }
});

test('disabled timers, failed services and hung or failed jobs cannot report healthy', async () => {
  for (const extra of [
    { systemd: { ...systemd, timerActive: 'inactive' } },
    { systemd: { ...systemd, timerEnabled: 'disabled' } },
    { systemd: { ...systemd, serviceResult: 'timeout' } },
    { state: { ...state, status: 'error' } },
    { state: { ...state, status: 'degraded' } },
    { state: { ...state, status: 'running', lastAttempt: new Date(now - 75001).toISOString() } },
  ]) assert.equal((await harness().check(extra)).status, 'unhealthy');
  assert.equal((await harness().check({ state: { ...state, status: 'running' } })).status, 'healthy', 'a bounded in-progress run may retain a recent successful heartbeat');
});

test('database, network, genesis and RPC failures return only stable public-safe reason codes', async () => {
  for (const options of [{ passive: true }, { databaseError: true }, { rpcError: true },
    { genesis: 'a'.repeat(64) }, { info: { chain: 'main', blocks: activation } },
    { info: { chain: 'test', blocks: activation, upgrades: {} } }]) {
    const health = await harness(options).check();
    assert.equal(health.status, 'unhealthy');
    assert.match(health.reason, /^[a-z_]+$/);
    assert.doesNotMatch(JSON.stringify(health), /password|private|https:|example\.invalid/);
  }
});

test('a recovered worker and repaired canonical gap return healthy on the next check', async () => {
  assert.equal((await harness({ missingHeight: activation }).check()).reason, 'allocation_gap');
  assert.equal((await harness().check({ state: { ...state, lastSuccess: new Date(now).toISOString() } })).status, 'healthy');
});

test('an equal-height node reorg cannot report healthy for stale database allocations', async () => {
  assert.equal((await harness({ nodeAnchor: 'e'.repeat(64) }).check()).reason, 'anchor_mismatch');
  assert.equal((await harness({ anchorChanged: true }).check()).reason, 'anchor_changed');
  assert.equal((await harness({ anchorMissing: true }).check()).reason, 'anchor_unavailable');
  assert.equal((await harness({ anchorRpcError: true }).check()).reason, 'anchor_unavailable');
  assert.equal((await harness({ anchorHeight: activation + 101 }).check()).reason, 'anchor_unavailable');
  assert.equal((await harness().check()).status, 'healthy', 'matching canonical checkpoint recovers on the next check');
});

test('the 24-block grace includes its oldest boundary and never fabricates a preactivation range', async () => {
  const recent = harness({ height: activation + 23, missingHeight: activation });
  assert.equal((await recent.check()).status, 'healthy');
  assert.equal(recent.queries.some(query => /ORDER BY b.height/.test(query.sql)), false);
  assert.equal((await harness({ height: activation + 24, missingHeight: activation }).check()).reason, 'allocation_gap');
});

test('systemd units bound hangs and retain private state without a notification sender', () => {
  for (const name of ['cipherscan-subsidy-allocations', 'cipherscan-subsidy-allocations-health']) {
    const service = fs.readFileSync(`server/deploy/${name}.service`, 'utf8');
    assert.match(service, /StateDirectory=cipherscan-subsidy-allocations\n/);
    assert.match(service, /StateDirectoryMode=0700\n/);
    assert.match(service, /TimeoutStartSec=60\n/);
    assert.match(service, /TimeoutStopSec=5\n/);
    assert.doesNotMatch(service, /OnFailure|sendMessage/);
    const timer = fs.readFileSync(`server/deploy/${name}.timer`, 'utf8');
    assert.match(timer, /OnUnitInactiveSec=60\n/);
    assert.match(timer, /WantedBy=timers.target/);
  }
});
