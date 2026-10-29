// Period charts aggregate exact block amounts in PostgreSQL, before returning
// at most ~241 UTC buckets. Do not round 60% of an already aggregated fee sum.
const { allocationJoin, allocationColumns, sampledSubsidyZatSql } = require('./subsidy-allocations');

function accountingPeriodSql(withAllocations = false) {
  return `WITH canonical AS MATERIALIZED (
  SELECT b.height, b.hash, b.timestamp, b.transaction_count, a.nsm_balance_zat,
    a.subsidy, ${allocationColumns(withAllocations)}, t.*,
    b.height - lag(b.height, 1, $2::bigint - 1) OVER (ORDER BY b.height) - 1 AS missing_before
  FROM blocks b
  LEFT JOIN node_accounting_observations a ON a.height=b.height AND a.hash=b.hash AND a.chain=$3
  ${allocationJoin(withAllocations, '$3')}
  LEFT JOIN LATERAL (
    SELECT count(txid) AS tx_count, count(*) FILTER (WHERE is_coinbase) AS coinbases,
      count(*) FILTER (WHERE NOT is_coinbase AND (fee IS NULL OR fee < 0)) AS invalid_fees,
      coalesce(sum(fee) FILTER (WHERE NOT is_coinbase),0)::numeric AS fees,
      sum(total_output-value_balance_sapling-value_balance_orchard-value_balance_ironwood)
        FILTER (WHERE is_coinbase) AS coinbase_value
    FROM transactions WHERE block_height=b.height AND block_hash=b.hash
  ) t ON true WHERE b.height BETWEEN $2 AND $1
), allocations AS MATERIALIZED (
  SELECT *, coalesce(allocation_founders_zat::numeric, ${sampledSubsidyZatSql('founders')}) AS founders_zat,
    coalesce(allocation_funding_streams_zat::numeric, ${sampledSubsidyZatSql('fundingstreamstotal')}) AS funding_streams_zat
  FROM canonical
), amounts AS MATERIALIZED (
  SELECT *, CASE WHEN tx_count=transaction_count AND coinbases=1 AND invalid_fees=0
    AND fees BETWEEN 0 AND 2100000000000000 THEN fees END AS paid,
    CASE WHEN tx_count=transaction_count AND coinbases=1 AND invalid_fees=0
      AND coinbase_value BETWEEN 0 AND 2100000000000000
      AND founders_zat IS NOT NULL AND funding_streams_zat IS NOT NULL
      AND coinbase_value >= founders_zat + funding_streams_zat
    THEN coinbase_value - founders_zat - funding_streams_zat END AS receipts
  FROM allocations
), exact AS MATERIALIZED (
  SELECT *, floor(paid*3/5) AS removed FROM amounts
), bounds AS (
  SELECT greatest(300, ceil((max(timestamp)-min(timestamp))/240.0/300)*300)::bigint AS bucket_seconds FROM exact WHERE $4::bigint IS NULL OR timestamp >= $4
), buckets AS (
  SELECT floor(e.timestamp / bounds.bucket_seconds)::bigint * bounds.bucket_seconds AS timestamp,
    min(height) AS first_height, max(height) AS last_height, count(*)::int AS blocks,
    count(paid)::int AS fee_blocks, count(receipts)::int AS receipt_blocks, count(nsm_balance_zat)::int AS nsm_samples,
    sum(missing_before)::int AS missing_blocks,
    CASE WHEN count(paid)=count(*) AND sum(missing_before)=0 THEN sum(paid)::text END AS fees_paid_zat,
    CASE WHEN count(paid)=count(*) AND sum(missing_before)=0 THEN sum(removed)::text END AS fees_to_nsm_zat,
    CASE WHEN count(paid)=count(*) AND sum(missing_before)=0 THEN sum(paid-removed)::text END AS miner_fee_allocation_zat,
    CASE WHEN count(receipts)=count(*) AND sum(missing_before)=0 THEN sum(trunc(receipts))::text END AS miner_receipts_zat,
    (array_agg(nsm_balance_zat ORDER BY height DESC) FILTER (WHERE nsm_balance_zat IS NOT NULL))[1]::text AS nsm_balance_zat,
    sum(removed) AS removed_sum, count(*)-count(paid)+sum(missing_before) AS unknown_fees
  FROM exact e CROSS JOIN bounds GROUP BY 1
), cumulative AS (
  SELECT *, CASE WHEN sum(unknown_fees) OVER (ORDER BY timestamp)=0
    THEN (sum(removed_sum) OVER (ORDER BY timestamp))::text END AS cumulative_removal_zat FROM buckets
), totals AS (
  SELECT jsonb_build_object('blocks',count(*),'feeBlocks',count(paid),'receiptBlocks',count(receipts),'nsmSamples',count(nsm_balance_zat),
    'missingBlocks',coalesce(sum(missing_before),0),
    'feesPaidZat',CASE WHEN count(*)>0 AND count(paid)=count(*) AND sum(missing_before)=0 THEN sum(paid)::text END,
    'feesToNsmZat',CASE WHEN count(*)>0 AND count(paid)=count(*) AND sum(missing_before)=0 THEN sum(removed)::text END,
    'minerFeeAllocationZat',CASE WHEN count(*)>0 AND count(paid)=count(*) AND sum(missing_before)=0 THEN sum(paid-removed)::text END,
    'firstHeight',min(height),'lastHeight',max(height),'firstTimestamp',min(timestamp),'lastTimestamp',max(timestamp)) AS value
  FROM exact
), selected AS (
  SELECT jsonb_build_object('blocks',count(*),'feeBlocks',count(paid),'receiptBlocks',count(receipts),'nsmSamples',count(nsm_balance_zat),
    'missingBlocks',coalesce(sum(missing_before),0),
    'feesPaidZat',CASE WHEN count(*)>0 AND count(paid)=count(*) AND sum(missing_before)=0 THEN sum(paid)::text END,
    'feesToNsmZat',CASE WHEN count(*)>0 AND count(paid)=count(*) AND sum(missing_before)=0 THEN sum(removed)::text END,
    'minerFeeAllocationZat',CASE WHEN count(*)>0 AND count(paid)=count(*) AND sum(missing_before)=0 THEN sum(paid-removed)::text END,
    'firstHeight',min(height),'lastHeight',max(height),'firstTimestamp',min(timestamp),'lastTimestamp',max(timestamp)) AS value
  FROM exact WHERE $4::bigint IS NULL OR timestamp >= $4
), selected_buckets AS (
  -- A boundary bucket must contain only the requested period's blocks. Its
  -- cumulative value still includes all earlier NU7 blocks.
  SELECT floor(e.timestamp / bounds.bucket_seconds)::bigint * bounds.bucket_seconds AS timestamp,
    min(height) AS first_height, max(height) AS last_height, count(*)::int AS blocks,
    count(paid)::int AS fee_blocks, count(receipts)::int AS receipt_blocks, count(nsm_balance_zat)::int AS nsm_samples,
    sum(missing_before)::int AS missing_blocks,
    CASE WHEN count(paid)=count(*) AND sum(missing_before)=0 THEN sum(paid)::text END AS fees_paid_zat,
    CASE WHEN count(paid)=count(*) AND sum(missing_before)=0 THEN sum(removed)::text END AS fees_to_nsm_zat,
    CASE WHEN count(paid)=count(*) AND sum(missing_before)=0 THEN sum(paid-removed)::text END AS miner_fee_allocation_zat,
    CASE WHEN count(receipts)=count(*) AND sum(missing_before)=0 THEN sum(trunc(receipts))::text END AS miner_receipts_zat,
    (array_agg(nsm_balance_zat ORDER BY height DESC) FILTER (WHERE nsm_balance_zat IS NOT NULL))[1]::text AS nsm_balance_zat,
    (array_agg(height ORDER BY height DESC) FILTER (WHERE nsm_balance_zat IS NOT NULL))[1] AS nsm_sample_height,
    (array_agg(hash ORDER BY height DESC) FILTER (WHERE nsm_balance_zat IS NOT NULL))[1] AS nsm_sample_hash,
    (array_agg(e.timestamp ORDER BY height DESC) FILTER (WHERE nsm_balance_zat IS NOT NULL))[1] AS nsm_sample_timestamp
  FROM exact e CROSS JOIN bounds WHERE $4::bigint IS NULL OR e.timestamp >= $4 GROUP BY 1
), baseline AS (
  SELECT b.height,b.hash,a.nsm_balance_zat::text AS balance FROM blocks b
  LEFT JOIN node_accounting_observations a ON a.height=b.height AND a.hash=b.hash AND a.chain=$3
  WHERE b.height=$2-1
), tip AS (SELECT height,hash,nsm_balance_zat::text AS balance FROM exact ORDER BY height DESC LIMIT 1)
SELECT (SELECT value FROM totals) AS totals, (SELECT value FROM selected) AS selected,
  (SELECT bucket_seconds FROM bounds) AS bucket_seconds,
  (SELECT row_to_json(baseline) FROM baseline) AS baseline,
  (SELECT row_to_json(tip) FROM tip) AS tip,
  coalesce((SELECT jsonb_agg(jsonb_build_object('timestamp',s.timestamp,'firstHeight',s.first_height,
    'lastHeight',s.last_height,'blocks',s.blocks,'feeBlocks',s.fee_blocks,'receiptBlocks',s.receipt_blocks,'nsmSamples',s.nsm_samples,
    'missingBlocks',s.missing_blocks,'feesPaidZat',s.fees_paid_zat,'feesToNsmZat',s.fees_to_nsm_zat,
    'minerFeeAllocationZat',s.miner_fee_allocation_zat,'minerReceiptsZat',s.miner_receipts_zat,
    'nsmBalanceZat',CASE WHEN s.missing_blocks=0 THEN s.nsm_balance_zat END,
    'nsmSampleHeight',CASE WHEN s.missing_blocks=0 THEN s.nsm_sample_height END,
    'nsmSampleHash',CASE WHEN s.missing_blocks=0 THEN s.nsm_sample_hash END,
    'nsmSampleTimestamp',CASE WHEN s.missing_blocks=0 THEN s.nsm_sample_timestamp END,
    'cumulativeRemovalZat',c.cumulative_removal_zat) ORDER BY s.timestamp)
    FROM selected_buckets s JOIN cumulative c USING(timestamp)), '[]'::jsonb) AS points`;
}
const PERIOD_SQL = accountingPeriodSql();

