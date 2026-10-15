"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Pool } = require("pg");
const {
  INGEST_SCOPE,
  INGEST_STATUSES,
  transform,
  upsert,
  traverse,
  explorerClient,
  refreshUnsettled,
} = require("../lib/crosschain/ingest");
const {
  readAnalytics,
  readSwaps,
  parseFilters,
} = require("../lib/crosschain/analytics");
const tokens = new Map([
  ["zec", { blockchain: "zec", symbol: "ZEC" }],
  ["eth", { blockchain: "eth", symbol: "ETH" }],
]);
const { maintain } = require("../lib/crosschain/maintain");
const tx = (id, extra = {}) => ({
  depositAddress: id,
  depositMemo: null,
  status: "SUCCESS",
  createdAt: "2026-09-20T12:00:00.000Z",
  originAsset: "eth",
  destinationAsset: "zec",
  amountInFormatted: "0.01",
  amountOutFormatted: "1.23456789",
  amountInUsd: "100",
  amountOutUsd: "99",
  amountIn: "10000000000000000",
  amountOut: "123456789",
  originChainTxHashes: ["source-" + id],
  destinationChainTxHashes: ["zec-" + id],
  senders: ["same"],
  nearTxHashes: ["near-" + id],
  ...extra,
});

test("strict statuses, exact amounts and hidden in-flight values", () => {
  assert.equal(transform(tx("a"), tokens)[9], "1.23456789");
  assert.equal(
    transform(
      tx("a", { status: "PROCESSING", amountOutFormatted: "0" }),
      tokens,
    )[9],
    null,
  );
  assert.throws(
    () => transform(tx("a", { status: "NEW_STATUS" }), tokens),
    /Invalid/,
  );
  assert.throws(() => parseFilters({ period: "7d", status: "nope" }));
  assert.throws(() => parseFilters({ period: "all", granularity: "hour" }));
  assert.throws(() => parseFilters({ period: "constructor" }));
  assert.throws(() => parseFilters({ minUsd: "20", maxUsd: "10" }));
  assert.throws(() => parseFilters({ chain: ["eth", "sol"] }));
  assert.throws(() => parseFilters({ token: ["ZEC", "BTC"] }));
  assert.throws(() => parseFilters({ search: { length: 1 } }));
  assert.throws(() => parseFilters({ from: "2026-02-30T00:00:00Z" }));
  assert.throws(() => parseFilters({ from: "2026-09-01T99:00:00Z" }));
  assert.equal(
    parseFilters({ from: "2026-09-01T00:00:00.123Z" }).from,
    "2026-09-01T00:00:00.123Z",
  );
});
test("pending quotes never reach the database write path", async () => {
  const db = { query: async () => { throw Error("unexpected write"); } };
  assert.equal(await upsert(db, tx("quote", { status: "PENDING_DEPOSIT" }), tokens), false);
  assert.deepEqual(INGEST_STATUSES, ["SUCCESS", "FAILED", "REFUNDED", "PROCESSING", "INCOMPLETE_DEPOSIT"]);
});

