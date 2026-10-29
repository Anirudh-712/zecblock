"use strict";
const { INGEST_SCOPE, traverse, refreshUnsettled } = require("./ingest");

// Live scans use a short creation overlap. Older status changes are covered by
// a separate, resumable full filtered sweep, never by polling pending quotes.
async function maintain(db, request, tokens, {
  now = new Date(), pageSize = 100, log = () => {},
  shouldContinue = () => true,
  reconcileDatePages = false,
  traverseFn = traverse, refreshFn = refreshUnsettled,
} = {}) {
  const history = (await db.query(
    "SELECT direction,completed_at FROM crosschain_sync_v2 WHERE scope=$1 AND mode='backfill'",
    [INGEST_SCOPE],
  )).rows;
  if (history.length !== 2 || history.some((s) => !s.completed_at))
    throw new Error("Both historical traversals must finish before maintenance");
  const results = [];
  const runTraversal = async (options) => {
    if (!shouldContinue()) return { complete: false, pages: 0, yielded: true };
    try {
      return await traverseFn(db, request, tokens, { ...options, shouldContinue });
    } catch (err) {
      if (err.code !== "CROSSCHAIN_BATCH_YIELD") throw err;
      return { complete: false, pages: 0, yielded: true };
    }
  };
  for (const direction of ["inflow", "outflow"]) {
    const result = await runTraversal({
      mode: "sync", direction, maxPages: 2, pageSize, now,
      syncOverlapMs: 3600000, bootstrapFromBackfill: true,
    });
    results.push(result);
    log({ mode: "sync", scope: INGEST_SCOPE, direction, ...result });
    if (result.yielded) return { yielded: true };
  }
  // Give catch-up the whole batch until both fixed live windows are exhausted.
  if (results.some((r) => !r.complete)) return;
  const states = (await db.query(
    "SELECT direction,window_end,completed_at,updated_at FROM crosschain_sync_v2 WHERE scope=$1 AND mode='reconcile'",
    [INGEST_SCOPE],
  )).rows;
  const directions = ["inflow", "outflow"].filter((direction) => {
    const state = states.find((s) => s.direction === direction);
    // Completed directions stay intact until their next weekly sweep is due.
    return !(state?.completed_at && !state.window_end &&
        now.getTime() - new Date(state.completed_at).getTime() < 7 * 86400000);
  }).sort((a, b) => {
    const updated = (direction) => {
      const state = states.find((s) => s.direction === direction);
      return state?.updated_at ? new Date(state.updated_at).getTime() : 0;
    };
    return updated(a) - updated(b);
  });
  const completed = new Set();
  // Interleave committed pages so a slow first direction cannot consume the
  // entire batch before the other direction gets a turn. The durable timestamps
  // give the least recently advanced direction the first turn next time.
  for (let page = 0; page < 4; page++) {
    for (const direction of directions) {
      if (completed.has(direction)) continue;
      const result = await runTraversal({
        mode: "reconcile", direction, maxPages: 1, pageSize: 100, now,
        reconcileDatePages,
      });
      log({ mode: "reconcile", scope: INGEST_SCOPE, direction, ...result });
      if (result.yielded) return { yielded: true };
      if (result.complete) completed.add(direction);
    }
  }
  // A broad identity lookup must not starve the resumable history sweep.
  if (!shouldContinue()) return { yielded: true };
  try {
    await refreshFn(db, request, tokens, 1);
  } catch (err) {
    if (err.code !== "CROSSCHAIN_BATCH_YIELD") throw err;
    return { yielded: true };
  }
  return { yielded: false };
}
module.exports = { maintain };
