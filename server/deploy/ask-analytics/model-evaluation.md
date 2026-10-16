# Private Ask model evaluation

These operator tools compare explicit model candidates through the actual private
Ask API, queued analytics worker and narrative path. They do not change the
serving model, public capabilities, SQL policy, credentials or existing quotas.
`ask-model-profile.js` is the single source for evaluation identities:
`mini-observed` selects `gpt-4o-mini` without reasoning effort; `luna-candidate`
selects the API model `gpt-6-luna` with `reasoning_effort=none`. These are not Codex
app model settings. The prior owner-authorized Luna probe is historical evidence,
not approval to silently change the current `ASK_MODEL`.

## Prerequisites

- Use a reviewed exact application commit and Node 22 with the API dependencies.
  Keep the API and worker source reconciled; record optional local test skips.
- Run `server/api/scripts/ask-eval-preview.js` only as the non-root private API
  service account on server loopback `127.0.0.1:3007`, without public ingress.
  Keep the existing protected server environment file and key on the server;
  never copy credentials to a laptop, command output or this document.
- Explicitly set `ASK_EVAL_ISOLATED=true`, `ASK_PRIVATE_PREVIEW=true`,
  `ASK_EVAL_PROFILE`, the verified `ASK_EVAL_REVISION`, and
  `ASK_EVAL_PROVIDER_ATTEMPT_LIMIT=12`. Set only this isolated process's
  `ASK_MODEL`/`ASK_REASONING_EFFORT` to its selected profile. Keep the normal
  private API configuration unchanged.
- Reuse the existing private Redis admission/spend ledger and worker credentials.
  Required research flags are `ASK_ANALYTICS_ENABLED`, `ASK_RESEARCH_ENABLED`,
  `ASK_RESEARCH_EXTENDED`, and `ASK_RESEARCH_JOBS_ENABLED` set to `true`, with
  `ASK_ANALYTICS_STORE=logical_public_core`. `ASK_ANALYTICS_SERVICE_URL` and
  `ASK_ANALYTICS_SERVICE_KEY` stay in the protected server environment.
  Do not reset, bypass or raise the existing daily/monthly/call/IP allowances.
- The isolated wrapper pins outbound OpenAI `service_tier=default` before
  dispatch, selecting Standard processing. Omitting the field would mean
  `auto`, which follows project settings. The normal serving route is unchanged;
  the small additional field fits the existing reservation overhead allowance.

The wrapper attests its actual provider/model/effort, unique process `runId`,
revision, critical-serving-source SHA-256 digest, hard attempt limit and actual
outbound-attempt counter at `GET /__ask_eval/runtime`. It refuses a mismatched
outbound model and increments before dispatch, including failed or uncertain
provider requests. The client requires a fresh zero counter and stable source,
identity and cap. Lost attestation fails the run and reports the attempt count as
unknown; it never substitutes HTTP request counts for provider attempts.

## Pricing reservations checked 2026-10-16

Official Standard prices per million tokens: Luna input **$0.10**, output
**$0.50**; mini input **$0.15**, output **$0.60**. Luna long-context input/output
are **$0.20/$0.75**; long-context cache writes are **$0.25**. Conservative common
reservation bounds are `ASK_MAX_INPUT_USD_PER_MILLION=0.25` and
`ASK_MAX_OUTPUT_USD_PER_MILLION=0.75` for these Standard global-endpoint runs.
These are upper reservation rates, not measured charges. Fast/regional modes
require separate bounds. Existing per-request body and output limits still apply.

Sources: [Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna),
[mini model](https://developers.openai.com/api/docs/models/gpt-4o-mini),
[pricing](https://developers.openai.com/api/docs/pricing),
[Chat Completions processing tiers](https://developers.openai.com/api/reference/python/resources/chat/subresources/completions/methods/create),
[evaluation guidance](https://developers.openai.com/api/docs/guides/evals).
The mini model page currently marks it deprecated; it remains an explicit
comparison profile here, not a recommendation or a serving-default change.

## Run and interpret

From the checkout root, the default command validates fixed cases and compiles
reference/verification SQL with **zero network or provider calls**:

```sh
node server/api/scripts/evaluate-ask-research.js
```

Only after operator authorization and wrapper preparation, run the same selected
case IDs separately for each model, each in a fresh isolated wrapper process:

```sh
ASK_EVAL_API_URL=http://127.0.0.1:3007/v1/ask node server/api/scripts/evaluate-ask-research.js --allow-paid --profile=luna-candidate --max-provider-calls=12
```

Use `--profile=mini-observed` for the comparison. Optional fixed IDs are
`annual_2025`, `shielded_baseline`, `fee_units`, `ambiguous_growth` and
`private_ownership`. There are at most six selected cases and twelve **actual**
provider attempts; no new retry is introduced. The client pauses thirty-one seconds between live cases to preserve existing
per-IP admission, without simulated identities or quota resets. The API retains
its existing single SQL repair. Research cases need room for selection, possible repair and
explanation; insufficient remaining allowance fails rather than overruns it.
A subset's acceptance applies only to that selected subset.

The research verifier re-executes candidate and reviewed reference SQL in one
admitted SELECT, so both use the same database snapshot. It rejects changed
initial tables, truncation, incomplete dates and missing measures. It compares
exact-decimal date-keyed measure vectors independently of column aliases/order;
averages/percentages use two decimal places and the fee uses eight. It checks
annual counts/share/partial rolling windows, a preceding-observation percentage
baseline, and ZEC/missing-fee semantics. Clarification and private-fact cases must
avoid a data query and provide a useful clarification or explicit unavailability.

Every selected case must pass both result and requested-finding checks for
`accepted=true`. Generic table receipts are reported as UX failures even when
SQL values are correct. Finding checks are bounded deterministic checks, not a
proof of every sentence, all SQL semantics, causal explanations, model
nondeterminism, historical completeness or public launch readiness. Review
unusual prose and repeat the fixed questions before choosing a serving model.

Reports contain fixed case IDs, pass/failure codes, counts, timing and attested
model/source identity. They do not retain questions, SQL, raw rows, capabilities,
provider bodies or credentials. Cases are reviewed operator fixtures; never build
an evaluation corpus from raw visitor questions or SQL. Record measured outcomes,
exact source commit/digest, and remaining failures separately before rollout.