test("PostgreSQL: maintenance closes an old snapshot gap and preserves completed sweeps", {
  skip: process.env.CROSSCHAIN_TEST_POSTGRES !== "1",
}, async () => {
  const name = `crosschain_maintain_test_${process.pid}_${Date.now()}`;
  const admin = new Pool({ host: "/tmp", database: "postgres", max: 1 });
  let db;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    db = new Pool({ host: "/tmp", database: name, max: 1 });
    await db.query(fs.readFileSync(require.resolve("../scripts/create-crosschain-v2.sql"), "utf8"));
    await assert.rejects(maintain(db, () => { throw Error("unexpected request"); }, tokens), /historical/);
    await db.query(`INSERT INTO crosschain_sync_v2(scope,mode,direction,completed_at,completed_through,pages)
      VALUES ('non-pending-v1','backfill','inflow','2026-10-10T00:00:00Z','2026-10-06T00:00:00Z',1227),
      ('non-pending-v1','backfill','outflow','2026-10-11T00:00:00Z','2026-10-06T00:00:00Z',1441)`);
    const history = (await db.query("SELECT * FROM crosschain_sync_v2 ORDER BY direction")).rows;
    const now = new Date("2026-10-15T00:00:00Z");
    let fullRequests = 0;
    const request = async (p) => {
      assert.equal(p.numberOfTransactions, p.startTimestamp ? 1000 : 100);
      assert.equal(p.statuses.includes("PENDING_DEPOSIT"), false);
      const direction = p.toChainId ? "inflow" : "outflow";
      if (p.startTimestamp) {
        // Bootstrap from the completed historical anchor, even after >7 days.
        assert.equal(p.startTimestamp, "2026-10-05T22:59:59.999Z");
        return p.lastDepositAddress ? [] : [tx(direction, { createdAt: "2026-10-08T00:00:00Z" }), tx(direction + "-quote", { status: "PENDING_DEPOSIT" })];
      }
      fullRequests++;
      // Keep reconciliation partial through the first four-page batch.
      return [tx("old-" + direction + "-" + fullRequests)];
    };
    await maintain(db, request, tokens, { now, pageSize: 1000 });
    assert.equal(fullRequests, 8);
    assert.equal((await db.query("SELECT count(*) FROM crosschain_swaps_v2 WHERE status='PENDING_DEPOSIT'")).rows[0].count, "0");
    // Live catch-up completed; next window overlaps one hour, not nine days.
    const next = async (p) => {
      if (p.startTimestamp) {
        assert.equal(p.startTimestamp, "2026-10-14T22:59:59.999Z");
        return [];
      }
      fullRequests++;
      assert.ok(p.lastDepositAddress.startsWith("old-"));
      return [];
    };
    await maintain(db, next, tokens, { now: new Date("2026-10-15T00:05:00Z"), pageSize: 1000 });
    const reconciled = (await db.query("SELECT * FROM crosschain_sync_v2 WHERE mode='reconcile' ORDER BY direction")).rows;
    assert.ok(reconciled.every((r) => r.completed_at));
    await maintain(db, async (p) => { assert.ok(p.startTimestamp); return []; }, tokens,
      { now: new Date("2026-10-15T00:10:00Z"), pageSize: 1000 });
    assert.equal(fullRequests, 10);
    assert.deepEqual((await db.query("SELECT * FROM crosschain_sync_v2 WHERE mode='reconcile' ORDER BY direction")).rows, reconciled);
    assert.deepEqual((await db.query("SELECT * FROM crosschain_sync_v2 WHERE mode='backfill' ORDER BY direction")).rows, history);
    const spans = (await db.query(`SELECT direction,range_agg(tstzrange(window_start,window_end,'[)'))::text AS spans
      FROM crosschain_coverage_v2 WHERE scope='non-pending-v1' GROUP BY direction`)).rows;
    assert.ok(spans.every((r) => r.spans.startsWith('{(,')));
  } finally {
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
});

test("PostgreSQL: filtered scope preserves old checkpoints and excludes pending quotes in every ingestion mode", {
  skip: process.env.CROSSCHAIN_TEST_POSTGRES !== "1",
}, async () => {
  const name = `crosschain_scope_test_${process.pid}_${Date.now()}`;
  const admin = new Pool({ host: "/tmp", database: "postgres", max: 1 });
  let db;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    db = new Pool({ host: "/tmp", database: name, max: 1 });
    // Exercise the migration against the pre-policy schema, not just a new DB.
    const schema = fs.readFileSync(require.resolve("../scripts/create-crosschain-v2.sql"), "utf8")
      .replaceAll("  scope text NOT NULL DEFAULT 'all-statuses-v1',\n", "")
      .replaceAll("PRIMARY KEY (scope, ", "PRIMARY KEY (");
    await db.query(schema);
    await db.query(`INSERT INTO crosschain_sync_v2(mode,direction,cursor_address,window_end,pages)
      VALUES ('backfill','inflow','old-quote','2026-09-29',2171);
      INSERT INTO crosschain_coverage_v2(direction,window_end) VALUES ('inflow','2026-09-29'),('outflow','2026-09-29');
      CREATE TABLE transactions(txid text PRIMARY KEY,block_time bigint)`);
    const migration = fs.readFileSync(require.resolve("../scripts/scope-crosschain-v2.sql"), "utf8");
    await db.query(migration);
    await db.query(migration); // safe to reapply
    // Retained old quote must not leak into analytics or get re-polled.
    await db.query(`INSERT INTO crosschain_swaps_v2
      (deposit_address,status,swap_created_at,source_chain,source_token,dest_chain,dest_token,payload)
      VALUES ('retained-quote','PENDING_DEPOSIT','2026-09-20','eth','ETH','zec','ZEC','{}')`);
    const before = await readAnalytics(db, { period: "all" }, { v2: true, now: new Date("2026-09-30") });
    assert.equal(before.coverage.ingestionScope, INGEST_SCOPE);
    assert.equal(before.coverage.records, 0);
    assert.equal(before.coverage.continuousThrough, null);
    assert.equal(before.coverage.historyTraversalComplete, false);
    assert.deepEqual(before.coverage.statusesAvailable, INGEST_STATUSES);
    assert.deepEqual(before.coverage.excludedStatuses, ["PENDING_DEPOSIT"]);
    assert.equal((await readSwaps(db, { period: "all", status: "PENDING_DEPOSIT" }, { v2: true, now: new Date("2026-09-30") })).swaps.length, 0);
    for (const mode of ["backfill", "sync", "reconcile"]) {
      let calls = 0;
      const request = async (params) => {
        assert.equal(params.statuses, INGEST_STATUSES.join(","));
        assert.equal(params.numberOfTransactions, 100);
        if (calls++ === 0) {
          assert.equal(params.lastDepositAddress, null); // old scope cannot skip data
          return [tx(mode), tx(mode + "-quote", { status: "PENDING_DEPOSIT" })];
        }
        assert.equal(params.lastDepositAddress, mode + "-quote");
        return [];
      };
      await traverse(db, request, tokens, { mode, direction: "inflow", maxPages: 2, now: new Date("2026-09-30") });
    }
    assert.equal((await db.query("SELECT count(*) FROM crosschain_swaps_v2 WHERE status='PENDING_DEPOSIT'")).rows[0].count, "1");
    const old = (await db.query("SELECT * FROM crosschain_sync_v2 WHERE scope='all-statuses-v1'")).rows[0];
    assert.equal(old.pages, "2171");
    assert.equal(old.cursor_address, "old-quote");
    assert.equal((await db.query("SELECT count(*) FROM crosschain_coverage_v2 WHERE scope='all-statuses-v1'")).rows[0].count, "2");
    await upsert(db, tx("active", { status: "PROCESSING" }), tokens);
    await refreshUnsettled(db, async (params) => {
      assert.equal(params.search, "active");
      assert.equal(params.statuses, INGEST_STATUSES.join(","));
      return [tx("active", { status: "PENDING_DEPOSIT" })];
    }, tokens);
    assert.equal((await db.query("SELECT status FROM crosschain_swaps_v2 WHERE deposit_address='active'")).rows[0].status, "PROCESSING");
    // A previously excluded quote can later enter the index as a real swap.
    await upsert(db, tx("backfill-quote"), tokens);
    assert.equal((await db.query("SELECT status FROM crosschain_swaps_v2 WHERE deposit_address='backfill-quote'")).rows[0].status, "SUCCESS");
  } finally {
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
});
test("rate limiter bounds retries and respects Retry-After without leaking auth", async () => {
  const waits = [];
  let calls = 0;
  let time = 0;
  const request = explorerClient({
    key: "not-logged",
    now: () => time,
    wait: async (ms) => {
      waits.push(ms);
      time += ms;
    },
    fetchImpl: async () => {
      calls++;
      return { status: 429, headers: new Headers({ "retry-after": "12" }) };
    },
  });
  await assert.rejects(request({}), /checkpoint preserved/);
  assert.equal(calls, 5);
  assert.ok(waits.includes(12000));
  let cooldownCalls = 0;
  const cooldown = explorerClient({
    key: "not-logged",
    wait: async () => {},
    fetchImpl: async () => {
      cooldownCalls++;
      return { status: 429, headers: new Headers({ "retry-after": "120" }) };
    },
  });
  await assert.rejects(cooldown({}), /long cooldown/);
  assert.equal(cooldownCalls, 1);
});

