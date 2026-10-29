-- Explicit, additive online indexes. Run outside a transaction on the primary.
-- Retained pending quotes must not force every public analytics query to scan
-- millions of artifacts that are excluded from the active ingestion domain.
SET lock_timeout = '2s';
SET statement_timeout = '180s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS crosschain_v2_nonpending_created
  ON crosschain_swaps_v2 (swap_created_at DESC, deposit_address, deposit_memo)
  INCLUDE (status,source_chain,dest_chain,source_token,dest_token,
           source_amount,dest_amount,source_amount_usd,dest_amount_usd)
  WHERE status <> 'PENDING_DEPOSIT';
CREATE INDEX CONCURRENTLY IF NOT EXISTS crosschain_v2_active_unsettled
  ON crosschain_swaps_v2 (last_checked_at)
  WHERE status IN ('PROCESSING','INCOMPLETE_DEPOSIT');
ANALYZE crosschain_swaps_v2;
-- Verify pg_index.indisvalid for both indexes. If a concurrent build is
-- interrupted, inspect/drop only its invalid index concurrently before retry;
-- IF NOT EXISTS alone does not repair an invalid index.
