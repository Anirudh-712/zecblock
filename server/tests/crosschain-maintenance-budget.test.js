"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { maintain } = require("../lib/crosschain/maintain");

const now = new Date("2026-10-14T09:00:00Z");
const history = [
  { direction: "inflow", completed_at: new Date("2026-10-11T01:00:00Z") },
  { direction: "outflow", completed_at: new Date("2026-10-11T23:00:00Z") },
];
function database(states = []) {
  return {
    query: async (sql, params) => {
      assert.deepEqual(params, ["non-pending-v1"]);
      if (sql.includes("mode='backfill'")) return { rows: history };
      assert.ok(sql.includes("mode='reconcile'"));
      return { rows: states };
    },
  };
}
const unexpectedRequest = () => { throw Error("unexpected provider request"); };

test("maintenance interleaves pages and gives the older unfinished direction first turn", async () => {
  const calls = [];
  const states = [
    { direction: "inflow", updated_at: new Date("2026-10-14T08:55:00Z") },
    { direction: "outflow", updated_at: new Date("2026-10-14T08:40:00Z") },
  ];
  const result = await maintain(database(states), unexpectedRequest, new Map(), {
    now, pageSize: 1000,
    traverseFn: async (_db, _request, _tokens, options) => {
      calls.push(`${options.mode}:${options.direction}`);
      assert.equal(options.shouldContinue(), true);
      if (options.mode === "sync") {
        assert.equal(options.maxPages, 2);
        assert.equal(options.pageSize, 1000);
        assert.equal(options.syncOverlapMs, 3600000);
        assert.equal(options.bootstrapFromBackfill, true);
        return { complete: true, pages: 1 };
      }
      assert.equal(options.maxPages, 1);
      assert.equal(options.pageSize, 100);
      return { complete: false, pages: 1 };
    },
    refreshFn: async (_db, _request, _tokens, limit) => {
      assert.equal(limit, 1);
      calls.push("refresh");
    },
  });
  assert.deepEqual(result, { yielded: false });
  assert.deepEqual(calls, [
    "sync:inflow", "sync:outflow",
    "reconcile:outflow", "reconcile:inflow",
    "reconcile:outflow", "reconcile:inflow",
    "reconcile:outflow", "reconcile:inflow",
    "reconcile:outflow", "reconcile:inflow", "refresh",
  ]);
});

test("maintenance preserves completed directions and does not reopen a sweep finished in this batch", async () => {
  const inflow = {
    direction: "inflow", completed_at: new Date("2026-10-14T07:22:43Z"), window_end: null,
    updated_at: new Date("2026-10-14T07:22:43Z"),
  };
  const before = structuredClone(inflow);
  const calls = [];
  await maintain(database([inflow, { direction: "outflow", window_end: now }]), unexpectedRequest, new Map(), {
    now,
    traverseFn: async (_db, _request, _tokens, options) => {
      calls.push(`${options.mode}:${options.direction}`);
      return { complete: true, pages: 1 };
    },
    refreshFn: async () => { calls.push("refresh"); },
  });
  assert.deepEqual(calls, ["sync:inflow", "sync:outflow", "reconcile:outflow", "refresh"]);
  assert.deepEqual(inflow, before);
});

test("maintenance yields between committed pages before starting any further work", async () => {
  let elapsed = 0;
  const calls = [];
  const logs = [];
  const result = await maintain(database(), unexpectedRequest, new Map(), {
    now, shouldContinue: () => elapsed < 50,
    traverseFn: async (_db, _request, _tokens, options) => {
      calls.push(`${options.mode}:${options.direction}`);
      elapsed += options.mode === "sync" ? 10 : 15;
      return { complete: options.mode === "sync", pages: 1 };
    },
    refreshFn: async () => { throw Error("refresh must not consume a finished budget"); },
    log: (progress) => logs.push(progress),
  });
  assert.deepEqual(result, { yielded: true });
  assert.deepEqual(calls, ["sync:inflow", "sync:outflow", "reconcile:inflow", "reconcile:outflow"]);
  assert.equal(logs.filter((progress) => progress.mode === "reconcile" && !progress.yielded).length, 2);
  assert.equal(logs.at(-1).yielded, true);
});

test("maintenance accepts a traversal budget yield and leaves catch-up first", async () => {
  const calls = [];
  const result = await maintain(database(), unexpectedRequest, new Map(), {
    now,
    traverseFn: async (_db, _request, _tokens, options) => {
      calls.push(`${options.mode}:${options.direction}`);
      return { complete: false, pages: 1, yielded: true };
    },
    refreshFn: async () => { throw Error("unexpected refresh"); },
  });
  assert.deepEqual(result, { yielded: true });
  assert.deepEqual(calls, ["sync:inflow"]);
});

test("request budget yields finish normally while provider errors remain failures", async () => {
  const invoke = (error) => maintain(database(), unexpectedRequest, new Map(), {
    now,
    traverseFn: async () => { throw error; },
    refreshFn: async () => { throw Error("unexpected refresh"); },
  });
  assert.deepEqual(await invoke(Object.assign(new Error("budget"), { code: "CROSSCHAIN_BATCH_YIELD" })), { yielded: true });
  await assert.rejects(invoke(Object.assign(new Error("cooldown"), { code: "NEAR_COOLDOWN" })), { code: "NEAR_COOLDOWN" });
  await assert.rejects(invoke(new Error("Unexpected provider response")), /Unexpected provider response/);
});
