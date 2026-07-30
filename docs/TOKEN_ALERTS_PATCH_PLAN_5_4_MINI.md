# Token Alerts Patch Plan Confirmation for GPT-5.4 Mini

Status: confirmed as a constrained follow-up to the GPT-5.4 core plan.

Date: 2026-07-30

Canonical architecture:

```text
docs/TOKEN_ALERTS_PATCH_PLAN_5_4.md
```

GPT-5.4 Mini must read the canonical plan before editing. If this document and
the canonical plan differ, the canonical GPT-5.4 plan wins.

## 1. Confirmed Scope

GPT-5.4 Mini may implement or verify only these isolated areas:

1. Pure candidate normalization and boundary helpers.
2. GMGN total-fees extraction for Token Alerts.
3. Top-holder filtering and display formatting.
4. Telegram alert message formatting and GMGN link rendering.
5. Token Alerts config defaults, bounds, nested mapping, and whitelist entries.
6. Focused unit tests and static command/menu assertions.
7. README, runbook, and environment documentation.

Locked thresholds:

```text
Volume 5m >= USD 100,000
Market cap > USD 100,000
GMGN total fees >= 10 SOL
Age since migration/open <= 30 minutes
One successful alert per mint
```

## 2. Not Authorized

GPT-5.4 Mini must not:

- Change the service timer or in-flight scan lifecycle without GPT-5.4 review.
- Wire startup auto-resume or graceful shutdown independently.
- Change `/autoscreen`, WATCH, deploy queue, Jupiter, or Meteora behavior.
- Change existing GMGN pool-screening thresholds.
- Reuse `gmgnMinTotalFeesSol` for Token Alerts.
- Modify the existing pool-screening `extractTotalFeesSol()` helper.
- Add npm dependencies or spawn `gmgn-cli`.
- Scrape the GMGN website.
- Add new hard gates beyond the confirmed four eligibility thresholds.

## 3. Safe File Set

Default Mini-owned files:

```text
src/alerts/tokenAlerts.js
src/config.js
user-config.example.json
tests/token-alerts.test.js
tests/config.test.js
tests/command-registry.test.js
README.md
DEPLOYMENT_RUNBOOK.md
env.example
```

`src/index.js` and `src/utils/gmgn.js` remain GPT-5.4-owned unless GPT-5.4
explicitly hands off a narrow, line-level task.

Do not edit a file concurrently with GPT-5.4. Apply patches sequentially and
re-read the latest file before editing.

## 4. Mandatory Mini Tests

Mini coverage must include:

1. Volume exactly USD 100,000 passes.
2. Market cap exactly USD 100,000 fails.
3. GMGN total fees exactly 10 SOL pass.
4. Missing or invalid total fees fail closed.
5. `total_fee` takes precedence over fallback total-fee fields.
6. `trade_fee` is not accepted as total fees.
7. Age exactly 30 minutes passes.
8. Unknown age fails closed.
9. Pool/vault/exchange holder rows are excluded from TH.
10. GMGN names and symbols are HTML escaped.
11. GMGN links use the validated Solana mint.
12. Token Alerts nested config keys resolve correctly.
13. Existing pool GMGN threshold defaults remain unchanged.

Focused verification:

```bash
node --test --test-concurrency=1 \
  tests/token-alerts.test.js \
  tests/config.test.js \
  tests/command-registry.test.js
```

## 5. Review Checklist

Before handing the Mini patch back to GPT-5.4:

- Confirm no deploy or position-management file changed.
- Confirm no existing GMGN screening key changed.
- Confirm `tokenAlertsMinTotalFeesSol` is independent and defaults to 10.
- Confirm failed/missing token info cannot produce an alert.
- Confirm optional holder failure still allows an alert with `TH: N/A`.
- Confirm no duplicate Telegram command regex was introduced.
- Run `git diff --check`.

## 6. Completion Boundary

GPT-5.4 Mini completion means the assigned isolated patch and focused tests pass.
It does not mean the Token Alerts feature is production-ready.

GPT-5.4 must still review:

- GMGN request construction.
- Timer and concurrency behavior.
- Persistent dedupe writes.
- Telegram send-success semantics.
- Startup/shutdown lifecycle.
- Full regression test results.

## 7. Confirmation

The GPT-5.4 Mini plan is confirmed for execution only within the constraints in
this document. Any required change outside this boundary must be returned to
GPT-5.4 instead of being implemented speculatively.
