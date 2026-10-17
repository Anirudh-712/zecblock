// Historical subsidy allocations are deterministic node RPC results, separate
// from real-time NSM/pool samples. Missing tables are supported during rollout.
const availability = new WeakMap();
const MAX_ZAT = '2100000000000000';

async function hasSubsidyAllocations(pool) {
  const now = Date.now();
  let cached = availability.get(pool);
  if (!cached || cached.expires <= now) {
    cached = { expires: now + 30000, promise: pool.query(
      "SELECT to_regclass('public.block_subsidy_allocations') IS NOT NULL AS available",
    ).then(({ rows }) => rows[0]?.available === true) };
    availability.set(pool, cached);
    cached.promise.catch(() => availability.delete(pool));
  }
  return cached.promise;
}

function allocationJoin(enabled, chainParameter) {
  if (!enabled) return '';
  return `LEFT JOIN public.block_subsidy_allocations sa ON sa.height=b.height AND sa.hash=b.hash
    AND sa.chain=${chainParameter} AND sa.source='getblocksubsidy'
    AND sa.founders_zat BETWEEN 0 AND ${MAX_ZAT}
    AND sa.funding_streams_zat BETWEEN 0 AND ${MAX_ZAT}
    AND (sa.miner_zat IS NULL OR sa.miner_zat BETWEEN 0 AND ${MAX_ZAT})`;
}

function allocationColumns(enabled) {
  return ['founders', 'funding_streams', 'miner'].map(key =>
    `${enabled ? `sa.${key}_zat::text` : 'NULL::text'} AS allocation_${key}_zat`).join(', ');
}

// Match the JS decoder: only exact, nonnegative JSON-number amounts are valid.
function sampledSubsidyZatSql(key, alias = '') {
  const subsidy = alias ? `${alias}.subsidy` : 'subsidy';
  return `CASE WHEN jsonb_typeof(${subsidy}->'${key}')='number' THEN
    CASE WHEN (${subsidy}->>'${key}')::numeric BETWEEN 0 AND 21000000
      AND (${subsidy}->>'${key}')::numeric*100000000=trunc((${subsidy}->>'${key}')::numeric*100000000)
    THEN (${subsidy}->>'${key}')::numeric*100000000 END END`;
}

function sampledAllocationsSql(alias = 'a') {
  return { founders: sampledSubsidyZatSql('founders', alias),
    funding: sampledSubsidyZatSql('fundingstreamstotal', alias), miner: sampledSubsidyZatSql('miner', alias) };
}

/** Parse RPC coin units without rounding or accepting fractional zatoshis. */
function exactCoinZat(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > 21000000) return null;
    const fixed = value.toFixed(8);
    if (Number(fixed) !== value) return null;
    value = fixed;
  }
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const zat = BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'));
  return zat <= BigInt(MAX_ZAT) ? zat.toString() : null;
}

function parseRpcSubsidyAllocations(subsidy) {
  const foundersZat = exactCoinZat(subsidy?.founders);
  const fundingStreamsZat = exactCoinZat(subsidy?.fundingstreamstotal);
  if (foundersZat === null || fundingStreamsZat === null) return null;
  return { foundersZat, fundingStreamsZat, minerZat: exactCoinZat(subsidy?.miner) };
}

module.exports = { hasSubsidyAllocations, allocationJoin, allocationColumns,
  sampledSubsidyZatSql, sampledAllocationsSql, exactCoinZat, parseRpcSubsidyAllocations };
