"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Pool } = require("pg");
const { fetchReconciliationPage, traverse, INGEST_STATUSES } = require("../lib/crosschain/ingest");

const boundary = new Date("2026-07-18T12:00:00.000Z");
const snapshot = new Date("2026-10-12T06:46:09.475Z");
const tokens = new Map([
  ["zec", { blockchain: "zec", symbol: "ZEC" }],
  ["eth", { blockchain: "eth", symbol: "ETH" }],
]);
const row = (id, createdAt, extra = {}) => ({
  depositAddress: id, depositMemo: "", status: "SUCCESS", createdAt,
  originAsset: "zec", destinationAsset: "eth",
  amountInFormatted: "1", amountOutFormatted: "0.01",
  amountInUsd: "100", amountOutUsd: "99", ...extra,
});
const state = () => ({
  cursor_address: "durable-cursor", cursor_memo: "memo", window_end: snapshot, window_start: null,
});
const params = () => ({
  statuses: INGEST_STATUSES.join(","), numberOfTransactions: 100,
  direction: "next", showTestTxs: "false", fromChainId: "zec",
  startTimestamp: undefined, endTimestamp: snapshot.toISOString(),
  lastDepositAddress: "durable-cursor", lastDepositMemo: "memo",
});
function cursorDb(date = boundary) {
  return { query: async (sql, args) => {
    assert.ok(sql.startsWith("SELECT swap_created_at"));
    assert.deepEqual(args, ["durable-cursor", "memo"]);
    return { rows: date ? [{ swap_created_at: date }] : [] };
  } };
}

test("date page overlaps boundary identities without resetting the original snapshot", async () => {
  const originalState = state(), originalParams = params();
  const rows = [row("tie-a", boundary.toISOString()), row("tie-b", boundary.toISOString()),
    row("older", "2026-07-18T11:00:00.000Z")];
  const result = await fetchReconciliationPage(cursorDb(), async (p) => {
    assert.equal(p.numberOfTransactions, 1000);
    assert.equal(p.startTimestamp, "2026-07-17T11:59:59.999Z");
    assert.equal(p.endTimestamp, "2026-07-18T12:00:00.001Z");
    assert.equal(p.lastDepositAddress, undefined);
    assert.equal(p.lastDepositMemo, undefined);
    assert.equal(p.statuses.includes("PENDING_DEPOSIT"), false);
    return rows;
  }, originalState, originalParams);
  assert.deepEqual(result, rows);
  assert.deepEqual(originalState, state());
  assert.deepEqual(originalParams, params());
});

test("same-date pages fall back to the durable identity cursor", async () => {
  const calls = [];
  const nextTie = row("next-tie", boundary.toISOString(), { depositMemo: "next-memo" });
  const result = await fetchReconciliationPage(cursorDb(), async (p) => {
    calls.push(p);
    return calls.length === 1 ? [row("first-tie", boundary.toISOString())] : [nextTie];
  }, state(), params());
  assert.deepEqual(result, [nextTie]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], params());
});

test("empty date windows cannot certify exhaustion and use the original unbounded request", async () => {
  const calls = [];
  const older = row("after-gap", "2026-06-01T00:00:00.000Z");
  const result = await fetchReconciliationPage(cursorDb(), async (p) => {
    calls.push(p);
    return calls.length === 1 ? [] : [older];
  }, state(), params());
  assert.deepEqual(result, [older]);
  assert.equal(calls[1].startTimestamp, undefined);
  assert.equal(calls[1].endTimestamp, snapshot.toISOString());
  assert.equal(calls[1].lastDepositAddress, "durable-cursor");
});

test("missing cursor rows preserve the original unbounded cursor path", async () => {
  let calls = 0;
  assert.deepEqual(await fetchReconciliationPage(cursorDb(null), async (p) => {
    calls++;
    assert.deepEqual(p, params());
    return [];
  }, state(), params()), []);
  assert.equal(calls, 1);
});

test("malformed order and out-of-window dates are rejected before any write or fallback", async () => {
  for (const rows of [
    [row("older", "2026-07-18T10:00:00Z"), row("newer", "2026-07-18T11:00:00Z")],
    [row("too-old", "2026-07-17T11:59:59.998Z")],
    [row("too-new", "2026-07-18T12:00:00.001Z")],
    [row("invalid", "not-a-date")],
  ]) {
    let calls = 0;
    await assert.rejects(fetchReconciliationPage(cursorDb(), async () => {
      calls++;
      return rows;
    }, state(), params()), /date bounds or order/);
    assert.equal(calls, 1);
  }
});

test("unbounded fallback validates ordering and does not move beyond its durable boundary", async () => {
  let calls = 0;
  await assert.rejects(fetchReconciliationPage(cursorDb(), async () => {
    calls++;
    return calls === 1 ? [] : [row("past-cursor", "2026-07-19T00:00:00Z")];
  }, state(), params()), /date bounds or order/);
  assert.equal(calls, 2);
});

