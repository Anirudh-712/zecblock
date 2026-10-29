'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_STATE_FILE = '/var/lib/cipherscan-subsidy-allocations/state.json';
const MAX_RETRIES = 5000;
// Always acquire this session lock before the worker's 360036 lock. The CLI
// pool has two connections; the outer session remains checked out throughout.
const ALLOCATION_STATE_LOCK_ID = 360037;
const HASH = /^[0-9a-f]{64}$/;
const NETWORKS = new Set(['mainnet', 'testnet']);
const STATUSES = new Set(['new', 'running', 'complete', 'budget', 'inactive', 'busy', 'degraded', 'error']);

function sanitizeMessage(value) {
  return String(value ?? 'Allocation maintenance failed')
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .replace(/(password|token|secret|cookie|authorization|api[-_ ]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 240);
}

function initialState(network) {
  if (!NETWORKS.has(network)) throw new Error('Explicit NETWORK=mainnet or testnet is required');
  return { version: 1, network, status: 'new', lastAttempt: null, lastFinished: null,
    lastSuccess: null, lastError: null, result: null, retries: {} };
}

async function readAllocationState(filePath, network) {
  const empty = initialState(network);
  let input;
  try {
    if ((await fs.stat(filePath)).size > 4 * 1024 * 1024) throw new Error('Allocation state exceeds size limit');
    input = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return empty;
    throw new Error('Allocation state is unreadable or malformed');
  }
  if (input?.version !== 1 || input.network !== network || !STATUSES.has(input.status) || !input.retries || Array.isArray(input.retries)
    || typeof input.retries !== 'object' || Object.keys(input.retries).length > MAX_RETRIES) {
    throw new Error('Allocation state identity or retry entries are invalid');
  }
  for (const [hash, retry] of Object.entries(input.retries)) {
    if (!HASH.test(hash) || !Number.isSafeInteger(retry?.height) || retry.height < 0 || retry.height > 499999999
      || !Number.isSafeInteger(retry.attempts) || retry.attempts < 1 || retry.attempts > 32
      || !Number.isFinite(Date.parse(retry.nextRetryAt)) || !Number.isFinite(Date.parse(retry.lastFailedAt))) {
      throw new Error('Allocation retry entry is invalid');
    }
  }
  return { ...empty, ...input };
}

async function writePrivateJson(filePath, value, { beforePublish = () => {} } = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    beforePublish();
    await fs.rename(temporary, filePath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

function deferredHashes(state, now) {
  return Object.entries(state.retries).filter(([, retry]) => Date.parse(retry.nextRetryAt) > now)
    .map(([hash]) => hash).slice(0, MAX_RETRIES);
}

function finishState(state, result, finishedAt) {
  const retries = { ...state.retries };
  for (const hash of result.writtenHashes ?? []) if (HASH.test(hash)) delete retries[hash];
  const failures = (result.failures ?? []).map(failure => ({ height: failure.height, hash: failure.hash,
    message: sanitizeMessage(failure.message) }));
  for (const failure of failures) {
    if (!HASH.test(failure.hash) || !Number.isSafeInteger(failure.height) || failure.height < 0 || failure.height > 499999999) {
      throw new Error('Maintenance returned an invalid failed candidate');
    }
    const attempts = Math.min(32, (retries[failure.hash]?.attempts ?? 0) + 1);
    const delay = Math.min(15 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 4));
    retries[failure.hash] = { height: failure.height, attempts,
      lastFailedAt: new Date(finishedAt).toISOString(), nextRetryAt: new Date(finishedAt + delay).toISOString(),
      message: failure.message };
  }
  const bounded = Object.fromEntries(Object.entries(retries)
    .sort((a, b) => Date.parse(b[1].lastFailedAt) - Date.parse(a[1].lastFailedAt)).slice(0, MAX_RETRIES));
  const successful = failures.length === 0 && ['complete', 'budget', 'inactive'].includes(result.status);
  return { ...state, status: failures.length ? 'degraded' : result.status,
    lastFinished: new Date(finishedAt).toISOString(),
    lastSuccess: successful ? new Date(finishedAt).toISOString() : state.lastSuccess,
    lastError: failures.length ? `${failures.length} historical allocation candidate(s) failed` : null,
    result: { ...result, failures }, retries: bounded };
}

async function withStateOwnership(pool, work, onOwnershipLost = () => {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('Allocation state requires a dedicated ownership session');
  const client = await pool.connect();
  let locked = false;
  let lost = null;
  const assertOwned = () => { if (lost) throw lost; };
  const onLost = () => {
    if (lost) return;
    lost = new Error('Allocation state ownership connection was lost');
    onOwnershipLost();
  };
  client.on('error', onLost);
  client.on('end', onLost);
  try {
    const result = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [ALLOCATION_STATE_LOCK_ID]);
    assertOwned();
    locked = result.rows[0]?.acquired === true;
    if (!locked) return { state: null, exitCode: 0,
      result: { status: 'busy', candidates: 0, processed: 0, written: 0, skipped: 0, failures: [], writtenHashes: [] } };
    return await work(assertOwned);
  } finally {
    if (locked && !lost) {
      try { await client.query('SELECT pg_advisory_unlock($1)', [ALLOCATION_STATE_LOCK_ID]); }
      catch { lost = new Error('Allocation state ownership could not be released'); }
    }
    client.off('error', onLost);
    client.off('end', onLost);
    client.release(lost);
  }
}

async function runOwnedMaintenance({ filePath, network, maintain, now }, assertOwned) {
  const read = async () => {
    assertOwned();
    const state = await readAllocationState(filePath, network);
    assertOwned();
    return state;
  };
  const write = async state => {
    assertOwned();
    await writePrivateJson(filePath, state, { beforePublish: assertOwned });
    assertOwned();
  };
  const started = now();
  const previous = await read();
  const running = { ...previous, status: 'running', lastAttempt: new Date(started).toISOString(), lastError: null };
  await write(running);
  try {
    const result = await maintain({ excludeHashes: deferredHashes(previous, started) });
    const state = finishState(await read(), result, now());
    await write(state);
    return { result: state.result, state, exitCode: state.result.failures.length ? 1 : 0 };
  } catch (error) {
    assertOwned();
    const current = await read().catch(() => running);
    await write({ ...current, status: 'error',
      lastFinished: new Date(now()).toISOString(), lastError: sanitizeMessage(error.message) });
    throw error;
  }
}

async function runMaintenanceWithState({ filePath = DEFAULT_STATE_FILE, network, maintain, now = Date.now,
  ownershipPool, onOwnershipLost } = {}) {
  initialState(network);
  return withStateOwnership(ownershipPool,
    assertOwned => runOwnedMaintenance({ filePath, network, maintain, now }, assertOwned), onOwnershipLost);
}

module.exports = { DEFAULT_STATE_FILE, MAX_RETRIES, ALLOCATION_STATE_LOCK_ID, initialState, readAllocationState, writePrivateJson,
  sanitizeMessage, deferredHashes, finishState, withStateOwnership, runMaintenanceWithState };
