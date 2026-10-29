"use strict";

const STATUSES = [
  "SUCCESS",
  "FAILED",
  "REFUNDED",
  "PROCESSING",
  "PENDING_DEPOSIT",
  "INCOMPLETE_DEPOSIT",
];
// Version the traversal domain: cursors/coverage from an all-status scan must
// never certify or resume a filtered scan. Pending quotes are intentionally absent.
const INGEST_STATUSES = STATUSES.filter((status) => status !== "PENDING_DEPOSIT");
// Filtered 1,000-row requests exceeded the production batch deadline. Keep
// smaller pages without increasing request frequency or shared quota.
const INGEST_PAGE_SIZE = 100;
const INGEST_SCOPE = "non-pending-v1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalizeChain = (chain) =>
  ({ trx: "tron", bnb: "bsc", apt: "aptos" })[chain] || chain;
const decimal = (value) =>
  typeof value === "string" &&
  /^\d+(\.\d+)?$/.test(value) &&
  value.length <= 160
    ? value
    : null;

function transform(tx, tokens) {
  if (
    !tx ||
    typeof tx.depositAddress !== "string" ||
    !tx.depositAddress ||
    !STATUSES.includes(tx.status) ||
    !Number.isFinite(Date.parse(tx.createdAt)) ||
    !tx.originAsset ||
    !tx.destinationAsset ||
    (tx.depositMemo != null && typeof tx.depositMemo !== "string")
  )
    throw new Error("Invalid Explorer transaction; checkpoint not advanced");
  const asset = (id) =>
    tokens.get(id) ||
    (id === "nep141:zec.omft.near"
      ? { blockchain: "zec", symbol: "ZEC" }
      : { blockchain: "unknown", symbol: "UNKNOWN" });
  const src = asset(tx.originAsset),
    dst = asset(tx.destinationAsset);
  if (src.blockchain !== "zec" && dst.blockchain !== "zec")
    throw new Error("Cannot identify native ZEC leg from token catalog");
  // In-flight amounts are deliberately hidden by upstream. Zero is not volume.
  const settled = ["SUCCESS", "REFUNDED"].includes(tx.status);
  return [
    tx.depositAddress,
    tx.depositMemo || "",
    tx.status,
    tx.createdAt,
    normalizeChain(src.blockchain),
    src.symbol,
    normalizeChain(dst.blockchain),
    dst.symbol,
    settled ? decimal(tx.amountInFormatted) : null,
    settled ? decimal(tx.amountOutFormatted) : null,
    settled ? decimal(tx.amountInUsd) : null,
    settled ? decimal(tx.amountOutUsd) : null,
    JSON.stringify(tx),
  ];
}

async function upsert(db, tx, tokens) {
  // Defense in depth if an upstream filter is ignored. Do not insert or update
  // pending quotes, including previously indexed identities.
  if (tx?.status === "PENDING_DEPOSIT") return false;
  const row = transform(tx, tokens);
  await db.query(
    `INSERT INTO crosschain_swaps_v2
    (deposit_address,deposit_memo,status,swap_created_at,source_chain,source_token,dest_chain,dest_token,
     source_amount,dest_amount,source_amount_usd,dest_amount_usd,payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (deposit_address,deposit_memo) DO UPDATE SET
      status_observed_at=CASE WHEN crosschain_swaps_v2.status<>EXCLUDED.status THEN now() ELSE crosschain_swaps_v2.status_observed_at END,
      status=EXCLUDED.status,swap_created_at=EXCLUDED.swap_created_at,
      source_chain=EXCLUDED.source_chain,source_token=EXCLUDED.source_token,dest_chain=EXCLUDED.dest_chain,dest_token=EXCLUDED.dest_token,
      source_amount=EXCLUDED.source_amount,dest_amount=EXCLUDED.dest_amount,
      source_amount_usd=EXCLUDED.source_amount_usd,dest_amount_usd=EXCLUDED.dest_amount_usd,payload=EXCLUDED.payload,last_seen_at=now(),last_checked_at=now()`,
    row,
  );
}