test(
  "PostgreSQL: resumable ingestion, identity, status changes, accurate analytics and pagination",
  { skip: process.env.CROSSCHAIN_TEST_POSTGRES !== "1" },
  async () => {
    const name = `crosschain_test_${process.pid}_${Date.now()}`;
    const admin = new Pool({ host: "/tmp", database: "postgres", max: 1 });
    let db;
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      db = new Pool({
        host: "/tmp",
        database: name,
        max: 2,
        options: "-c timezone=Asia/Tokyo",
      });
      await db.query(
        fs.readFileSync(
          require.resolve("../scripts/create-crosschain-v2.sql"),
          "utf8",
        ),
      );
      await db.query(
        "CREATE TABLE transactions(txid text PRIMARY KEY,block_time bigint)",
      );
      const client = await db.connect();
      try {
        await upsert(client, tx("same", { depositMemo: "1" }), tokens);
        await upsert(
          client,
          tx("same", {
            depositMemo: "2",
            status: "PROCESSING",
            amountOutFormatted: "0",
          }),
          tokens,
        );
        assert.equal(
          (await client.query("SELECT count(*) FROM crosschain_swaps_v2"))
            .rows[0].count,
          "2",
        );
        await upsert(
          client,
          tx("same", {
            depositMemo: "2",
            amountOutFormatted: "2",
            amountInUsd: "200",
          }),
          tokens,
        );
        assert.equal(
          (
            await client.query(
              "SELECT dest_amount FROM crosschain_swaps_v2 WHERE deposit_memo='2'",
            )
          ).rows[0].dest_amount,
          "2",
        );
        const page = tx("older", {
          createdAt: "2025-01-01T00:00:00Z",
          amountInUsd: "50",
        });
        let requests = [];
        let result = await traverse(
          client,
          async (p) => {
            requests.push(p);
            return [page];
          },
          tokens,
          {
            mode: "backfill",
            direction: "inflow",
            maxPages: 1,
            now: new Date("2026-09-28"),
          },
        );
        assert.equal(result.complete, false);
        assert.equal(requests[0].statuses, INGEST_STATUSES.join(","));
        assert.ok(!requests[0].statuses.includes("PENDING_DEPOSIT"));
        assert.equal(requests[0].startTimestamp, undefined); // no 84-day bound
        result = await traverse(
          client,
          async (p) => {
            assert.equal(p.lastDepositAddress, "older");
            assert.equal(p.lastDepositMemo, undefined);
            return [];
          },
          tokens,
          { mode: "backfill", direction: "inflow", maxPages: 1 },
        );
        assert.equal(result.complete, true);
        const before = (
          await client.query(
            "SELECT pages FROM crosschain_sync_v2 WHERE mode='backfill'",
          )
        ).rows[0].pages;
        await traverse(
          client,
          async () => {
            throw Error("must not refetch completed backfill");
          },
          tokens,
          { mode: "backfill", direction: "inflow" },
        );
        assert.equal(
          (
            await client.query(
              "SELECT pages FROM crosschain_sync_v2 WHERE mode='backfill'",
            )
          ).rows[0].pages,
          before,
        );
        await traverse(
          client,
          async () => [tx("memo-page", { depositMemo: "42" })],
          tokens,
          {
            mode: "reconcile",
            direction: "inflow",
            maxPages: 1,
            now: new Date("2026-09-27T00:00:00Z"),
          },
        );
        await traverse(
          client,
          async (p) => {
            assert.equal(p.lastDepositAddress, "memo-page");
            assert.equal(p.lastDepositMemo, "42");
            return [];
          },
          tokens,
          {
            mode: "reconcile",
            direction: "inflow",
            maxPages: 1,
            now: new Date("2026-09-27T00:00:00Z"),
          },
        );
        await client.query(
          "DELETE FROM crosschain_swaps_v2 WHERE deposit_address='memo-page'",
        );
        await client.query(
          "DELETE FROM crosschain_sync_v2 WHERE mode='reconcile'",
        );
        await client.query(
          "DELETE FROM crosschain_coverage_v2 WHERE direction='inflow' AND window_end = '2026-09-27T00:00:00Z'",
        );

        await assert.rejects(
          traverse(
            client,
            async () => [tx("bad", { status: "NEW_STATUS" })],
            tokens,
            { mode: "backfill", direction: "outflow", maxPages: 1 },
          ),
          /Invalid/,
        );
        assert.equal(
          (
            await client.query(
              "SELECT cursor_address FROM crosschain_sync_v2 WHERE direction='outflow'",
            )
          ).rows[0].cursor_address,
          null,
        );
        await traverse(client, async () => [tx("repeat")], tokens, {
          mode: "backfill",
          direction: "outflow",
          maxPages: 1,
        });
        await assert.rejects(
          traverse(client, async () => [tx("repeat")], tokens, {
            mode: "backfill",
            direction: "outflow",
            maxPages: 1,
          }),
          /did not advance/,
        );
        await client.query(
          "DELETE FROM crosschain_swaps_v2 WHERE deposit_address='repeat'",
        );
        await upsert(
          client,
          tx("out", {
            originAsset: "zec",
            destinationAsset: "eth",
            amountInFormatted: "3",
            amountInUsd: "300",
          }),
          tokens,
        );
        await upsert(
          client,
          tx("self", {
            originAsset: "zec",
            destinationAsset: "zec",
            amountInUsd: "9999",
          }),
          tokens,
        );
        await upsert(client, tx("refund", { status: "REFUNDED" }), tokens);
        await upsert(client, tx("pending", { status: "PROCESSING" }), tokens);
        await refreshUnsettled(
          client,
          async () => [tx("pending", { status: "FAILED" })],
          tokens,
        );
        assert.equal(
          (
            await client.query(
              "SELECT status FROM crosschain_swaps_v2 WHERE deposit_address='pending'",
            )
          ).rows[0].status,
          "FAILED",
        );
        await client.query(
          "INSERT INTO transactions VALUES ('zec-same',179? )".replace(
            "179?",
            "" + Math.floor(new Date("2026-09-20T12:10:00Z").getTime() / 1000),
          ),
        );
      } finally {
        client.release();
      }
      const now = new Date("2026-09-28T00:00:00Z");
      await assert.rejects(
        readSwaps(
          db,
          { cursor: Buffer.from("null").toString("base64url") },
          { v2: true, now },
        ),
        /match filters/,
      );

      const data = await readAnalytics(
        db,
        { period: "30d" },
        { v2: true, now },
      );
      assert.equal(data.summary.swaps, 3);
      assert.equal(data.summary.volume_usd, "600");
      assert.equal(Number(data.summary.average_usd), 200);
      assert.equal(data.flows.length, 1);
      assert.equal(data.flows[0].chain, "eth");
      assert.equal(data.flows[0].swaps, 3);
      assert.equal(data.flows[0].buy_swaps, 2);
      assert.equal(data.flows[0].sell_swaps, 1);
      assert.equal(data.flows[0].inflow_usd, "300");
      assert.equal(data.flows[0].outflow_usd, "300");
      assert.equal(data.flows[0].inflow_zec, "3.23456789");
      assert.equal(data.flows[0].outflow_zec, "3");
      assert.equal(data.summary.volume_zec, "6.23456789");
      assert.equal(data.tokenFlows.length, 1);
      assert.equal(data.tokenFlows[0].chain, "eth");
      assert.equal(data.tokenFlows[0].token, "ETH");
      assert.equal(data.tokenFlows[0].swaps, 3);
      assert.equal(data.tokenFlows[0].inflow_zec, "3.23456789");
      assert.deepEqual(data.chainHistory, [
        {
          bucket: "2026-09-14T00:00:00.000Z",
          chain: "eth",
          swaps: 3,
          missing_zec: 0,
          net_zec: "0.23456789",
        },
      ]);
      assert.equal(
        data.chainOutcomes.reduce((n, r) => n + r.count, 0),
        5,
      );
      assert.equal(
        data.chainOutcomes.find(
          (r) => r.chain === "eth" && r.status === "REFUNDED",
        ).count,
        1,
      );
      assert.equal(
        data.chainOutcomes.find(
          (r) => r.chain === "eth" && r.status === "FAILED",
        ).count,
        1,
      );
      assert.equal(data.summary.sender_addresses, 2); // same address on two chains
      assert.equal(
        data.distribution.reduce((n, b) => n + b.swaps, 0),
        3,
      );
      assert.equal(data.coverage.internalSwaps, 1);
      assert.equal(data.coverage.historyTraversalComplete, false);
      assert.equal(
        data.trends.find((x) => x.bucket === "2026-09-20T00:00:00.000Z").swaps,
        3,
      );
      assert.equal(
        data.trends.find((x) => x.bucket === "2026-09-21T00:00:00.000Z").swaps,
        null,
      );
      assert.equal(data.latency[0].median_minutes, 10);
      assert.equal(data.statuses.find((s) => s.status === "FAILED").count, 1);
      const first = await readSwaps(
        db,
        { period: "all", limit: "2" },
        { v2: true, now },
      );
      const second = await readSwaps(
        db,
        { period: "all", limit: "2", cursor: first.nextCursor },
        { v2: true, now: new Date("2026-09-29") },
      );
      assert.equal(
        new Set([...first.swaps, ...second.swaps].map((s) => s.id)).size,
        4,
      );
      await assert.rejects(
        readSwaps(
          db,
          { period: "7d", cursor: first.nextCursor },
          { v2: true, now },
        ),
        /match filters/,
      );
      const filtered = await readSwaps(
        db,
        { period: "all", status: "SUCCESS", chain: "eth", minUsd: "150" },
        { v2: true, now },
      );
      assert.equal(filtered.swaps.length, 2);
      assert.equal(
        (
          await readSwaps(
            db,
            { period: "all", search: "source-out" },
            { v2: true, now },
          )
        ).swaps.length,
        1,
      );
      const exactRoute = await readSwaps(
        db,
        { period: "all", sourceAsset: "zec", destAsset: "eth" },
        { v2: true, now },
      );
      assert.deepEqual(
        exactRoute.swaps.map((s) => s.depositAddress),
        ["out"],
      );
      const nearHash = await readSwaps(
        db,
        { period: "all", search: "near-out" },
        { v2: true, now },
      );
      assert.equal(nearHash.swaps[0].depositAddress, "out");
      assert.equal(
        (
          await readSwaps(
            db,
            { period: "all", referral: "nonexistent" },
            { v2: true, now },
          )
        ).swaps.length,
        0,
      );
      // A completed historic traversal and a fresh sync must not conceal a gap between their windows.
      await db.query(
        "INSERT INTO crosschain_coverage_v2(direction,window_start,window_end,scope) VALUES ('outflow',NULL,'2026-09-01T00:00:00Z','non-pending-v1'),('inflow','2026-09-21T00:00:00Z','2026-09-28T00:00:00Z','non-pending-v1'),('outflow','2026-09-21T00:00:00Z','2026-09-28T00:00:00Z','non-pending-v1') ON CONFLICT DO NOTHING",
      );
      const gap = await readAnalytics(db, { period: "30d" }, { v2: true, now });
      assert.equal(gap.coverage.continuousThrough, "2026-09-01T00:00:00.000Z");
      await db.query(
        "INSERT INTO crosschain_coverage_v2(direction,window_start,window_end,scope) VALUES ('outflow','2026-09-01T00:00:00Z','2026-09-21T00:00:00Z','non-pending-v1')",
      );
      const joined = await readAnalytics(
        db,
        { period: "30d" },
        { v2: true, now },
      );
      assert.equal(
        joined.coverage.continuousThrough,
        "2026-09-28T00:00:00.000Z",
      );
      await db.query(
        "UPDATE crosschain_sync_v2 SET completed_at=now() WHERE mode='backfill'",
      );
      await db.query(
        "INSERT INTO crosschain_sync_v2(mode,direction,completed_at,completed_through,scope) VALUES ('sync','inflow',now(),'2026-09-28T00:00:00Z','non-pending-v1'),('sync','outflow',now(),'2026-09-28T00:00:00Z','non-pending-v1') ON CONFLICT (scope,mode,direction) DO UPDATE SET completed_through=EXCLUDED.completed_through",
      );
      const complete = await readAnalytics(
        db,
        { period: "30d" },
        { v2: true, now },
      );
      assert.equal(
        complete.trends.find((t) => t.bucket === "2026-09-21T00:00:00.000Z")
          .swaps,
        0,
      );
      assert.equal(complete.trends.at(-1).swaps, null); // current partial bucket
      // Compatibility source has no v2 dependency. Read all six data features from existing columns.
      await db.query(`CREATE TABLE cross_chain_swaps AS SELECT deposit_address,'inflow'::text AS direction,status,swap_created_at,
      source_chain,source_token,dest_chain,dest_token,source_amount,dest_amount,source_amount_usd,dest_amount_usd,
      ARRAY['src']::text[] AS source_tx_hashes,ARRAY['zec-same']::text[] AS dest_tx_hashes,ARRAY['same']::text[] AS senders,
      'eth'::text AS raw_origin_asset,'zec'::text AS raw_dest_asset,ARRAY[]::text[] AS near_tx_hashes,NULL::text AS recipient
      FROM crosschain_swaps_v2 WHERE status='SUCCESS';
      CREATE TABLE sync_state(job_name text,last_sync_timestamp timestamptz);
      INSERT INTO sync_state VALUES ('crosschain_swaps','2026-09-27T23:59:00Z')`);
      const legacy = await readAnalytics(db, { period: "30d" }, { now });
      assert.equal(legacy.summary.volume_zec, "6.23456789");
      assert.equal(legacy.coverage.stale, false);
      assert.deepEqual(legacy.coverage.statusesAvailable, ["SUCCESS"]);
      const express = require("express");
      const app = express();
      app.locals.pool = db;
      app.use(require("../api/routes/crosschain-analytics"));
      const server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      const root = `http://127.0.0.1:${server.address().port}`;
      const v1 = require("../api/v1")({
        API_V1_ENABLED: "true",
        API_V1_LAUNCHED: "true",
        NEXT_PUBLIC_NETWORK: "mainnet",
        V1_INTERNAL_API_BASE_URL: root,
      });
      app.use("/v1", v1);
      try {
        const response = await fetch(
          root + "/v1/crosschain/analytics?period=all",
        );
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.data.summary.swaps, 4);
        assert.deepEqual(body.data.routeRankings.swaps, body.data.routes);
        assert.ok(body.data.routeRankings.usd.length > 0);
        assert.equal(body.data.coverage.source, "legacy-success-index");
        const page = await fetch(
          root + "/v1/crosschain/swaps?period=all&limit=1",
        );
        assert.equal(page.status, 200);
        assert.ok((await page.json()).data.nextCursor);
        for (const query of ["period=bad", "period=7d&period=30d", "unknown=1"])
          assert.equal(
            (await fetch(root + "/v1/crosschain/analytics?" + query)).status,
            400,
          );
        assert.equal(
          (await fetch(root + "/v1/crosschain/swaps?minUsd=100&maxUsd=1"))
            .status,
          400,
        );
        app.locals.pool = {
          connect: async () => {
            throw new Error("postgres://secret:password@private-host/db");
          },
        };
        const unavailable = await fetch(root + "/api/crosschain/swaps");
        assert.equal(unavailable.status, 503);
        assert.deepEqual(await unavailable.json(), {
          success: false,
          error: "Cross-chain index temporarily unavailable",
        });
      } finally {
        v1.__stopRateLimiters?.();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await upsert(
        db,
        tx("missing-values", {
          createdAt: "2026-07-01T00:00:00Z",
          amountInUsd: null,
          amountOutFormatted: null,
        }),
        tokens,
      );
      const missing = await readAnalytics(
        db,
        { period: "24h" },
        { v2: true, now: new Date("2026-07-01T12:00:00Z") },
      );
      assert.equal(missing.routeRankings.usd[0].volume_usd, null);
      assert.equal(missing.routeRankings.zec[0].volume_zec, null);
      assert.equal(missing.summary.volume_usd, null);
      assert.equal(missing.summary.average_usd, null);
      assert.equal(missing.flows[0].inflow_usd, null);
      assert.equal(missing.flows[0].outflow_usd, "0");
      assert.equal(missing.summary.volume_zec, null);
      assert.equal(missing.summary.missing_usd, 1);
      assert.equal(missing.tokenFlows[0].inflow_zec, null);
      assert.equal(missing.chainHistory[0].net_zec, null);
      assert.equal(missing.chainHistory[0].missing_zec, 1);
      assert.equal(missing.distribution.length, 0);
      assert.equal(missing.trends.find((t) => t.swaps === 1).inflow_usd, null);
      await db.query(`INSERT INTO crosschain_swaps_v2
        (deposit_address,deposit_memo,status,swap_created_at,source_chain,source_token,dest_chain,dest_token,source_amount,dest_amount,source_amount_usd,payload)
        SELECT 'extra-'||i,'','SUCCESS','2026-09-20T00:00:00Z','zec','ZEC','test'||i,'TOK',1,2,100,
          jsonb_build_object('originAsset','zec','destinationAsset','asset-'||i)
        FROM generate_series(1,105)i`);
      await db.query("UPDATE crosschain_swaps_v2 SET source_amount_usd=1000000 WHERE deposit_address='extra-99'");
      await db.query("UPDATE crosschain_swaps_v2 SET source_amount=500000 WHERE deposit_address='extra-98'");
      await db.query("UPDATE crosschain_swaps_v2 SET source_amount_usd=NULL,source_amount=NULL WHERE deposit_address='extra-97'");
      const expanded = await readAnalytics(
        db,
        { period: "30d" },
        { v2: true, now },
      );
      assert.equal(expanded.routes.length, 100);
      assert.deepEqual(expanded.routeRankings.swaps, expanded.routes);
      assert.ok(!expanded.routes.some((r) => r.dest_asset === "asset-99"));
      assert.ok(!expanded.routes.some((r) => r.dest_asset === "asset-98"));
      assert.equal(expanded.routeRankings.usd[0].dest_asset, "asset-99");
      assert.equal(expanded.routeRankings.usd[0].volume_usd, "1000000");
      assert.equal(expanded.routeRankings.zec[0].dest_asset, "asset-98");
      assert.equal(Number(expanded.routeRankings.zec[0].volume_zec), 500000);
      for (const metric of ["usd", "zec"]) {
        assert.equal(expanded.routeRankings[metric].length, 100);
        assert.ok(!expanded.routeRankings[metric].some((r) => r.dest_asset === "asset-97"));
        assert.ok(!Object.hasOwn(expanded.routeRankings[metric][0], "rank_usd"));
      }
      assert.equal(expanded.flows.length, 106);
      assert.equal(expanded.tokenFlows.length, 106);
      assert.equal(
        expanded.tokenFlows.reduce((n, r) => n + r.swaps, 0),
        expanded.summary.swaps,
      );
      assert.equal(
        expanded.chainHistory.reduce((n, r) => n + r.swaps, 0),
        expanded.summary.swaps,
      );
      assert.equal(
        expanded.chainOutcomes.reduce((n, r) => n + r.count, 0),
        expanded.statuses.reduce((n, r) => n + r.count, 0),
      );
    } finally {
      if (db) await db.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    }
  },
);

