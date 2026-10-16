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
  ORDER BY b.height LIMIT $4`;

// One statement rechecks DB identity; a later reorg can retain an orphan cache
// record, but canonical hash/height/network joins can never expose it as current.
const INSERT_SQL = `INSERT INTO public.block_subsidy_allocations
  (hash,height,chain,founders_zat,funding_streams_zat,miner_zat,source)
  SELECT b.hash,b.height,$3,$4,$5,$6,'getblocksubsidy'
  FROM public.blocks b WHERE b.hash=$1 AND b.height=$2
  ON CONFLICT (hash) DO NOTHING RETURNING hash`;

async function maintainAllocations(pool, rpc, {
  network, limit = 100, timeBudgetMs = 45000, now = Date.now,
} = {}) {
  const expectedChain = { mainnet: 'main', testnet: 'test' }[network];
  if (!expectedChain) throw new Error('Explicit NETWORK=mainnet or testnet is required');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Allocation batch limit must be 1–500');
  if (!Number.isSafeInteger(timeBudgetMs) || timeBudgetMs < 1 || timeBudgetMs > 60000) throw new Error('Allocation time budget must be 1–60000 ms');
  const deadline = now() + timeBudgetMs;
  const client = await pool.connect();
  let locked = false;
  const result = { status: 'complete', candidates: 0, processed: 0, written: 0, skipped: 0 };
  const call = async (method, params = []) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('Allocation maintenance time budget exhausted');
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

    const { rows } = await client.query(CANDIDATES_SQL, [schedule.nu7Height, info.blocks, expectedChain, limit]);
    result.candidates = rows.length;
    for (const row of rows) {
      if (now() >= deadline) { result.status = 'budget'; break; }
      const height = Number(row.height);
      if (!Number.isSafeInteger(height) || height < schedule.nu7Height || height > info.blocks || !HASH.test(row.hash ?? '')) throw new Error('Invalid canonical allocation candidate');
      result.processed++;
      if (await call('getblockhash', [height]) !== row.hash) { result.skipped++; continue; }
      const allocations = parseRpcSubsidyAllocations(await call('getblocksubsidy', [height]));
      if (!allocations) throw new Error(`Historical subsidy allocations unavailable at height ${height}`);
      if (await call('getblockhash', [height]) !== row.hash) { result.skipped++; continue; }
      const written = await client.query(INSERT_SQL, [row.hash, height, expectedChain,
        allocations.foundersZat, allocations.fundingStreamsZat, allocations.minerZat]);
      result.written += written.rowCount;
      if (!written.rowCount) result.skipped++;
    }
    return result;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

module.exports = { maintainAllocations, CANDIDATES_SQL, INSERT_SQL };
