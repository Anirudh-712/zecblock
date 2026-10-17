'use strict';

const { networkSchedule } = require('../api/lib/network-schedule');
const { CANDIDATES_SQL } = require('./subsidy-allocation-maintenance');

const MAX_AGE_MS = 5 * 60_000;
const GAP_GRACE_BLOCKS = 24;

async function checkAllocationHealth({ pool, rpc, network, state, systemd, now = Date.now() }) {
  const health = { version: 1, network, checkedAt: new Date(now).toISOString(), status: 'unhealthy', reason: '' };
  const fail = reason => ({ ...health, reason });
  const chain = { mainnet: 'main', testnet: 'test' }[network];
  if (!chain) return fail('network_unconfigured');
  if (systemd?.timerActive !== 'active' || systemd?.timerEnabled !== 'enabled') return fail('timer_inactive');
  if (systemd.serviceResult !== 'success') return fail('job_failed');
  if (!state || state.network !== network || state.version !== 1
    || !['running', 'complete', 'budget', 'inactive', 'busy', 'degraded', 'error'].includes(state.status)) return fail('state_unavailable');
  for (const [field, label] of [['lastFinished', 'completion'], ['lastSuccess', 'success']]) {
    const timestamp = Date.parse(state[field]);
    if (!Number.isFinite(timestamp) || timestamp > now + 30_000 || now - timestamp > MAX_AGE_MS) {
      return fail(`job_${label}_stale`);
    }
  }
  if (['error', 'degraded'].includes(state.status)) return fail('job_failed');
  if (state.status === 'running' && (!Number.isFinite(Date.parse(state.lastAttempt)) || now - Date.parse(state.lastAttempt) > 75_000)) {
    return fail('job_hung');
  }
  try {
    const recovery = await pool.query('SELECT pg_is_in_recovery() AS recovery');
    if (recovery.rows[0]?.recovery !== false) return fail('database_passive');
    const info = await rpc('getblockchaininfo', [], { timeout: 8000 });
    if (info?.chain !== chain) return fail('network_mismatch');
    const schedule = networkSchedule(info);
    if (!schedule || !Number.isSafeInteger(info.blocks) || info.blocks < 0 || info.blocks > 499999999) {
      return fail('schedule_unavailable');
    }
    const genesis = await pool.query('SELECT hash FROM public.blocks WHERE height=0');
    const hash = genesis.rows[0]?.hash;
    if (!/^[0-9a-f]{64}$/.test(hash ?? '') || await rpc('getblockhash', [0], { timeout: 8000 }) !== hash) {
      return fail('genesis_mismatch');
    }
    const anchor = (await pool.query('SELECT height, hash FROM public.blocks WHERE height <= $1 ORDER BY height DESC LIMIT 1', [info.blocks])).rows[0];
    const anchorHeight = Number(anchor?.height);
    if (!Number.isSafeInteger(anchorHeight) || anchorHeight < 0 || anchorHeight > info.blocks
      || (info.blocks > 0 && anchorHeight === 0) || !/^[0-9a-f]{64}$/.test(anchor?.hash ?? '')) return fail('anchor_unavailable');
    if (schedule.nu7Height !== null && info.blocks - GAP_GRACE_BLOCKS >= schedule.nu7Height) {
      const missing = await pool.query(CANDIDATES_SQL, [schedule.nu7Height, info.blocks - GAP_GRACE_BLOCKS, chain, 1, []]);
      if (missing.rows.length) {
        const height = Number(missing.rows[0].height);
        return { ...fail('allocation_gap'), ...(Number.isSafeInteger(height) && height >= 0 ? { missingHeight: height } : {}) };
      }
    }
    const currentAnchor = (await pool.query('SELECT hash FROM public.blocks WHERE height=$1', [anchorHeight])).rows[0]?.hash;
    if (currentAnchor !== anchor.hash) return fail('anchor_changed');
    try {
      if (await rpc('getblockhash', [anchorHeight], { timeout: 8000 }) !== anchor.hash) return fail('anchor_mismatch');
    } catch { return fail('anchor_unavailable'); }
    return { ...health, status: 'healthy', reason: 'ok' };
  } catch {
    return fail('coverage_unavailable');
  }
}

module.exports = { MAX_AGE_MS, GAP_GRACE_BLOCKS, checkAllocationHealth };
