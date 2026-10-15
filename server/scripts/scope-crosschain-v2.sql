-- Run with the history service stopped, before the non-pending-v1 worker.
-- Preserve existing cursors/coverage as all-statuses-v1; new scope starts fresh.
-- No swap rows are removed and no reader is enabled.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SELECT pg_advisory_xact_lock(724092801);
ALTER TABLE crosschain_sync_v2 ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'all-statuses-v1';
ALTER TABLE crosschain_coverage_v2 ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'all-statuses-v1';
ALTER TABLE crosschain_sync_v2 DROP CONSTRAINT crosschain_sync_v2_pkey;
ALTER TABLE crosschain_sync_v2 ADD PRIMARY KEY (scope, mode, direction);
ALTER TABLE crosschain_coverage_v2 DROP CONSTRAINT crosschain_coverage_v2_pkey;
ALTER TABLE crosschain_coverage_v2 ADD PRIMARY KEY (scope, direction, window_end);
COMMIT;
