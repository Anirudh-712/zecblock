const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readAllocationHealth } = require('../lib/subsidy-allocation-health');

test('public allocation health requires a recent healthy same-network report', async () => {
  const now = 1792146000000;
  const read = report => readAllocationHealth('/private/never-published', 'testnet', { now: () => now, readFile: async () => JSON.stringify(report) });
  const valid = { checkedAt: new Date(now - 60000).toISOString(), network: 'testnet', status: 'healthy' };
  assert.deepEqual(await read(valid), { status: 'up', age_seconds: 60 });
  assert.equal((await read({ ...valid, checkedAt: new Date(now - 300001).toISOString() })).status, 'stale');
  assert.equal((await read({ ...valid, checkedAt: new Date(now + 30001).toISOString() })).status, 'stale');
  for (const change of [{ network: 'mainnet' }, { checkedAt: 'bad' }, { checkedAt: null }]) assert.equal((await read({ ...valid, ...change })).status, 'unavailable');
  for (const status of ['unhealthy', 'error', undefined]) assert.equal((await read({ ...valid, status })).status, 'unhealthy');
  assert.deepEqual(await readAllocationHealth('/private/missing', 'testnet', { readFile: async () => { throw new Error('sensitive path'); } }), { status: 'unavailable' });
  assert.deepEqual(await readAllocationHealth('/private/large', 'testnet', { readFile: async () => 'x'.repeat(16385) }), { status: 'unavailable' });
});

test('configured allocation monitor failure makes deep health 503 and healthy recovery clears it', async () => {
  const previous = { network: process.env.NETWORK, file: process.env.SUBSIDY_ALLOCATION_HEALTH_FILE };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'subsidy-health-'));
  const filename = path.join(directory, 'health.json');
  process.env.NETWORK = 'testnet';
  delete process.env.SUBSIDY_ALLOCATION_HEALTH_FILE;
  const app = express();
  app.locals.pool = { query: async () => ({ rows: [] }) };
  app.locals.chainTip = { height: 4500000 };
  app.locals.callZebraRPC = async () => 4500000;
  app.use(require('../routes/blocks'));
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const get = async () => { const response = await fetch(`http://127.0.0.1:${server.address().port}/health/deep`); assert.equal(response.headers.get('cache-control'), 'no-store'); return { code: response.status, body: await response.json() }; };
  try {
    let result = await get();
    assert.equal(result.code, 200); assert.equal(result.body.checks.subsidy_allocations, undefined);
    process.env.SUBSIDY_ALLOCATION_HEALTH_FILE = filename;
    result = await get(); assert.equal(result.code, 503); assert.equal(result.body.checks.subsidy_allocations.status, 'unavailable');
    await fs.writeFile(filename, JSON.stringify({ network: 'testnet', checkedAt: new Date().toISOString(), status: 'unhealthy', reason: 'do not publish this' }));
    result = await get(); assert.equal(result.code, 503); assert.equal(result.body.checks.subsidy_allocations.status, 'unhealthy');
    assert.equal(JSON.stringify(result.body).includes('do not publish'), false);
    await fs.writeFile(filename, JSON.stringify({ network: 'testnet', checkedAt: new Date().toISOString(), status: 'healthy' }));
    result = await get(); assert.equal(result.code, 200); assert.equal(result.body.status, 'healthy');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
    if (previous.network === undefined) delete process.env.NETWORK; else process.env.NETWORK = previous.network;
    if (previous.file === undefined) delete process.env.SUBSIDY_ALLOCATION_HEALTH_FILE; else process.env.SUBSIDY_ALLOCATION_HEALTH_FILE = previous.file;
  }
});
