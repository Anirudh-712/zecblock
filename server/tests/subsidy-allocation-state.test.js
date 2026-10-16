'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { initialState, readAllocationState, writePrivateJson, deferredHashes, finishState,
  runMaintenanceWithState: runWithState } = require('../lib/subsidy-allocation-state');

function ownershipHarness() {
  let owner = null;
  const clients = [];
  const pool = { async connect() {
    const client = new EventEmitter();
    client.dead = false;
    client.query = async sql => {
      if (client.dead) throw new Error('Ownership session disconnected');
      if (/pg_try_advisory_lock/.test(sql)) {
        const acquired = owner === null;
        if (acquired) owner = client;
        return { rows: [{ acquired }] };
      }
      if (owner === client) owner = null;
      return { rows: [] };
    };
    client.release = error => { client.released = true; client.releaseError = error; if (owner === client) owner = null; };
    clients.push(client);
    return client;
  } };
  return { pool, clients, disconnectOwner() {
    const previous = owner;
    owner = null;
    previous.dead = true;
    previous.emit('error', new Error('Owner connection lost'));
  } };
}

function runMaintenanceWithState(options) {
  return runWithState({ ownershipPool: ownershipHarness().pool, ...options });
}

const baseTime = Date.parse('2026-10-16T03:00:00Z');
const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);
const success = { status: 'complete', candidates: 1, processed: 1, written: 1, skipped: 0,
  writtenHashes: [hash], failures: [] };
const partial = { ...success, status: 'partial', writtenHashes: [otherHash],
  failures: [{ height: 4465026, hash, message: 'Historical subsidy RPC unavailable.' }] };

async function stateFile(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'subsidy-state-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'private', 'state.json');
}

test('state replacement is atomic and private, with no leftover temporary files', async t => {
  const filePath = await stateFile(t);
  await writePrivateJson(filePath, initialState('testnet'));
  await writePrivateJson(filePath, { ...initialState('testnet'), status: 'running' });
  assert.equal((await readAllocationState(filePath, 'testnet')).status, 'running');
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(filePath))).mode & 0o777, 0o700);
  assert.deepEqual(await fs.readdir(path.dirname(filePath)), ['state.json']);
});

test('partial progress persists with a failed exit, and deferred hashes do not block other work', async t => {
  const filePath = await stateFile(t);
  const first = await runMaintenanceWithState({ filePath, network: 'testnet', now: () => baseTime,
    maintain: async ({ excludeHashes }) => { assert.deepEqual(excludeHashes, []); return partial; } });
  assert.equal(first.exitCode, 1);
  assert.equal(first.state.status, 'degraded');
  assert.equal(first.state.lastSuccess, null);
  assert.equal(first.state.result.written, 1);
  assert.equal(Date.parse(first.state.retries[hash].nextRetryAt), baseTime + 60_000);
  const second = await runMaintenanceWithState({ filePath, network: 'testnet', now: () => baseTime + 30_000,
    maintain: async ({ excludeHashes }) => { assert.deepEqual(excludeHashes, [hash]); return { ...success, writtenHashes: [otherHash] }; } });
  assert.equal(second.exitCode, 0);
  assert.equal(second.state.lastSuccess, new Date(baseTime + 30_000).toISOString());
  assert.equal(second.state.retries[hash].attempts, 1);
  assert.deepEqual(deferredHashes(second.state, baseTime + 60_000), [], 'the failed height becomes eligible again');
});

test('per-hash retry delays grow from one minute to fifteen and clear after successful recovery', () => {
  let state = initialState('testnet');
  let currentTime = baseTime;
  for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
    state = finishState(state, partial, currentTime);
    assert.equal(Date.parse(state.retries[hash].nextRetryAt) - currentTime, delay);
    currentTime += delay;
  }
  const recovered = finishState(state, success, currentTime);
  assert.equal(recovered.status, 'complete');
  assert.equal(recovered.lastSuccess, new Date(currentTime).toISOString());
  assert.deepEqual(recovered.retries, {});
});

test('the retry registry stays bounded while newly failed heights remain eligible for backoff', () => {
  const state = initialState('testnet');
  for (let i = 0; i < 5000; i++) state.retries[i.toString(16).padStart(64, '0')] = {
    height: i, attempts: 1, lastFailedAt: new Date(baseTime - i).toISOString(), nextRetryAt: new Date(baseTime + 60_000).toISOString(),
  };
  const next = finishState(state, partial, baseTime + 1);
  assert.equal(Object.keys(next.retries).length, 5000);
  assert.ok(next.retries[hash]);
  assert.equal(deferredHashes(next, baseTime + 1).length, 5000);
});