test("maintenance provider calls have one attempt and yield before their deadline", async () => {
  let calls = 0;
  const failure = new Error("network unavailable");
  const request = explorerClient({key: "test-only", maxAttempts: 1, wait: async () => {},
    fetchImpl: async () => { calls++; throw failure; }});
  await assert.rejects(request({}), (err) => err === failure);
  assert.equal(calls, 1);
  const expired = explorerClient({key: "test-only", deadlineAt: 75000, clock: () => 70000,
    fetchImpl: async () => { throw Error("request must not start"); }});
  await assert.rejects(expired({}), {code: "CROSSCHAIN_BATCH_YIELD"});
  let elapsed = 0;
  const bodyDeadline = explorerClient({key: "test-only", deadlineAt: 75000, clock: () => elapsed,
    maxAttempts: 1, wait: async () => {}, fetchImpl: async () => ({ok: true, status: 200,
      json: async () => { elapsed = 74000; throw Object.assign(Error("body aborted"), {name: "TimeoutError"}); }})});
  await assert.rejects(bodyDeadline({}), {code: "CROSSCHAIN_BATCH_YIELD"});
  elapsed = 0;
  const cooldown = explorerClient({key: "test-only", deadlineAt: 75000, clock: () => elapsed,
    maxAttempts: 1, wait: async () => {}, fetchImpl: async () => {
      elapsed = 74000; throw Object.assign(Error("provider cooldown"), {code: "NEAR_COOLDOWN"});
    }});
  await assert.rejects(cooldown({}), {code: "NEAR_COOLDOWN"});
  elapsed = 0;
  const malformed = explorerClient({key: "test-only", deadlineAt: 75000, clock: () => elapsed,
    maxAttempts: 1, wait: async () => {}, fetchImpl: async () => ({ok: true, status: 200,
      json: async () => { elapsed = 74000; throw new SyntaxError("invalid JSON"); }})});
  await assert.rejects(malformed({}), SyntaxError);
});