test("PostgreSQL: bounded pages resume with overlap, preserve snapshots, and require global exhaustion", {
  skip: process.env.CROSSCHAIN_TEST_POSTGRES !== "1",
}, async () => {
  const name = `crosschain_date_test_${process.pid}_${Date.now()}`;
  const admin = new Pool({ host: "/tmp", database: "postgres", max: 1 });
  let db;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    db = new Pool({ host: "/tmp", database: name, max: 1 });
    await db.query(fs.readFileSync(require.resolve("../scripts/create-crosschain-v2.sql"), "utf8"));
    await db.query(`INSERT INTO crosschain_swaps_v2
      (deposit_address,deposit_memo,status,swap_created_at,source_chain,source_token,dest_chain,dest_token,payload)
      VALUES ('durable-cursor','memo','SUCCESS',$1,'zec','ZEC','eth','ETH','{}'),
      ('retained-quote','','PENDING_DEPOSIT',$1,'zec','ZEC','eth','ETH','{}')`, [boundary]);
    await db.query(`INSERT INTO crosschain_sync_v2(scope,mode,direction,cursor_address,cursor_memo,window_end,pages,records)
      VALUES ('non-pending-v1','reconcile','outflow','durable-cursor','memo',$1,400,40000),
      ('non-pending-v1','backfill','inflow',NULL,NULL,NULL,1227,122689),
      ('non-pending-v1','backfill','outflow',NULL,NULL,NULL,1441,144019)`, [snapshot]);
    await db.query("UPDATE crosschain_sync_v2 SET completed_at=now(),completed_through=$1 WHERE mode='backfill'", [snapshot]);
    const history = (await db.query("SELECT * FROM crosschain_sync_v2 WHERE mode='backfill' ORDER BY direction")).rows;
    const quote = (await db.query("SELECT * FROM crosschain_swaps_v2 WHERE status='PENDING_DEPOSIT'")).rows[0];
    const options = { mode: "reconcile", direction: "outflow", maxPages: 1, reconcileDatePages: true };
    const older = row("older-a", "2026-07-18T11:00:00.000Z");
    let calls = 0;
    const first = await traverse(db, async (p) => {
      calls++;
      assert.equal(p.lastDepositAddress, undefined);
      return [row("durable-cursor", boundary.toISOString(), { depositMemo: "memo" }), older,
        row("ignored-quote", older.createdAt, { status: "PENDING_DEPOSIT" })];
    }, tokens, options);
    assert.deepEqual(first, { complete: false, pages: 1 });
    assert.equal(calls, 1);
    const after = (await db.query("SELECT * FROM crosschain_sync_v2 WHERE mode='reconcile'")).rows[0];
    // Ignored pending rows may be provider cursor identities, but are never written.
    assert.equal(after.cursor_address, "ignored-quote");
    assert.equal(after.window_end.toISOString(), snapshot.toISOString());
    assert.equal(after.completed_at, null);
    assert.equal((await db.query("SELECT count(*) FROM crosschain_coverage_v2")).rows[0].count, "0");
    await db.query("UPDATE crosschain_sync_v2 SET cursor_address='older-a',cursor_memo='' WHERE mode='reconcile'");
    const beforeFailure = (await db.query("SELECT * FROM crosschain_sync_v2 WHERE mode='reconcile'")).rows[0];
    await assert.rejects(traverse(db, async () => [row("bad-date", "2026-08-01T00:00:00Z")], tokens, options), /date bounds or order/);
    assert.deepEqual((await db.query("SELECT * FROM crosschain_sync_v2 WHERE mode='reconcile'")).rows[0], beforeFailure);
    const committedOlder = row("older-b", "2026-07-18T10:00:00.000Z");
    const second = await traverse(db, async (p) => {
      assert.equal(p.endTimestamp, "2026-07-18T11:00:00.001Z");
      return [older, committedOlder];
    }, tokens, options);
    assert.equal(second.complete, false);
    assert.equal((await db.query("SELECT count(*) FROM crosschain_swaps_v2 WHERE status<>'PENDING_DEPOSIT'")).rows[0].count, "3");
    calls = 0;
    const final = await traverse(db, async (p) => {
      calls++;
      if (calls === 1) assert.equal(p.lastDepositAddress, undefined);
      else {
        assert.equal(p.startTimestamp, undefined);
        assert.equal(p.endTimestamp, snapshot.toISOString());
        assert.equal(p.lastDepositAddress, "older-b");
      }
      return [];
    }, tokens, options);
    assert.equal(calls, 2);
    assert.equal(final.complete, true);
    assert.equal((await db.query("SELECT completed_through FROM crosschain_sync_v2 WHERE mode='reconcile'")).rows[0].completed_through.toISOString(), snapshot.toISOString());
    assert.equal((await db.query("SELECT count(*) FROM crosschain_coverage_v2 WHERE window_start IS NULL AND window_end=$1", [snapshot])).rows[0].count, "1");
    assert.deepEqual((await db.query("SELECT * FROM crosschain_sync_v2 WHERE mode='backfill' ORDER BY direction")).rows, history);
    assert.deepEqual((await db.query("SELECT * FROM crosschain_swaps_v2 WHERE status='PENDING_DEPOSIT'")).rows[0], quote);
  } finally {
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
});
