#!/usr/bin/env node
"use strict";
const { loadEnv } = require("../lib/job-utils");
const { performance } = require("node:perf_hooks");
const { getPool } = require("../lib/db-pool");
const { logSafeError } = require("../api/lib/safe-log");
const { loadTokens, explorerClient } = require("../lib/crosschain/ingest");
const { maintain } = require("../lib/crosschain/maintain");

async function main() {
  const clock = () => performance.now();
  // Leave time for transaction cleanup and pool release before systemd's
  // unchanged 90-second deadline. Catalog loading is inside this budget.
  const deadlineAt = clock() + 75000;
  loadEnv(__dirname);
  const args = process.argv.slice(2);
  const pageSize = Number(args.find((s) => s.startsWith("--page-size="))?.split("=")[1] || 100);
  if (args.some((s) => s !== "--apply" && !/^--page-size=\d+$/.test(s)) ||
      !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000)
    throw new Error("Usage: [--apply] [--page-size=1..1000]");
  if (!args.includes("--apply")) {
    console.log(JSON.stringify({ writes: false, pageSize, liveOverlapMinutes: 60,
      livePagesPerDirection: 2, unsettledRefresh: 1, reconciliationPagesPerDirection: 4,
      reconciliationPageSize: 100,
      reconciliationDatePages: true, reconciliationDatePageSize: 1000,
      reconciliationDateWindowHours: 24,
      reconciliationScheduling: "round-robin", batchBudgetMs: 75000, requestAttempts: 1,
      reconciliationIntervalDays: 7 }));
    return;
  }
  if (process.env.NETWORK !== "mainnet" || process.env.CROSSCHAIN_V2_WRITER_ENABLED !== "1" ||
      process.env.NEAR_EXPLORER_SHARED_LIMIT !== "1")
    throw new Error("Requires mainnet writer and shared provider limiter");
  const pool = getPool({ max: 1, statement_timeout: 15000, application_name: "crosschain-v2-maintain" });
  const db = await pool.connect();
  try {
    const identity = (await db.query("SELECT current_database() AS name,pg_is_in_recovery() AS standby")).rows[0];
    if (identity.name !== "zcash_explorer_mainnet" || identity.standby)
      throw new Error("Maintenance requires the primary mainnet database");
    if (!(await db.query("SELECT pg_try_advisory_lock(724092801) AS acquired")).rows[0].acquired) return;
    const result = await maintain(db, explorerClient({
      key: process.env.NEAR_INTENTS_API_KEY, maxAttempts: 1,
      deadlineAt, clock, requestTimeoutMs: 30000,
    }), await loadTokens(), {
      pageSize, reconcileDatePages: true, shouldContinue: () => clock() < deadlineAt,
      log: (progress) => console.log(JSON.stringify(progress)),
    });
    if (result?.yielded) console.log(JSON.stringify({ mode: "maintain", yielded: true }));
  } finally {
    await db.query("SELECT pg_advisory_unlock(724092801)").catch(() => {});
    db.release();
    await pool.end();
  }
}
if (require.main === module) main().catch((err) => {
  logSafeError("Cross-chain maintenance failed; checkpoint retained", err);
  process.exitCode = 1;
});
module.exports = { main };