test("PostgreSQL: budget yield preserves the last committed page and resumes its cursor", {
  skip: process.env.CROSSCHAIN_TEST_POSTGRES !== "1",
}, async () => {
  const name = `crosschain_yield_test_${process.pid}_${Date.now()}`;
  const admin = new Pool({host: "/tmp", database: "postgres", max: 1});
  let db;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    db = new Pool({host: "/tmp", database: name, max: 1});
    await db.query(fs.readFileSync(require.resolve("../scripts/create-crosschain-v2.sql"), "utf8"));
    let requests = 0;
    const request = async (params) => {
      requests++;
      if (requests === 1) return [tx("budget-page")];
      assert.equal(params.lastDepositAddress, "budget-page");
      throw Object.assign(Error("budget exhausted"), {code: "CROSSCHAIN_BATCH_YIELD"});
    };
    const result = await traverse(db, request, tokens, {mode: "reconcile", direction: "outflow", maxPages: 4});
    assert.deepEqual(result, {complete: false, pages: 1, yielded: true});
    const before = (await db.query("SELECT * FROM crosschain_sync_v2 WHERE mode='reconcile'")).rows[0];
    assert.equal(before.cursor_address, "budget-page");
    assert.equal(before.pages, "1");
    const yielded = await traverse(db, () => {throw Error("must not request");}, tokens,
      {mode: "reconcile", direction: "outflow", maxPages: 1, shouldContinue: () => false});
    assert.deepEqual(yielded, {complete: false, pages: 0, yielded: true});
    assert.deepEqual((await db.query("SELECT * FROM crosschain_sync_v2 WHERE mode='reconcile'")).rows[0], before);
    const resumed = await traverse(db, async (params) => {
      assert.equal(params.lastDepositAddress, "budget-page"); return [];
    }, tokens, {mode: "reconcile", direction: "outflow", maxPages: 1});
    assert.equal(resumed.complete, true);
    assert.equal((await db.query("SELECT count(*) FROM crosschain_swaps_v2")).rows[0].count, "1");
  } finally {
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
});

