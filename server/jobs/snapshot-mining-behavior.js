#!/usr/bin/env node
/**
 * Mining Behavior Snapshot Job
 *
 * Pre-computes daily attributed-payout movement/unspent metrics by checking whether coinbase
 * outputs have been spent (via transaction_inputs.prev_txid lookup).
 *
 * Maintains the mining_behavior_daily table.
 *
 * Modes:
 *   node snapshot-mining-behavior.js              — incremental (last 7 days)
 *   node snapshot-mining-behavior.js --backfill   — explicit full attributed reward history
 *   node snapshot-mining-behavior.js --days=30    — 30 completed UTC reward dates
 *   node snapshot-mining-behavior.js --from=DATE --to=DATE — bounded UTC dates
 *
 * Cron:
 *   0 5 * * * cd /root/cipherscan/server/jobs && node snapshot-mining-behavior.js >> /var/log/mining-behavior.log 2>&1
 */

const { log, loadEnv, withAdvisoryLock } = require('../lib/job-utils');
if (require.main === module) loadEnv(__dirname);

const { getPool, getReadPool } = require('../lib/db-pool');

const pool = require.main === module ? getPool({ max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10000, query_timeout: 11000 }) : null;
// Each day is read under one repeatable-read snapshot, then replaced
// atomically on the writer after checking its canonical source anchor.
const readPool = require.main === module ? getReadPool({ max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000, query_timeout: 11000 }) : null;

const LOCK_ID = 839275;
const { selectDays, parseDay } = require('../lib/utxo-age');
const { setTimeout: pause } = require('node:timers/promises');

// Share the API registry so snapshots cannot retain obsolete pool identities.
const { getPoolName } = require('../api/mining-pools');
function getPoolNameForAddress(address) {
  return getPoolName(address) || 'Other';
}

/**
 * Compute miner behavior for a single date.
 * Uses a join between coinbase outputs and transaction_inputs to detect spends.
 */
async function readDay(reader, dateStr) {
  const dayStart = Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000);
  const dayEnd = dayStart + 86400;

  const result = await reader.query(`
    WITH coinbase_txs AS MATERIALIZED (
      SELECT b.height, b.miner_address, t.txid
      FROM blocks b
      JOIN transactions t ON t.block_height = b.height AND t.block_hash = b.hash AND t.is_coinbase = true
      WHERE b.timestamp >= $1 AND b.timestamp < $2
        AND b.miner_address IS NOT NULL
        AND b.miner_address NOT IN ('t3cFfPt1Bcvgez9ZbMBFWeZsskxTkPzGCow', 't2HifwjUj9uyxr9bknR8LFuQbc98c3vkXtu')
    ),
    all_cb_outputs AS MATERIALIZED (
      SELECT txo.txid, txo.vout_index, txo.value, txo.address
      FROM transaction_outputs txo
      WHERE txo.txid IN (SELECT txid FROM coinbase_txs)
    ),
    day_coinbase AS (
      SELECT ct.height, ct.miner_address, o.txid as coinbase_txid, o.vout_index, o.value
      FROM coinbase_txs ct
      JOIN all_cb_outputs o ON o.txid = ct.txid AND o.address = ct.miner_address AND o.value > 0
    ),
    observed AS MATERIALIZED (
      SELECT dc.*, EXISTS (
        SELECT 1 FROM transaction_inputs ti
        JOIN transactions spending ON spending.txid=ti.txid
        JOIN blocks spending_block ON spending_block.height=spending.block_height AND spending_block.hash=spending.block_hash
        WHERE ti.prev_txid=dc.coinbase_txid AND ti.prev_vout=dc.vout_index
      ) AS is_spent
      FROM day_coinbase dc
    )
    SELECT miner_address, COUNT(*) as output_count, COUNT(DISTINCT height)::int as blocks,
      SUM(value) as total_earned,
      SUM(CASE WHEN is_spent THEN value ELSE 0 END) as total_spent,
      SUM(CASE WHEN is_spent THEN 1 ELSE 0 END) as spent_count
    FROM observed GROUP BY miner_address
  `, [dayStart, dayEnd]);

  const poolAgg = {};
  for (const row of result.rows) {
    const poolName = getPoolNameForAddress(row.miner_address);
    if (!poolAgg[poolName]) {
      poolAgg[poolName] = {
        address: row.miner_address,
        earned: 0n,
        spent: 0n,
        blocks: 0,
        outputsSpent: 0,
        outputsTotal: 0,
      };
    }
    const entry = poolAgg[poolName];
    entry.earned += BigInt(row.total_earned || 0);
    entry.spent += BigInt(row.total_spent || 0);
    entry.blocks += parseInt(row.blocks || 0);
    entry.outputsSpent += parseInt(row.spent_count || 0);
    entry.outputsTotal += parseInt(row.output_count || 0);
  }

  return poolAgg;
}

