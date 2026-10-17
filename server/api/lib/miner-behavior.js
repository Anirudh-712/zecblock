'use strict';

const SCOPE = 'attributed_payout_outputs';

function unavailable(period, reason) {
  return {
    period, status: 'unavailable', reason, series: [], summary: null, coverage: null,
    message: reason === 'snapshots_not_configured'
      ? 'Miner reward spending snapshots are not available on this network.'
      : 'No miner reward spending snapshots are available for this period.',
    generatedAt: new Date().toISOString(),
  };
}

function summarize(period, rows, now = Date.now()) {
  if (!rows.length) return unavailable(period, 'no_snapshots_in_period');
  const byDate = new Map();
  let refreshedAt = null, trackedBlocks = 0, trackedOutputs = 0;
  for (const row of rows) {
    const earned = BigInt(row.earned_zat), spent = BigInt(row.spent_zat), held = BigInt(row.held_zat);
    if (earned < 0n || spent < 0n || held < 0n || spent + held !== earned) throw new Error('Invalid miner behavior accounting');
    const date = row.date;
    if (!byDate.has(date)) byDate.set(date, { date, earned: 0n, spent: 0n, held: 0n, pools: {} });
    const point = byDate.get(date);
    point.earned += earned; point.spent += spent; point.held += held;
    point.pools[row.pool_name] = { earned: earned.toString(), spent: spent.toString(), held: held.toString(), blocks: Number(row.blocks_mined) };
    trackedBlocks += Number(row.blocks_mined);
    trackedOutputs += Number(row.outputs_total);
    if (row.updated_at) {
      const time = new Date(row.updated_at).toISOString();
      if (!refreshedAt || time < refreshedAt) refreshedAt = time;
    }
  }
  const series = [...byDate.values()].map(point => ({
    date: point.date, earnedZat: point.earned.toString(), spentZat: point.spent.toString(), heldZat: point.held.toString(),
    sellRatio: point.earned > 0n ? Number(point.spent * 10000n / point.earned) / 10000 : 0,
    pools: point.pools,
  }));
  const earned = series.reduce((sum, point) => sum + BigInt(point.earnedZat), 0n);
  const spent = series.reduce((sum, point) => sum + BigInt(point.spentZat), 0n);
  return {
    period, status: 'available', series,
    summary: { totalEarnedZat: earned.toString(), totalSpentZat: spent.toString(), totalHeldZat: (earned - spent).toString(), overallSellRatio: earned > 0n ? Number(spent * 10000n / earned) / 10000 : 0 },
    coverage: { scope: SCOPE, spendingBasis: 'current_indexed_canonical_spends', freshness: !refreshedAt || Date.parse(refreshedAt) > now + 300000 ? 'unknown' : now - Date.parse(refreshedAt) > 172800000 ? 'stale' : 'current', staleAfterSeconds: 172800, firstDate: series[0].date, lastDate: series.at(-1).date, days: series.length, trackedBlocks, trackedOutputs, refreshedAt },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { unavailable, summarize };
