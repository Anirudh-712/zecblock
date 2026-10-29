const { getPoolTagSql, getPoolName, POOL_BY_TAG } = require('../mining-pools');

const PERIODS = ['24h', '7d', '30d'];

// A single statement gives the numerator and denominator the same snapshot
// and clock. External hash reports are not validated blocks; indexer archives
// were copied from the canonical chain before rollback. A restored hash is
// excluded even if an old archive row remains.
const ORPHAN_RATES_SQL = `
WITH clock AS (
  SELECT floor(extract(epoch FROM now()))::bigint AS as_of
), windows AS (
  SELECT period, as_of - seconds AS window_start, as_of AS window_end
  FROM clock CROSS JOIN (VALUES ('24h', 86400), ('7d', 604800), ('30d', 2592000)) p(period, seconds)
), tip AS (
  SELECT height, hash, timestamp FROM blocks ORDER BY height DESC LIMIT 1
), history AS (
  SELECT min(timestamp) AS history_start FROM blocks
), capture AS (
  SELECT min(collection_started_at) AS capture_start, max(heartbeat_at) AS capture_heartbeat,
    count(*) FILTER (WHERE stream_connected AND heartbeat_at > now() - interval '45 seconds' AND pending_records=0)::integer AS healthy_observers,
    count(*)::integer AS observers
  FROM block_capture_observers
), observed AS (
  -- Prefer the established archive's attribution when both sources saw a hash.
  SELECT DISTINCT ON (hash) hash, timestamp, miner_address, coinbase_hex
  FROM (
    SELECT ob.hash, ob.timestamp, ob.miner_address, ob.coinbase_hex, 0 AS priority
    FROM orphaned_blocks ob
    WHERE ob.source='indexer' AND ob.consensus_valid IS DISTINCT FROM false
      AND ob.timestamp >= (SELECT min(window_start) FROM windows)
      AND ob.timestamp < (SELECT max(window_end) FROM windows)
    UNION ALL
    SELECT c.hash, c.timestamp, c.miner_address, c.coinbase_hex, 1 AS priority
    FROM captured_blocks c JOIN blocks replacement ON replacement.height=c.height
    WHERE replacement.hash <> c.hash
      AND c.timestamp >= (SELECT min(window_start) FROM windows)
      AND c.timestamp < (SELECT max(window_end) FROM windows)
  ) evidence
  WHERE NOT EXISTS (SELECT 1 FROM blocks canonical WHERE canonical.hash=evidence.hash)
  ORDER BY hash, priority
), counts AS (
  SELECT w.period, b.miner_address, ${getPoolTagSql('b.coinbase_hex')} AS tag,
         count(*)::bigint AS canonical_blocks, 0::bigint AS orphaned_blocks
  FROM windows w JOIN blocks b ON b.timestamp >= w.window_start AND b.timestamp < w.window_end
  GROUP BY w.period, b.miner_address, tag
  UNION ALL
  SELECT w.period, ob.miner_address, ${getPoolTagSql('ob.coinbase_hex')} AS tag,
         0::bigint AS canonical_blocks, count(*)::bigint AS orphaned_blocks
  FROM windows w JOIN observed ob ON ob.timestamp >= w.window_start AND ob.timestamp < w.window_end
  GROUP BY w.period, ob.miner_address, tag
)
SELECT w.*, capture.*, h.history_start, t.height AS indexed_height, t.hash AS indexed_hash,
       t.timestamp AS indexed_timestamp, c.miner_address, c.tag,
       coalesce(c.canonical_blocks, 0) AS canonical_blocks,
       coalesce(c.orphaned_blocks, 0) AS orphaned_blocks
FROM windows w CROSS JOIN history h CROSS JOIN capture LEFT JOIN tip t ON true
LEFT JOIN counts c ON c.period = w.period
`;

function count(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid orphan-rate count');
  return n;
}

function formatOrphanRates(rows) {
  const first = rows[0];
  if (!first) throw new Error('Missing orphan-rate snapshot');
  const periods = PERIODS.map(period => {
    const selected = rows.filter(row => row.period === period);
    if (!selected.length) throw new Error('Incomplete orphan-rate snapshot');
    const { window_start: start, window_end: end, history_start: historyStart } = selected[0];
    const pools = new Map();
    let canonicalBlocks = 0, orphanedBlocks = 0;
    for (const row of selected) {
      const canonical = count(row.canonical_blocks), orphaned = count(row.orphaned_blocks);
      canonicalBlocks += canonical;
      orphanedBlocks += orphaned;
      if (canonical + orphaned === 0) continue;
      const name = getPoolName(row.miner_address) || POOL_BY_TAG[row.tag]?.name || 'Unknown';
      const pool = pools.get(name) || { name, canonicalBlocks: 0, orphanedBlocks: 0 };
      pool.canonicalBlocks += canonical;
      pool.orphanedBlocks += orphaned;
      pools.set(name, pool);
    }
    const unavailableReason = historyStart == null || Number(historyStart) > Number(start)
      ? 'incomplete-canonical-history' : canonicalBlocks === 0 ? 'no-canonical-blocks' : null;
    return {
      period, windowStart: new Date(Number(start) * 1000).toISOString(),
      windowEnd: new Date(Number(end) * 1000).toISOString(),
      canonicalBlocks, orphanedBlocks,
      rate: unavailableReason ? null : orphanedBlocks / (canonicalBlocks + orphanedBlocks),
      unavailableReason,
      pools: [...pools.values()].map(pool => ({
        ...pool, rate: unavailableReason ? null : pool.orphanedBlocks / (pool.canonicalBlocks + pool.orphanedBlocks),
      })).sort((a, b) => b.orphanedBlocks - a.orphanedBlocks || b.canonicalBlocks - a.canonicalBlocks || a.name.localeCompare(b.name)),
    };
  });
  return {
    success: true, asOf: new Date(Number(first.window_end) * 1000).toISOString(),
    indexedHeight: first.indexed_height == null ? null : count(first.indexed_height),
    indexedHash: first.indexed_hash ?? null,
    indexedTimestamp: first.indexed_timestamp == null ? null : new Date(Number(first.indexed_timestamp) * 1000).toISOString(),
    method: 'observed-block-capture-v2', timeBasis: 'block-header',
    coverage: { status: 'unverified', collectionStart: null, uptimeVerified: false },
    capture: {
      startedAt: first.capture_start == null ? null : new Date(first.capture_start).toISOString(),
      heartbeatAt: first.capture_heartbeat == null ? null : new Date(first.capture_heartbeat).toISOString(),
      observers: Number(first.observers ?? 0),
      healthyObservers: Number(first.healthy_observers ?? 0),
      status: Number(first.healthy_observers ?? 0) > 0 ? 'collecting' : 'unavailable',
    },
    periods,
  };
}

async function orphanRates(pool) {
  return formatOrphanRates((await pool.query(ORPHAN_RATES_SQL)).rows);
}

module.exports = { orphanRates, formatOrphanRates, ORPHAN_RATES_SQL };