async function writeDay(client, dateStr, poolAgg) {
  await client.query('DELETE FROM mining_behavior_daily WHERE date = $1', [dateStr]);

  for (const [poolName, data] of Object.entries(poolAgg)) {
    const held = data.earned - data.spent;
    await client.query(`
      INSERT INTO mining_behavior_daily
        (date, pool_name, miner_address, earned_zat, spent_zat, held_zat, blocks_mined, outputs_spent, outputs_total)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      dateStr,
      poolName,
      data.address,
      data.earned.toString(),
      data.spent.toString(),
      held.toString(),
      data.blocks,
      data.outputsSpent,
      data.outputsTotal,
    ]);
  }

  return Object.keys(poolAgg).length;
}

async function computeDay(client, dateStr, reader = readPool) {
  return writeDay(client, dateStr, await readDay(reader, dateStr));
}

async function processDates(client, readers, dates, { network = 'mainnet', pauseMs = 100, continueOnError = false } = {}) {
  const expectedGenesis = {
    mainnet: '00040fe8ec8471911baa1db1266ea15dd06b4a8a5c453883c000b031973dce08',
    testnet: '05a60a92d99d85997cce3b87616c089f6124d7342af37106edc76126334a2c38',
  }[network];
  if (!expectedGenesis) throw new Error('Unsupported mining snapshot network');
  const guard = (await client.query('SELECT current_database() AS database, pg_is_in_recovery() AS recovery, (SELECT hash FROM blocks WHERE height=0) AS genesis')).rows[0];
  if (guard?.recovery !== false || guard.genesis !== expectedGenesis || (network === 'testnet' && guard.database !== 'zcash_explorer_testnet')) throw new Error('Mining snapshot database/network mismatch');
  let processed = 0;
  const failedDates = [];
  for (const date of dates) {
    try {
      await processDate(client, readers, date);
      processed++;
    } catch (error) {
      if (!continueOnError) throw error;
      failedDates.push(date);
      log(`ERROR: snapshot ${date} unavailable`);
    }
    await pause(pauseMs);
  }
  return { processed, failedDates };
}

async function processDate(client, readers, date) {
    const reader = await readers.connect();
    let anchor, data;
    try {
      await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await reader.query("SET LOCAL statement_timeout='10s'; SET LOCAL work_mem='16MB'; SET LOCAL max_parallel_workers_per_gather=0; SET LOCAL TIME ZONE 'UTC'");
      anchor = (await reader.query('SELECT height,hash,timestamp FROM blocks ORDER BY height DESC LIMIT 1')).rows[0];
      if (!anchor || Number(anchor.timestamp) < Date.parse(date+'T00:00:00Z')/1000+86400) throw new Error('Incomplete source day');
      const counts = (await reader.query(`
        SELECT COUNT(*)::int AS blocks, COUNT(*) FILTER (WHERE cb.n <> 1)::int AS incomplete_coinbases
        FROM blocks b CROSS JOIN LATERAL (
          SELECT COUNT(*)::int n FROM transactions t
          WHERE t.block_hash=b.hash AND t.block_height=b.height AND t.is_coinbase=true
        ) cb WHERE b.timestamp >= $1 AND b.timestamp < $2
      `, [Date.parse(date+'T00:00:00Z')/1000, Date.parse(date+'T00:00:00Z')/1000+86400])).rows[0];
      if (!counts || counts.incomplete_coinbases !== 0) throw new Error('Incomplete canonical coinbase source');
      data = await readDay(reader, date);
      for (const row of Object.values(data)) {
        if (row.earned < 0n || row.spent < 0n || row.spent > row.earned) throw new Error('Invalid mining snapshot accounting');
      }
      await reader.query('COMMIT');
    } catch (error) { await reader.query('ROLLBACK'); throw error; }
    finally { reader.release(); }
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'; SET LOCAL TIME ZONE 'UTC'");
      if (!(await client.query('SELECT 1 FROM blocks WHERE height=$1 AND hash=$2', [anchor.height,anchor.hash])).rowCount) throw new Error('Source chain changed');
      const pools = await writeDay(client,date,data);
      if (!(await client.query('SELECT 1 FROM blocks WHERE height=$1 AND hash=$2', [anchor.height,anchor.hash])).rowCount) throw new Error('Source chain changed');
      await client.query('COMMIT');
      log(`Completed ${date}: ${pools} tracked payout groups`);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
}

function selectSnapshotDates(args, now = new Date(), earliest = null) {
  if (!args.includes('--backfill')) return selectDays(args, now);
  if (args.length !== 1) throw new Error('--backfill cannot be combined with bounded date options');
  if (earliest === null) return [];
  const first = parseDay(earliest), last = Math.floor(now.getTime()/86400000)-1;
  return Array.from({length:Math.max(0,last-first+1)},(_,i)=>new Date((first+i)*86400000).toISOString().slice(0,10));
}

async function run() {
  const client = await pool.connect();
  try {
    // Existing mainnet cron defaults to seven completed days. Testnet's scoped
    // unit explicitly refreshes 30 days; no genesis reconstruction is implicit.
    const args = process.argv.slice(2);
    const earliest = args.includes('--backfill')
      ? (await readPool.query("SELECT MIN((to_timestamp(timestamp) AT TIME ZONE 'UTC')::date)::text AS date FROM blocks WHERE miner_address IS NOT NULL")).rows[0]?.date ?? null
      : null;
    const dates = selectSnapshotDates(args, new Date(), earliest);
    const network = process.env.NETWORK || 'mainnet';
    await withAdvisoryLock(client, LOCK_ID, async () => {
      const result = await processDates(client, readPool, network === 'testnet' ? dates.reverse() : dates, { network, continueOnError: network === 'testnet' });
      if (result.failedDates.length) process.exitCode = 1;
      log(`Finished: ${result.processed} dates refreshed, ${result.failedDates.length} unavailable`);
    });
  } catch (error) {
    log('ERROR: mining behavior snapshot failed');
    console.error(error.code || 'snapshot_failed');
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
    if (readPool !== pool) await readPool.end();
  }
}

if (require.main === module) run();
module.exports = { computeDay, readDay, writeDay, processDates, selectSnapshotDates };