function periodPayload(row, period, schedule, info, observedAt) {
  const baseline = row.baseline ?? null;
  const tip = row.tip ?? null;
  const balance = tip?.balance;
  return { success: true, period, schedule, nodeHeight: info.blocks, indexedHeight: tip?.height ?? null, observedAt,
    bucketSeconds: Number(row.bucket_seconds ?? 300), points: row.points ?? [],
    totals: row.totals, selected: row.selected,
    reserve: { baselineHeight: baseline?.height ?? null, baselineZat: baseline?.balance ?? null,
      height: tip?.height ?? null, balanceZat: balance ?? null,
      growthSinceNu7Zat: baseline?.balance != null && balance != null ? (BigInt(balance)-BigInt(baseline.balance)).toString() : null },
    source: 'complete-canonical-indexed-transactions-and-hash-matched-node-observations',
    timeBasis: 'block-header-timestamps-UTC',
    sampling: 'Reserve is the last recorded canonical observation within each selected bucket, identified by nsmSampleHeight, nsmSampleHash and its block-header nsmSampleTimestamp. Buckets without a sample or with missing canonical blocks remain null. No interpolation or carry-forward from outside the bucket or selected period. Latest reserve and growth still require the exact end-block sample.',
    nsmChangeMeaning: 'Net reserve growth from the preactivation sample, not cumulative fees or gross removal.' };
}

module.exports = { PERIOD_SQL, accountingPeriodSql, periodPayload };
