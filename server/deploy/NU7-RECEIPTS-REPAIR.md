# Historical miner-receipts repair

This release separates historical subsidy allocations from sampled NSM state.
Actual receipts remain indexed coinbase creation minus authoritative founders
and funding-stream payouts. It does not replace actual receipts with the maximum
permitted reward, and does not reconstruct historical NSM/supply/pool snapshots.

## Release order

1. Reconcile the intended explorer/API commit with serving main/testnet sources.
   Apply **036_block_subsidy_allocations.sql** from the canonical Rust migration
   directory (the API release includes an identical deployment copy). Check the
   migration ledger and actual API/job role grants. No Rust binary or node update
   is required. The API supports an absent allocation table during rollout.
2. Deploy the API and frontend from the tested commit. `receiptBlocks` is additive
   on period points, selected/lifetime totals and legacy coverage. Receipts use
   cached allocations only when height, canonical hash, network, source and
   integer amounts match. The frontend supports older API responses explicitly.
3. On the **active official-testnet writer only**, configure the job using the
   existing writer DB and local node credentials. `/etc/cipherscan/subsidy-allocations.env`
   must set `NETWORK=testnet` and the applicable `DB_*`, `ZEBRA_RPC_URL` and cookie
   variables. Protect it as mode 0600. Adjust the unit's checkout/runtime paths
   to the verified host; do not infer testnet paths from mainnet defaults.
4. Run one bounded canary:
   `node server/jobs/maintain-subsidy-allocations.js`.
   Default batch is 100 (configurable 1–500); each run has a 45-second work budget,
   5-second DB statement deadlines and at most 8 seconds per RPC. The systemd
   unit has a separate 60-second deadline. RPC/DB errors stop the run; prior
   successful immutable inserts remain. Repeat canaries until coverage reconciles.
5. Verify both sides of halving 4,497,948, actual receipts/underclaims, canonical
   joins, fee totals, unchanged NSM sample counts and all chart periods. Period
   caches last at most 60 seconds; allocation-table discovery caches 30 seconds.
   Only then install/enable the timer for continuous gap maintenance.

The worker verifies DB is writable, expected network, node-announced NU7 and
node/database genesis identity, and takes a session advisory lock. It checks the
canonical node hash before and after each historical subsidy RPC, then inserts
only if the same block is still canonical in the database. A later reorg can
retain an orphan cache entry; canonical hash/height/network joins exclude it.
The worker has no reason to update canonical block/transaction rows and never
writes migration-027 observations.

Keep the **passive standby writer and this timer inactive**. An unscheduled or
preactivation mainnet does no historical allocation work. Do not install a
scheduled writer on the passive standby as part of file/source synchronization.

## Verification and rollback

Run the focused accounting/worker/UI/v1 tests, including native PostgreSQL with
`TEST_ACCOUNTING_DATABASE_URL` pointing to a disposable database. Include the
real sparse-range regression: isolated receipt buckets must remain visible, and
missing data must never become zero or a connected line.

Rollback the API/frontend and disable the new timer if needed. The additive
cache can remain: old readers do not reference it, no original observations are
rewritten, and valid historical records are idempotent by hash. Preserve release
and migration evidence; do not delete the table to hide an unexplained mismatch.

Local implementation and replay verification do **not** establish public
installation, migration application, a completed backfill or Vercel readiness.
Record those separately after an actual rollout.