function explorerClient({
  key,
  fetchImpl = fetch,
  wait = sleep,
  now = Date.now,
  clock = now,
  maxAttempts = 5,
  requestTimeoutMs = 30000,
  deadlineAt = Infinity,
} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5 ||
      !Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30000)
    throw new Error("Invalid Explorer request bounds");
  const yieldBatch = () => Object.assign(
    new Error("Cross-chain batch budget exhausted; checkpoint preserved"),
    { code: "CROSSCHAIN_BATCH_YIELD" },
  );
  let lastRequest = -Infinity;
  return async (params) => {
    if (!key) throw new Error("NEAR_INTENTS_API_KEY required");
    const url = new URL(
      "https://explorer.near-intents.org/api/v0/transactions",
    );
    for (const [k, v] of Object.entries(params))
      if (v != null) url.searchParams.set(k, String(v));
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Leave time for the shared six-second reservation and transaction cleanup.
      if (deadlineAt - clock() <= 8000) throw yieldBatch();
      await wait(Math.max(0, 5500 - (now() - lastRequest)));
      if (deadlineAt - clock() <= 8000) throw yieldBatch();
      lastRequest = now();
      let res;
      try {
        res = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(Math.floor(Math.min(requestTimeoutMs, deadlineAt - clock() - 2000))),
        });
      } catch (err) {
        if (err.code === "NEAR_COOLDOWN") throw err;
        if (["AbortError", "TimeoutError"].includes(err.name) && deadlineAt - clock() <= 2000)
          throw yieldBatch();
        if (attempt === maxAttempts - 1) throw err;
        await wait(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt === maxAttempts - 1)
          throw new Error(
            `Explorer unavailable (${res.status}); checkpoint preserved`,
          );
        const retry = res.headers.get("retry-after");
        const retryMs = /^\d+$/.test(retry || "")
          ? Number(retry) * 1000
          : Date.parse(retry) - now();
        // Never retry before a provider-requested long cooldown. The next
        // scheduled invocation resumes the durable checkpoint instead.
        if (retryMs > 60000)
          throw new Error(
            "Explorer requested a long cooldown; checkpoint preserved",
          );
        await wait(
          Math.max(5500 * 2 ** attempt, Number.isFinite(retryMs) ? retryMs : 0),
        );
        continue;
      }
      if (!res.ok)
        throw new Error(`Explorer HTTP ${res.status}; checkpoint preserved`);
      let rows;
      try {
        rows = await res.json();
      } catch (err) {
        if (["AbortError", "TimeoutError"].includes(err.name) && deadlineAt - clock() <= 2000)
          throw yieldBatch();
        throw err;
      }
      if (!Array.isArray(rows)) throw new Error("Invalid Explorer response");
      return rows;
    }
  };
}