test("PostgreSQL: coverage separates filtered traversal, reconciliation and live freshness", {
  skip: process.env.CROSSCHAIN_TEST_POSTGRES !== "1",
}, async () => {
  const name = `crosschain_gate_test_${process.pid}_${Date.now()}`;
  const admin = new Pool({ host: "/tmp", database: "postgres", max: 1 });
  let db;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    db = new Pool({ host: "/tmp", database: name, max: 1 });
    await db.query(fs.readFileSync(require.resolve("../scripts/create-crosschain-v2.sql"), "utf8"));
    await db.query("CREATE TABLE transactions(txid text PRIMARY KEY,block_time bigint)");
    const now = new Date("2026-10-15T09:00:00Z");
    await db.query(`INSERT INTO crosschain_sync_v2
      (scope,mode,direction,completed_at,completed_through,window_end,pages,updated_at) VALUES
      ('all-statuses-v1','reconcile','inflow',$1,$1,NULL,900,$1),
      ('all-statuses-v1','reconcile','outflow',$1,$1,NULL,900,$1),
      ('non-pending-v1','backfill','inflow',$1,$1,NULL,12,$1),
      ('non-pending-v1','backfill','outflow',$1,$1,NULL,14,$1),
      ('non-pending-v1','sync','inflow',$1,$1,NULL,1,$1),
      ('non-pending-v1','sync','outflow',$1,$1,NULL,1,$1),
      ('non-pending-v1','reconcile','inflow',$1,$1,NULL,123,$1),
      ('non-pending-v1','reconcile','outflow',$1,$1,$1,45,$1)`, [now]);
    const read = async (at = now) => (await readAnalytics(db, { period: "all" }, { v2: true, now: at })).coverage;
    const partial = await read();
    assert.equal(partial.source, "near-explorer-v2");
    assert.equal(partial.ingestionScope, "non-pending-v1");
    assert.equal(partial.historyTraversalComplete, true);
    assert.equal(partial.statusReconciliationComplete, false);
    assert.equal(partial.stale, false);
    assert.equal(partial.continuousThrough, null); // checkpoint completion cannot invent coverage
    assert.deepEqual(partial.reconciliation, [
      { direction: "inflow", complete: true, pages: 123, completedThrough: now.toISOString(), lastAdvancedAt: now.toISOString() },
      { direction: "outflow", complete: false, pages: 45, completedThrough: now.toISOString(), lastAdvancedAt: now.toISOString() },
    ]);
    await db.query("UPDATE crosschain_sync_v2 SET window_end=NULL WHERE scope=$1 AND mode='reconcile' AND direction='outflow'", [INGEST_SCOPE]);
    const completed = await read(new Date(now.getTime() + 21 * 60000));
    assert.equal(completed.statusReconciliationComplete, true);
    assert.equal(completed.stale, true); // completed sweeps cannot conceal stale live synchronization
    await db.query("DELETE FROM crosschain_sync_v2 WHERE scope=$1 AND mode='reconcile' AND direction='outflow'", [INGEST_SCOPE]);
    assert.equal((await read()).statusReconciliationComplete, false); // old-scope completion cannot fill a missing direction
  } finally {
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
});
