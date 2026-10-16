# Historical miner-receipts repair

This release separates historical subsidy allocations from sampled NSM state.
Actual receipts remain indexed coinbase creation minus authoritative founders
and funding-stream payouts. It does not replace actual receipts with the maximum
permitted reward, and does not reconstruct historical NSM/supply/pool snapshots.

## Release order

1. Reconcile the intended explorer/API commit with serving main/testnet sources.
   Apply **036_block_subsidy_allocations.sql**, then
   **037_block_subsidy_allocation_privileges.sql** from the canonical Rust migration
   directory (the API release includes identical deployment copies). Check both
   ledger entries and effective API/job role grants: PostgreSQL default ACLs can
   grant more than 036 explicitly requests. Migration 037 removes all non-owner
   cache rights, including version-specific MAINTAIN, then restores existing
   named-role SELECT/INSERT only. Source-table/default ACLs and data are unchanged.
   No Rust binary or node update
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
   unit has a separate 60-second deadline and 5-second stop deadline. Per-height
   RPC failures do not block later candidates; database/identity failures stop the
   run. Prior immutable inserts remain. Private atomic state persists retries with
   exponential backoff from 1 to 15 minutes. Repeat canaries until coverage reconciles.
5. Verify both sides of halving 4,497,948, actual receipts/underclaims, canonical
   joins, fee totals, unchanged NSM sample counts and all chart periods. Period
   caches last at most 60 seconds; allocation-table discovery caches 30 seconds.
   Only then install/enable the timer for continuous gap maintenance.
6. Enable the separate health timer. It requires the maintenance timer to be
   active and enabled, a successful run within five minutes, matching node/database
   identity, a matching indexed-tip canonical anchor and no persistent canonical
   allocation gaps older than 24 blocks.
   Backed-off hashes remain visible to this check. State and health reports live
   in `/var/lib/cipherscan-subsidy-allocations` with private file permissions.
   After a healthy report exists, set the API `SUBSIDY_ALLOCATION_HEALTH_FILE` to
   its `health.json`. The uncached deep-health endpoint returns HTTP 503 for a
   missing, invalid, stale or unhealthy configured report. Confirm an external
   monitor polls this endpoint before claiming notification coverage.

The worker verifies DB is writable, expected network, node-announced NU7 and
node/database genesis identity, and takes a session advisory lock. A separate
ownership session serializes the complete state lifecycle before any state
read/write; overlapping invocations leave state untouched, and session loss
terminates the maintenance CLI. The CLI also has a 60-second wall-clock watchdog. It checks the
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

Rollback the API/frontend and disable both new timers if needed. Remove the API
health-file setting when rolling back the monitor. The additive
cache and its narrowed grants can remain: old readers do not reference it, no original observations are
rewritten, and valid historical records are idempotent by hash. Preserve release
and migration evidence; do not delete the table to hide an unexplained mismatch.

Local implementation and replay verification do **not** establish public
installation, migration application, a completed backfill or Vercel readiness.
Record those separately after an actual rollout.