async function loadTokens(fetchImpl = fetch) {
  const res = await fetchImpl("https://1click.chaindefuser.com/v0/tokens", {
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Token catalog HTTP ${res.status}`);
  const tokens = await res.json();
  if (!Array.isArray(tokens) || !tokens.some((t) => t.blockchain === "zec"))
    throw new Error("Incomplete token catalog");
  return new Map(
    tokens
      .filter((t) => t.assetId && t.blockchain && t.symbol)
      .map((t) => [t.assetId, t]),
  );
}

function validateReconciliationDates(rows, { start = -Infinity, end, ceiling = end }) {
  if (!Array.isArray(rows)) throw new Error("Invalid Explorer response; checkpoint preserved");
  let previous = Infinity;
  for (const row of rows) {
    const timestamp = Date.parse(row?.createdAt);
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end ||
        timestamp > ceiling || timestamp > previous)
      throw new Error("Invalid reconciliation date bounds or order; checkpoint preserved");
    previous = timestamp;
  }
}

// A tight creation window avoids the provider's expensive unbounded cursor
// lookup. The boundary timestamp overlaps between pages so same-time identities
// are never skipped. Only the original unbounded cursor may establish exhaustion.
async function fetchReconciliationPage(db, request, state, params) {
  const end = new Date(state.window_end).getTime();
  const start = state.window_start ? new Date(state.window_start).getTime() - 1 : -Infinity;
  const fallback = async (ceiling = end) => {
    const rows = await request({ ...params, numberOfTransactions: 100 });
    validateReconciliationDates(rows, { start, end, ceiling });
    return rows;
  };
  if (!state.cursor_address) return fallback();
  const stored = (await db.query(
    "SELECT swap_created_at FROM crosschain_swaps_v2 WHERE deposit_address=$1 AND deposit_memo=$2",
    [state.cursor_address, state.cursor_memo || ""],
  )).rows[0];
  // An ignored upstream status filter may have left a retained quote cursor
  // without a corresponding useful row. Preserve the existing cursor path.
  if (!stored) return fallback();
  const boundary = new Date(stored.swap_created_at).getTime();
  if (!Number.isFinite(boundary) || boundary > end || boundary < start)
    throw new Error("Invalid reconciliation cursor date; checkpoint preserved");
  const boundedStart = Math.max(start, boundary - 86400000 - 1);
  const boundedEnd = Math.min(end, boundary + 1);
  const rows = await request({
    ...params,
    numberOfTransactions: 1000,
    startTimestamp: new Date(boundedStart).toISOString(),
    endTimestamp: new Date(boundedEnd).toISOString(),
    lastDepositAddress: undefined,
    lastDepositMemo: undefined,
  });
  validateReconciliationDates(rows, { start: boundedStart, end: boundedEnd, ceiling: boundary });
  if (rows.length && Date.parse(rows.at(-1).createdAt) < boundary) return rows;
  // Empty calendar windows and pages containing only boundary ties must not
  // certify completion or reset durable identity progress within those ties.
  return fallback(boundary);
}

// Caller holds a session advisory lock. Every page and its cursor commit together.
// Stop only on an exhausted cursor, never on an empty calendar week or a short page.
async function traverse(
  db,
  request,
  tokens,
  {
    mode, direction, maxPages = 5, now = new Date(),
    pageSize = INGEST_PAGE_SIZE, syncOverlapMs = 7 * 86400000,
    bootstrapFromBackfill = false,
    shouldContinue = () => true,
    reconcileDatePages = false,
  },
) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000 ||
      !Number.isFinite(syncOverlapMs) || syncOverlapMs < 60000 || syncOverlapMs > 7 * 86400000)
    throw new Error("Invalid traversal bounds");
  await db.query(
    "INSERT INTO crosschain_sync_v2 (mode,direction,scope) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    [mode, direction, INGEST_SCOPE],
  );
  let state = (
    await db.query(
      "SELECT * FROM crosschain_sync_v2 WHERE mode=$1 AND direction=$2 AND scope=$3",
      [mode, direction, INGEST_SCOPE],
    )
  ).rows[0];
  if (mode === "backfill" && state.completed_at)
    return { complete: true, pages: 0 };
  if (!state.window_end) {
    let anchor = state.completed_through || now;
    if (mode === "sync" && !state.completed_through && bootstrapFromBackfill) {
      const historical = (await db.query(
        "SELECT completed_through FROM crosschain_sync_v2 WHERE scope=$1 AND mode='backfill' AND direction=$2 AND completed_at IS NOT NULL",
        [INGEST_SCOPE, direction],
      )).rows[0];
      if (!historical?.completed_through)
        throw new Error("Live maintenance requires completed historical traversal");
      anchor = historical.completed_through;
    }
    const start =
      mode === "sync"
        ? new Date(new Date(anchor).getTime() - syncOverlapMs)
        : null;
    state = (
      await db.query(
        `UPDATE crosschain_sync_v2 SET window_start=$3,window_end=$4,cursor_address=NULL,cursor_memo=NULL
      WHERE mode=$1 AND direction=$2 AND scope=$5 RETURNING *`,
        [mode, direction, start, now, INGEST_SCOPE],
      )
    ).rows[0];
  }
  const seen = new Set();
  for (let page = 0; page < maxPages; page++) {
    if (!shouldContinue()) return { complete: false, pages: page, yielded: true };
    let rows;
    try {
      const params = {
        statuses: INGEST_STATUSES.join(","),
        numberOfTransactions: pageSize,
        direction: "next",
        showTestTxs: "false",
        [direction === "inflow" ? "toChainId" : "fromChainId"]: "zec",
        startTimestamp: state.window_start
          ? new Date(state.window_start.getTime() - 1).toISOString()
          : undefined,
        endTimestamp: state.window_end.toISOString(),
        lastDepositAddress: state.cursor_address,
        // Empty memo is not equivalent to an omitted memo for the provider cursor.
        lastDepositMemo: state.cursor_address
          ? state.cursor_memo || undefined
          : undefined,
      };
      rows = mode === "reconcile" && reconcileDatePages
        ? await fetchReconciliationPage(db, request, state, params)
        : await request(params);
    } catch (err) {
      if (err.code !== "CROSSCHAIN_BATCH_YIELD") throw err;
      return { complete: false, pages: page, yielded: true };
    }
    const last = rows.at(-1);
    const cursor = last
      ? JSON.stringify([last.depositAddress, last.depositMemo || ""])
      : null;
    if (
      cursor &&
      (cursor ===
        JSON.stringify([state.cursor_address, state.cursor_memo || ""]) ||
        seen.has(cursor))
    ) {
      throw new Error(
        "Explorer cursor did not advance; traversal remains incomplete",
      );
    }
    if (cursor) seen.add(cursor);
    await db.query("BEGIN");
    try {
      for (const row of rows) await upsert(db, row, tokens);
      if (!rows.length) {
        await db.query(
          `INSERT INTO crosschain_coverage_v2(direction,window_start,window_end,scope)
          VALUES ($1,$2,$3,$4) ON CONFLICT (scope,direction,window_end) DO UPDATE SET
          window_start=CASE WHEN crosschain_coverage_v2.window_start IS NULL OR EXCLUDED.window_start IS NULL THEN NULL ELSE LEAST(crosschain_coverage_v2.window_start,EXCLUDED.window_start) END,
          completed_at=now()`,
          [direction, state.window_start, state.window_end, INGEST_SCOPE],
        );
        await db.query(
          `UPDATE crosschain_sync_v2 SET completed_at=now(),completed_through=window_end,
          window_start=NULL,window_end=NULL,cursor_address=NULL,cursor_memo=NULL,updated_at=now()
          WHERE mode=$1 AND direction=$2 AND scope=$3`,
          [mode, direction, INGEST_SCOPE],
        );
      } else {
        await db.query(
          `UPDATE crosschain_sync_v2 SET cursor_address=$3,cursor_memo=$4,pages=pages+1,
          records=records+$5,updated_at=now() WHERE mode=$1 AND direction=$2 AND scope=$6`,
          [
            mode,
            direction,
            last.depositAddress,
            last.depositMemo || "",
            rows.length,
            INGEST_SCOPE,
          ],
        );
      }
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }
    if (!rows.length) return { complete: true, pages: page + 1 };
    state.cursor_address = last.depositAddress;
    state.cursor_memo = last.depositMemo || "";
  }
  return { complete: false, pages: maxPages };
}

async function refreshUnsettled(db, request, tokens, limit = 10) {
  const { rows } = await db.query(
    `SELECT deposit_address,deposit_memo FROM crosschain_swaps_v2
    WHERE status IN ('PROCESSING','INCOMPLETE_DEPOSIT')
      ORDER BY last_checked_at LIMIT $1`,
    [limit],
  );
  for (const row of rows) {
    const found = await request({
      search: row.deposit_address,
      depositMemo: row.deposit_memo,
      statuses: INGEST_STATUSES.join(","),
      numberOfTransactions: 1000,
    });
    // Search is broad; accept only exact identity. Absence is not failure/deletion.
    const exact = found.find(
      (tx) =>
        tx.depositAddress === row.deposit_address &&
        (tx.depositMemo || "") === row.deposit_memo,
    );
    if (exact && exact.status !== "PENDING_DEPOSIT") await upsert(db, exact, tokens);
    else
      await db.query(
        "UPDATE crosschain_swaps_v2 SET last_checked_at=now() WHERE deposit_address=$1 AND deposit_memo=$2",
        [row.deposit_address, row.deposit_memo],
      );
  }
}
module.exports = {
  STATUSES,
  INGEST_STATUSES,
  INGEST_SCOPE,
  INGEST_PAGE_SIZE,
  transform,
  upsert,
  explorerClient,
  loadTokens,
  fetchReconciliationPage,
  traverse,
  refreshUnsettled,
};
