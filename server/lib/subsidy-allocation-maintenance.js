'use strict';

const { networkSchedule } = require('../api/lib/network-schedule');
const { sampledAllocationsSql, parseRpcSubsidyAllocations } = require('../api/lib/subsidy-allocations');

const LOCK_ID = 360036;
const HASH = /^[0-9a-f]{64}$/;
const sampled = sampledAllocationsSql('a');
const CANDIDATES_SQL = `SELECT b.height, b.hash FROM public.blocks b
  LEFT JOIN public.node_accounting_observations a
    ON a.height=b.height AND a.hash=b.hash AND a.chain=$3
  WHERE b.height BETWEEN $1 AND $2
    AND (${sampled.founders} IS NULL OR ${sampled.funding} IS NULL)
    AND NOT EXISTS (SELECT 1 FROM public.block_subsidy_allocations c
      WHERE c.hash=b.hash AND c.height=b.height AND c.chain=$3)
    AND NOT (b.hash = ANY($5::text[]))
  ORDER BY b.height LIMIT $4`;

// One statement rechecks DB identity; a later reorg can retain an orphan cache
// record, but canonical hash/height/network joins can never expose it as current.
const INSERT_SQL = `INSERT INTO public.block_subsidy_allocations
  (hash,height,chain,founders_zat,funding_streams_zat,miner_zat,source)
  SELECT b.hash,b.height,$3,$4,$5,$6,'getblocksubsidy'
  FROM public.blocks b WHERE b.hash=$1 AND b.height=$2
  ON CONFLICT (hash) DO NOTHING RETURNING hash`;

class AllocationBudgetError extends Error {
  constructor() {
    super('Allocation maintenance time budget exhausted');
    this.name = 'AllocationBudgetError';
  }
}

async function maintainAllocations(pool, rpc, {
  network, limit = 100, timeBudgetMs = 45000, now = Date.now, excludeHashes = [],
} = {}) {
  const expectedChain = { mainnet: 'main', testnet: 'test' }[network];
  if (!expectedChain) throw new Error('Explicit NETWORK=mainnet or testnet is required');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Allocation batch limit must be 1–500');
  if (!Number.isSafeInteger(timeBudgetMs) || timeBudgetMs < 1 || timeBudgetMs > 60000) throw new Error('Allocation time budget must be 1–60000 ms');
  if (!Array.isArray(excludeHashes) || excludeHashes.length > 5000 || excludeHashes.some(hash => typeof hash !== 'string' || !HASH.test(hash))) {
    throw new Error('Allocation exclusions must contain at most 5000 lowercase hexadecimal block hashes');
  }
  const exclusions = [...new Set(excludeHashes)];
  const deadline = now() + timeBudgetMs;
  const client = await pool.connect();
  let locked = false;
  const result = { status: 'complete', candidates: 0, processed: 0, written: 0, skipped: 0,
    failures: [], writtenHashes: [] };
  const call = async (method, params = []) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new AllocationBudgetError();
    return rpc(method, params, { timeout: Math.min(8000, remaining) });
  };
  try {
    const recovery = await client.query('SELECT pg_is_in_recovery() AS recovery');
    if (recovery.rows[0]?.recovery !== false) throw new Error('Refusing allocation writes on a passive or unknown database');
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [LOCK_ID]);
    locked = lock.rows[0]?.acquired === true;
    if (!locked) return { ...result, status: 'busy' };

    const info = await call('getblockchaininfo');
    if (info?.chain !== expectedChain) throw new Error('Serving node network does not match configured network');
    const schedule = networkSchedule(info);
    if (!schedule || !Number.isSafeInteger(info.blocks) || info.blocks > 499999999) throw new Error('Serving node schedule or height is unavailable');
    if (schedule.nu7Height === null || info.blocks < schedule.nu7Height) return { ...result, status: 'inactive' };
    const genesis = await client.query('SELECT hash FROM public.blocks WHERE height=0');
    const hash = genesis.rows[0]?.hash;
    if (!HASH.test(hash ?? '') || await call('getblockhash', [0]) !== hash) throw new Error('Database and serving node genesis do not match');

    const { rows } = await client.query(CANDIDATES_SQL, [schedule.nu7Height, info.blocks, expectedChain, limit, exclusions]);
    result.candidates = rows.length;
    for (const row of rows) {
      if (now() >= deadline) { result.status = 'budget'; break; }
      const height = Number(row.height);
      if (!Number.isSafeInteger(height) || height < schedule.nu7Height || height > info.blocks || !HASH.test(row.hash ?? '')) throw new Error('Invalid canonical allocation candidate');
      result.processed++;
      let allocations;
      try {
        if (await call('getblockhash', [height]) !== row.hash) { result.skipped++; continue; }
        const subsidy = await call('getblocksubsidy', [height]);
        if (now() >= deadline) throw new AllocationBudgetError();
        allocations = parseRpcSubsidyAllocations(subsidy);
        if (!allocations) {
          result.failures.push({ height, hash: row.hash, message: 'Historical subsidy allocations unavailable.' });
          result.status = 'partial';
          continue;
        }
        if (await call('getblockhash', [height]) !== row.hash) { result.skipped++; continue; }
      } catch (error) {
        // A deadline-limited timeout says nothing about the block. Leave it
        // eligible next run instead of teaching the caller to back it off.
        if (error instanceof AllocationBudgetError || now() >= deadline) {
          result.status = 'budget';
          break;
        }
        result.failures.push({ height, hash: row.hash, message: 'Historical subsidy RPC unavailable.' });
        result.status = 'partial';
        continue;
      }
      if (now() >= deadline) { result.status = 'budget'; break; }
      // Database errors remain fatal: an allocation RPC failure must never
      // hide a broken writer, schema, connection or canonical insert guard.
      const written = await client.query(INSERT_SQL, [row.hash, height, expectedChain,
        allocations.foundersZat, allocations.fundingStreamsZat, allocations.minerZat]);
      result.written += written.rowCount;
      if (written.rowCount) result.writtenHashes.push(row.hash);
      else result.skipped++;
    }
    return result;
  } catch (error) {
    if (error instanceof AllocationBudgetError) return { ...result, status: 'budget' };
    throw error;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

module.exports = { maintainAllocations, CANDIDATES_SQL, INSERT_SQL };
