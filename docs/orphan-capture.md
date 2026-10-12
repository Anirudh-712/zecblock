# Continuous competing-block collection

The Mining page's `observed-block-capture-v2` method combines indexer-archived
reorg losses with node-validated blocks captured before they disappear from the
node's recent fork state. This improves observed coverage; it cannot establish a
complete network census or a pool's true orphan rate.

The separate Rust `orphan-collect` service writes migration-035 tables:
`captured_blocks`, `block_capture_receipts`, and `block_capture_observers`.
The serving node validates consensus; the collector verifies payload integrity
and matching node/database network identity. It never writes canonical blocks,
transactions, balances, or indexer checkpoints. Temporary files are removed only
after database commit; failures retain them for retry. Full buffers stop capture
visibly until storage/database recovery. Duplicate deliveries use block hashes
and observer/hash receipt keys.

The rate query uses a single database snapshot and deduplicates both sources.
A capture counts only when its height exists in the indexed chain and its hash
is not canonical. Ahead-of-indexer captures remain unclassified. A restored hash
stops counting without deleting its evidence. If both sources contain a hash,
archive miner attribution takes precedence. Invalid and external-only archive
reports remain excluded. Pool Unknown remains included. Existing orphan-detail
pages still expose the indexer's transaction archive; captured evidence does not
claim complete archived transactions or create artificial fork events.

Windows remain half-open block-header timestamp intervals, with fractions in the
API and percentages in the UI. `coverage` remains unverified with unknown
historical collection start and unverified uptime. `capture.startedAt` separately
identifies the start of this additional source. `capture.status=collecting` means
at least one observer reported a connected stream within 45 seconds and no
undelivered records; it is not proof of complete delivery. API caching can add
30 seconds to visible status changes. Saved evidence remains counted on outages.

Keep all block metadata and observer receipts. Clear only redundant raw bodies
of canonical matches more than 500 indexed heights behind the tip, in batches
of 64; keep competing-block bodies. Receipt times are collector observations,
not miner timestamps or the earliest network arrival.

Rollout order: migration 035 on mainnet/testnet, separate collector service and
fresh receipt checks, frontend supporting both method versions, then API v2.
Crosslink collection is excluded. Rollback restores the previous API reader and
stops the collector, preserving additive tables and unacknowledged files.
