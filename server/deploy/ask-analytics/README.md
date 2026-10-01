# Ask replica analytics — operator gate

This is the first restricted analytics slice, disabled unless explicitly
configured. It is not arbitrary SQL or a direct model database connection.

## Implemented contract

`POST /v1/ask/chat` can select an analytics plan when both paid Ask and
`ASK_ANALYTICS_ENABLED=true` are configured. Plans allow one reviewed metric,
inclusive completed UTC dates (at most 366 days), day/week/month grouping,
newest/highest/lowest ordering and 1–25 returned buckets. Counts exclude coinbase
and sum; balances take the last observed snapshot in each bucket. Weeks start
Monday. Edge buckets can be partial. Missing snapshots are not zero; rankings
are explicitly over observed days. Source: `public.privacy_trends_daily`, through
the only granted view `ask_public.daily_v1`. Historical counts are maintained
snapshots, not freshly replayed transactions. Exact zatoshis stay decimal strings.

The AI receives a public metric catalogue, validated results and fact placeholders;
it never receives the database password, SQL, private tables, filesystem or shell
tools. SQL is compiled exclusively from server constants and bound parameters.
No expressions, arbitrary identifiers, joins, functions, URLs or SQL text can be
submitted. Existing fixed charts and block/transaction tools remain available;
they are not replaced by this initial dataset.

## Independent boundaries

- Dedicated `ask_analytics_reader`, no memberships or elevated role attributes.
  Only SELECT on the public view; a non-login view owner has only explicitly
  granted source columns. Do not reuse `zcash_user` or `REPLICA_DATABASE_URL`.
- Every request checks standby recovery, replay age (maximum 120 seconds),
  role identity/permissions, PUBLIC and column grants, schemas, sequences and
  callable non-system SECURITY DEFINER functions. Any failed check rejects the
  query. Promotion and replica failure never fall back to primary.
- Read-only repeatable-read transaction, server 3-second statement deadline,
  500ms lock deadline, 1MB work_mem, role 16MB temp-file bound, 2 login connections.
  Overall execution deadline 10 seconds, 25 rows, 16KiB raw result cap. Failed or
  cancelled sessions are discarded. PostgreSQL timeouts also bound remaining
  server work after disconnect.
- Redis atomic admission: maximum 2 analytics executions across instances and
  explicit daily query allowance (1–10,000). Leases expire after 30 seconds; no
  refunds for failed queries. Redis unavailable means no query. Existing Ask
  bot/IP admission and per-provider-call money reservations still apply.
- Separate loopback worker holds the reader DSN and has no provider, primary DB,
  RPC or SSH credentials. The public API can submit only validated plans using
  a private service token. No raw-SQL endpoint is exposed. The worker refuses
  root startup; the supplied systemd unit adds a dynamic user, a read-only
  filesystem, hidden home directories and CPU/RAM limits. These host controls
  require actual operator installation and verification.
- Native table renderer uses React text escaping, not generated HTML or JS.
  Narratives use exact server fact placeholders; no model-supplied numbers or links.

These controls constrain model behavior; they do not establish immunity to all
vulnerabilities. Read-only alone does not prevent every server effect or resource
attack. PostgreSQL's built-in metadata/function defaults are not globally revoked:
the no-raw-SQL compiler is essential. Do not expose the reader DSN or a generic SQL
endpoint. A physical replica still contains operational data.

## Before enabling production

1. Review `provision.sql` and primary/standby source at the intended release SHA.
   Apply the additive script on primary only, verify WAL replay. It aborts if
   roles/schema already exist; do not silently reuse them. It changes no shared
   PUBLIC grants. Audit any existing PUBLIC grants separately rather than
   automatically revoking permissions needed by other services.
2. Set the reader password privately, with SCRAM and credential rotation. Restrict
   its login in pg_hba/network rules to the analytics service and standby only;
   deny reader login on primary. Install the separate non-root analytics worker with
   no SSH, RPC, indexer, writer or admin credentials, bounded CPU/RAM and no
   unnecessary outbound network. Stage the reviewed worker files/dependencies
   under `/opt/zecblock-analytics`, outside root's home, and install the provided
   `zecblock-ask-analytics.service`. Verify its effective systemd restrictions;
   unit-file presence is not proof of runtime isolation. Host egress rules should
   allow only loopback, the private standby and quota Redis endpoints.
3. Supply only a private standby DSN as `ASK_ANALYTICS_DATABASE_URL`, using the
   exact reader role and no URL query/options. Use a TLS/private tunnel appropriate
   to that topology; do not put a public plaintext Postgres connection in service
   config. Worker-only environment: `ASK_ANALYTICS_ENABLED=true`, reader DSN,
   `ASK_ANALYTICS_REDIS_URL`, `ASK_ANALYTICS_SERVICE_KEY` (random 32+ characters),
   `ASK_ANALYTICS_DAILY_QUERY_LIMIT` (e.g. 200 for beta), optional
   `ASK_ANALYTICS_PORT` (default 3015). Do not inherit the API/indexer environment.
   Public API receives only `ASK_ANALYTICS_ENABLED=true`,
   `ASK_ANALYTICS_SERVICE_URL=http://127.0.0.1:3015/` and the shared service key.
   Do not pass the reader DSN to the API. Do not proxy the worker to public ingress.
4. Execute `node server/api/scripts/audit-ask-analytics.js` with the worker-only
   environment and actual login on standby; test primary refusal,
   lag/unavailable Redis and permissions. Review replica disk/WAL headroom and
   replay conflicts. Budget counts must use a durable, access-restricted Redis;
   reset/eviction loses quotas, so monitor persistence and disallow eviction of
   allowance keys. Reader config alone must not advertise analytics as healthy.
5. Rotate the previously shared testing provider key before public activation.
   Restrict its provider endpoints/model and configure provider hard spend caps
   plus reviewed `ASK_MAX_*` rate bounds, app daily/monthly budget and Turnstile.
   Block bypass of the trusted proxy and verify `req.ip` forwarding cannot be
   forged. API `trust proxy=1` assumes exactly one trusted ingress.
6. Verify actual model intent/answer quality in supported languages and misleading
   prompts using small paid tests, then canary real replica execution. Unit/model
   fixtures and local PG14 tests are not production-role or live-model passes.

No production provisioning, deployment or AI activation is performed by tests.
Do not claim unrestricted query coverage or saved dashboards: those are later
milestones after this layer is verified under its actual deployment boundaries.

## Verification

```
node --test server/api/test/v1/ask-analytics.test.js
ASK_TEST_POSTGRES=1 node --test server/api/test/v1/ask-analytics-postgres.test.js
```

The opt-in integration test uses only local `/tmp` PostgreSQL, creates a disposable
database, refuses existing reader/owner roles, and removes its own fixtures. It
proves database permission denials even with the user-changeable read-only default
disabled, and tests PUBLIC/column/SECURITY DEFINER leaks and primary refusal.