test('fatal errors preserve earlier progress and record a finished failed attempt without leaking credentials', async t => {
  const filePath = await stateFile(t);
  await runMaintenanceWithState({ filePath, network: 'testnet', now: () => baseTime, maintain: async () => success });
  await assert.rejects(runMaintenanceWithState({ filePath, network: 'testnet', now: () => baseTime + 60_000,
    maintain: async () => { throw new Error('RPC https://user:password@example.invalid/path token=private\nfailed'); } }));
  const state = await readAllocationState(filePath, 'testnet');
  assert.equal(state.status, 'error');
  assert.equal(state.lastSuccess, new Date(baseTime).toISOString());
  assert.equal(state.lastFinished, new Date(baseTime + 60_000).toISOString());
  assert.equal(state.result.written, 1, 'previous successful progress is retained');
  assert.doesNotMatch(state.lastError, /user:password|private|\n/);
});

test('missing state initializes safely, but corrupt or wrong-network state cannot start maintenance', async t => {
  const filePath = await stateFile(t);
  assert.equal((await readAllocationState(filePath, 'testnet')).status, 'new');
  await writePrivateJson(filePath, initialState('mainnet'));
  let calls = 0;
  await assert.rejects(runMaintenanceWithState({ filePath, network: 'testnet', maintain: async () => { calls++; return success; } }), /identity/);
  assert.equal(calls, 0);
  await fs.writeFile(filePath, '{broken');
  await assert.rejects(readAllocationState(filePath, 'testnet'), /malformed/);
  await writePrivateJson(filePath, { ...initialState('testnet'), status: 'unknown' });
  await assert.rejects(readAllocationState(filePath, 'testnet'), /identity/);
  await assert.rejects(readAllocationState(filePath, 'crosslink'), /Explicit NETWORK/);
});

test('busy and interrupted attempts cannot manufacture a fresh successful heartbeat', async t => {
  const filePath = await stateFile(t);
  const state = { ...initialState('testnet'), status: 'running', lastAttempt: new Date(baseTime).toISOString(),
    lastSuccess: new Date(baseTime - 60_000).toISOString() };
  await writePrivateJson(filePath, state);
  const result = await runMaintenanceWithState({ filePath, network: 'testnet', now: () => baseTime + 30_000,
    maintain: async () => ({ ...success, status: 'busy', written: 0, writtenHashes: [] }) });
  assert.equal(result.state.lastSuccess, state.lastSuccess);
});

test('a concurrent busy wrapper never reads or changes the active owner state', async t => {
  const filePath = await stateFile(t);
  const ownership = ownershipHarness();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let finish;
  const first = runMaintenanceWithState({ filePath, network: 'testnet', ownershipPool: ownership.pool,
    now: () => baseTime, maintain: () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
  await started;
  const beforeBusy = await fs.readFile(filePath, 'utf8');
  let calls = 0;
  const busy = await runMaintenanceWithState({ filePath, network: 'testnet', ownershipPool: ownership.pool,
    now: () => baseTime + 1, maintain: async () => { calls++; return success; } });
  assert.equal(busy.result.status, 'busy');
  assert.equal(busy.state, null);
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(filePath, 'utf8'), beforeBusy);
  finish(partial);
  assert.equal((await first).state.retries[hash].attempts, 1);
  assert.ok(ownership.clients.every(client => client.released));
});

test('an abandoned ownership session recovers and the disconnected process cannot overwrite its successor', async t => {
  const filePath = await stateFile(t);
  const ownership = ownershipHarness();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let finish;
  let lost = 0;
  const abandoned = runMaintenanceWithState({ filePath, network: 'testnet', ownershipPool: ownership.pool,
    now: () => baseTime, onOwnershipLost: () => { lost++; },
    maintain: () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
  await started;
  ownership.disconnectOwner();
  assert.equal(lost, 1);
  const recovered = await runMaintenanceWithState({ filePath, network: 'testnet', ownershipPool: ownership.pool,
    now: () => baseTime + 60_000, maintain: async () => success });
  assert.equal(recovered.state.status, 'complete');
  const successorState = await fs.readFile(filePath, 'utf8');
  finish(partial);
  await assert.rejects(abandoned, /ownership connection was lost/);
  assert.equal(await fs.readFile(filePath, 'utf8'), successorState);
  assert.ok(ownership.clients[0].released);
  assert.ok(ownership.clients[0].releaseError);
});
