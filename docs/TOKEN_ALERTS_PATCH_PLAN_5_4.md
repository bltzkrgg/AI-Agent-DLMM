# Token Alerts Patch Plan for GPT-5.4

Status: confirmed for GPT-5.4 execution. No runtime behavior is changed by this
document.

Date: 2026-07-30

GPT-5.4 Mini follow-up scope is confirmed separately in
`docs/TOKEN_ALERTS_PATCH_PLAN_5_4_MINI.md`. This document remains the canonical
architecture and behavior contract.

## 1. Objective

Add an independent, read-only Telegram token alert service backed by GMGN Solana
market data.

An alert is eligible only when all of these conditions are true:

1. GMGN rolling 5-minute volume is at least USD 100,000.
2. Current market cap is strictly greater than USD 100,000.
3. GMGN total fees are at least 10 SOL.
4. Token age is at most 30 minutes from DEX migration/open time.
5. The mint has not already produced a successful alert.

The feature must not:

- Add the token to WATCH.
- Add the token to the deploy queue.
- Trigger Jupiter simulation.
- Trigger Meteora deployment.
- Change existing pool autoscreen behavior.
- Add a new npm dependency or spawn `gmgn-cli` from the bot process.
- Add speculative liquidity, wash-trading, holder, or bundler hard gates.

## 2. Locked Product Decisions

These decisions are already confirmed and must not be reinterpreted during
implementation.

| Setting | Locked value |
|---|---:|
| Chain | Solana only |
| Source | GMGN OpenAPI |
| Volume window | 5 minutes |
| Minimum volume | `>= 100000` USD |
| Minimum market cap | `> 100000` USD |
| Minimum GMGN total fees | `>= 10` SOL |
| Maximum token age | `<= 30` minutes |
| Poll interval | 60 seconds |
| Maximum alerts per scan | 5 |
| Duplicate policy | One successful alert per mint |
| Startup behavior | Auto-start when persisted config is enabled |
| Capital action | None |
| GMGN link | `https://gmgn.ai/sol/token/{mint}` |

Important boundary behavior:

- Volume exactly `100000` passes.
- Market cap exactly `100000` fails.
- Total fees exactly `10` SOL pass.
- Age exactly 30 minutes passes.
- Missing or invalid age fails closed.
- Missing or invalid volume/market cap fails closed.
- Missing or invalid total fees fail closed.
- A failed Telegram send must not mark the mint as alerted.

## 3. Canonical Age Rule

Use the first valid positive timestamp in this order:

```text
migrated_timestamp
open_timestamp
creation_timestamp
```

The implementation must not use the current scan time as a fallback age. If no
valid source timestamp exists, reject the candidate as `AGE_UNKNOWN`.

Reason: the user wants new DEX tokens. Migration/open time is more relevant than
mint creation time for launchpad tokens.

## 4. Proposed Telegram Output

Telegram messages use HTML parse mode and must escape all GMGN-provided text.

```text
💊 Gt8JhihdercHUn6nf8Xs3SFf1mSHFjUkjgSLWz7Dpump

┌ Rocky J. Squirrel (ROCKY)
├ USD:       $0.0001606
├ MC:        $157.2K 🟢
├ Vol 5m:    $143.4K 🟢
├ Fees:      78.34 SOL 🟢
├ Age:       17m
├ Seen:      just now
├ Dex:       PumpSwap
├ Dex Paid:  🟢
├ Holder:    Top 10: 🟡 19%
├ Flow:      Buy 61% | Sell 39%
└ TH:        9.4 | 3 | 2.1 | 2 | 1.9

Swaps 5m: 486 | Liquidity: $38.2K

🌐 GMGN
```

`GMGN` must be an HTML anchor to:

```text
https://gmgn.ai/sol/token/{mint}
```

Display rules:

- Use GMGN `volume` from the `interval=5m` rank response.
- Use GMGN `market_cap`.
- Use GMGN token-info `total_fee` as the primary total-fees field.
- `Seen` means first observed by this bot, not historical first trade time.
- `Flow` is computed from buy and sell counts when their sum is positive.
- Show `Flow: N/A` when buy/sell counts are unavailable.
- Show `TH: N/A` if holder enrichment fails.
- Do not fail the whole alert because holder enrichment failed.

DEX label mapping for the first patch:

| GMGN value | Telegram label |
|---|---|
| `pump_amm` | `PumpSwap` |
| `meteora_dlmm` | `Meteora DLMM` |
| `raydium` or `raydium_amm` | `Raydium` |
| `orca` | `Orca` |
| anything else | escaped raw value or `Unknown` |

`Dex Paid` is green when any of these GMGN fields indicate payment:

```text
dexscr_ad > 0
dexscr_update_link > 0
dexscr_boost_fee > 0
dexscr_trending_bar > 0
```

Otherwise display a red indicator.

Top-10 indicator:

| Top-10 concentration | Indicator |
|---|---|
| `<= 20%` | green |
| `> 20%` and `<= 30%` | yellow |
| `> 30%` | red |
| unavailable | gray / `N/A` |

## 5. GMGN API Contract

Extend the existing direct HTTP wrapper in `src/utils/gmgn.js`. Do not execute
the CLI as a subprocess.

### Trending request

```text
GET /v1/market/rank
chain=sol
interval=5m
order_by=volume
direction=desc
limit=100
min_volume=100000
min_marketcap=100000
max_created=30m
```

The server-side filters reduce response size, but local eligibility checks remain
mandatory because:

- `min_marketcap` is inclusive while the product rule is strict `>`.
- API behavior can drift.
- Invalid or missing fields must fail closed.

Expected wrapper:

```javascript
export async function getGmgnTrendingTokens({
  interval = '5m',
  limit = 100,
  minVolume = 100000,
  minMarketCap = 100000,
  maxCreated = '30m',
} = {})
```

Return a normalized array. Return `[]` on unavailable data; do not throw into the
runtime timer.

### Total-fees request

Reuse the existing token-info wrapper:

```text
GET /v1/token/info
chain=sol
address={mint}
```

```javascript
getGmgnTokenInfo(mint)
```

Run this request only after the candidate passes rank-data checks and the
preliminary dedupe check.

Add a Token Alerts-specific extractor:

```javascript
export function extractGmgnTotalFeesSol(tokenInfo)
```

Field precedence:

```text
total_fee
total_fees_sol
stat.total_fees_sol
fees.total_sol
fee.total_sol
```

Rules:

- Convert numeric strings to numbers.
- Accept only finite, non-negative values.
- `total_fee >= tokenAlertsMinTotalFeesSol` passes.
- Missing/invalid total fees fail closed as `TOTAL_FEES_UNKNOWN`.
- Values below the threshold fail as `TOTAL_FEES_BELOW_MIN`.
- Do not use `trade_fee` as a fallback; it is not the same field as total fees.
- Do not modify the existing pool-screening `extractTotalFeesSol()` as part of
  this patch. Changing it could alter existing GMGN pool-gate behavior.

### Holder request

```text
GET /v1/market/token_top_holders
chain=sol
address={mint}
limit=20
order_by=amount_percentage
direction=desc
```

Expected wrapper:

```javascript
export async function getGmgnTopHolders(mint, { limit = 20 } = {})
```

TH extraction rules:

- Include only wallet rows with `addr_type === 0`.
- Exclude rows with missing/non-positive `amount_percentage`.
- Exclude rows whose `exchange` field is non-empty.
- Sort descending by `amount_percentage`.
- Display the first five percentages.
- Do not include pool/vault rows such as `addr_type === 2`.

### Rate limiting

Reuse the existing serialized GMGN request queue and retry handling.

Do not use the existing 90-second address cache for the trending rank response.
A 90-second cache would make a 60-second alert loop stale. Either:

- Do not cache rank responses, or
- Add a separate rank cache with TTL no greater than 15 seconds.

Holder responses may use the existing 90-second cache because each mint should
only be enriched once.

## 6. Module Design

Create:

```text
src/alerts/tokenAlerts.js
```

Keep decision logic outside `src/index.js`. `index.js` should only wire Telegram,
configuration, startup, shutdown, and commands.

Recommended exports:

```javascript
export function getTokenReferenceTimestamp(candidate)
export function evaluateTokenAlertCandidate(candidate, config, nowMs)
export function extractGmgnTotalFeesSol(tokenInfo)
export function extractTopHolderPercentages(holderRows, limit = 5)
export function formatTokenAlertMessage(alert)
export function createTokenAlertService(deps)
```

`evaluateTokenAlertCandidate()` returns structured output:

```javascript
{
  eligible: true | false,
  reason: 'PASS'
    | 'INVALID_MINT'
    | 'VOLUME_BELOW_MIN'
    | 'MCAP_NOT_ABOVE_MIN'
    | 'TOTAL_FEES_UNKNOWN'
    | 'TOTAL_FEES_BELOW_MIN'
    | 'AGE_UNKNOWN'
    | 'TOKEN_TOO_OLD'
    | 'ALREADY_ALERTED',
  normalized: {
    mint,
    name,
    symbol,
    priceUsd,
    marketCapUsd,
    volume5mUsd,
    totalFeesSol,
    liquidityUsd,
    swaps5m,
    buys5m,
    sells5m,
    ageMin,
    referenceTimestamp,
    exchange,
    top10Pct,
    dexPaid
  }
}
```

Service dependencies should be injectable so tests do not call GMGN or Telegram:

```javascript
{
  fetchTrending,
  fetchTokenInfo,
  fetchHolders,
  sendAlert,
  getConfig,
  getState,
  setState,
  now
}
```

Service methods:

```javascript
start()
stop()
scanOnce({ source })
status()
```

Runtime requirements:

- One interval timer maximum.
- One in-flight scan maximum.
- `start()` is idempotent.
- `stop()` is idempotent.
- `scanOnce()` sorts qualifying candidates by volume descending.
- Process at most `tokenAlertsMaxPerScan`.
- Rank-data eligibility and preliminary dedupe run before token-info enrichment.
- Token info is mandatory because total fees are a hard gate.
- Holder enrichment occurs only after the total-fees gate passes.
- Holder enrichment remains optional; token-info enrichment does not.
- Persist `alertedAt` only after `sendAlert()` succeeds.
- One candidate failure must not abort the remaining scan.

## 7. Persistent State

Use `src/runtime/state.js`, not the in-memory notification store.

State key:

```text
tokenAlertsSeen
```

Shape:

```json
{
  "mintAddress": {
    "firstSeenAt": 1785399000000,
    "alertedAt": 1785399001000,
    "referenceTimestamp": 1785398200,
    "volume5mUsd": 143400,
    "marketCapUsd": 157200,
    "totalFeesSol": 78.34
  }
}
```

Rules:

- `firstSeenAt` is written when an otherwise eligible candidate is first seen.
- `alertedAt` is written only after Telegram succeeds.
- A mint with `alertedAt` must never alert again.
- Prune records older than 48 hours during scans.
- Pruning is safe because a token older than 30 minutes cannot qualify again.

Do not add SQLite or a new state file.

## 8. Configuration Patch

Add flat defaults to `src/config.js`:

```javascript
tokenAlertsEnabled: false,
tokenAlertsPollIntervalSec: 60,
tokenAlertsMinVolume5mUsd: 100000,
tokenAlertsMinMarketCapUsd: 100000,
tokenAlertsMinTotalFeesSol: 10,
tokenAlertsMaxAgeMin: 30,
tokenAlertsMaxPerScan: 5,
```

Add bounds:

| Key | Validation |
|---|---|
| `tokenAlertsEnabled` | boolean |
| `tokenAlertsPollIntervalSec` | 15 to 300 |
| `tokenAlertsMinVolume5mUsd` | 0 to 1,000,000,000 |
| `tokenAlertsMinMarketCapUsd` | 0 to 10,000,000,000 |
| `tokenAlertsMinTotalFeesSol` | 0 to 1,000,000 |
| `tokenAlertsMaxAgeMin` | 1 to 1440 |
| `tokenAlertsMaxPerScan` | 1 to 20 |

Add nested mapping:

```javascript
tokenAlerts: {
  enabled: 'tokenAlertsEnabled',
  pollIntervalSec: 'tokenAlertsPollIntervalSec',
  minVolume5mUsd: 'tokenAlertsMinVolume5mUsd',
  minMarketCapUsd: 'tokenAlertsMinMarketCapUsd',
  minTotalFeesSol: 'tokenAlertsMinTotalFeesSol',
  maxAgeMin: 'tokenAlertsMaxAgeMin',
  maxPerScan: 'tokenAlertsMaxPerScan',
}
```

Add all seven keys to `SETCONFIG_WHITELIST` with section `tokenAlerts`.

Update `user-config.example.json` with the seven defaults.

Do not silently reuse the existing generic `minVolume`, `minMcap`, or
`gmgnMinTotalFeesSol`. Those keys belong to the pool-screening pipeline. Token
Alerts must have independent thresholds and must not change pool eligibility.

## 9. Telegram and Lifecycle Integration

Patch `src/index.js`.

### Menu

Replace the currently empty generic `Alerts` section with `Token Alerts`.

Add:

```text
/tokenalerts - status
/tokenalerts on
/tokenalerts off
/tokenalerts scan
```

Add a `Token Alerts` button to the main command panel and config section menu.

Section detail must show:

```text
Status
Source: GMGN / Solana
Minimum volume 5m
Minimum market cap
Minimum GMGN total fees
Maximum token age
Polling interval
Maximum alerts per scan
```

### Command behavior

`/tokenalerts` and `/tokenalerts status`:

- Show persisted config state and actual runtime state.
- Show threshold values.
- Do not start or stop anything.

`/tokenalerts on`:

- Persist `tokenAlertsEnabled=true`.
- Start the runtime idempotently.
- Run one immediate scan.
- Report that the feature is read-only.

`/tokenalerts off`:

- Persist `tokenAlertsEnabled=false`.
- Stop the runtime timer.
- Do not clear dedupe state.

`/tokenalerts scan`:

- Run one immediate scan even if the recurring runtime is disabled.
- Respect all eligibility and dedupe rules.
- Return a compact summary: fetched, eligible, alerted, skipped, failed.

### Startup

If `tokenAlertsEnabled=true`, start the token alert service during boot.

This intentionally differs from capital-moving autoscreen startup policy. Token
alerts are read-only and should recover automatically after a VPS restart.

Startup must not block wallet reconciliation or Telegram activation if GMGN is
temporarily unavailable.

Add this status line to the activation message:

```text
Token Alerts: ON (5m vol >= $100K, MC > $100K, fees >= 10 SOL, age <= 30m)
```

### Shutdown

Call `stopTokenAlerts()` before `bot.stopPolling()`.

`/stop` remains scoped to discovery/deploy and does not change the persisted
token-alert setting. `/tokenalerts off` is the explicit control.

## 10. File Ownership

### GPT-5.4 Mini Safe Tasks

GPT-5.4 Mini may implement these isolated tasks:

1. Add pure candidate normalization and eligibility helpers.
2. Add TH extraction and formatting helpers.
3. Add Telegram message formatter.
4. Add config defaults, bounds, nested mapping, whitelist entries, and example
   config.
5. Add focused unit tests for pure logic and config.
6. Update command-registry source assertions after the core command exists.
7. Update documentation.

GPT-5.4 Mini must not independently:

- Wire startup/shutdown lifecycle.
- Change existing autoscreen behavior.
- Modify deploy, WATCH, or queue code.
- Add retry loops outside the shared GMGN wrapper.
- Change GMGN safety thresholds used by pool screening.
- Refactor `src/index.js` beyond the exact Token Alerts UI assertions assigned.

### GPT-5.4 Core Tasks

GPT-5.4 owns:

1. Extend the GMGN wrapper with rank and holder routes while reusing token info.
2. Implement service timer, in-flight guard, error isolation, and state writes.
3. Wire the service into Telegram commands.
4. Wire startup auto-resume and graceful shutdown.
5. Review all Mini patches for boundary correctness.
6. Run the full regression suite and live read-only smoke test.

## 11. Recommended Execution Order

Avoid parallel edits to `src/config.js` and `src/index.js`.

### Patch A: GPT-5.4 Mini - Pure Core

Files:

```text
src/alerts/tokenAlerts.js
tests/token-alerts.test.js
```

Scope:

- Implement pure normalization, age, rank eligibility, total-fees extraction,
  holder filtering, DEX mapping, paid flag, and formatting.
- Use dependency injection placeholders for service dependencies.
- Do not import `src/index.js`.

Verify:

```bash
node --test --test-concurrency=1 tests/token-alerts.test.js
```

### Patch B: GPT-5.4 Mini - Configuration

Files:

```text
src/config.js
user-config.example.json
tests/config.test.js
```

Scope:

- Add only the seven locked config keys.
- Add `tokenAlerts.*` nested resolution.
- Fill the Token Alerts config section.

Verify:

```bash
node --test --test-concurrency=1 tests/config.test.js
```

### Patch C: GPT-5.4 - GMGN and Runtime Service

Files:

```text
src/utils/gmgn.js
src/alerts/tokenAlerts.js
tests/token-alerts.test.js
```

Scope:

- Add rank and holder API wrappers and reuse `getGmgnTokenInfo()`.
- Complete runtime service behavior.
- Apply the mandatory 10 SOL total-fees gate before optional holder enrichment.
- Reuse serialized rate limiting.
- Ensure rank data is not cached for 90 seconds.

Verify:

```bash
node --test --test-concurrency=1 tests/token-alerts.test.js
```

### Patch D: GPT-5.4 - Telegram and Lifecycle

Files:

```text
src/index.js
tests/command-registry.test.js
tests/reconcile-startup.test.js
tests/shutdown-hardening.test.js
```

Scope:

- Register `/tokenalerts`.
- Add buttons and section detail.
- Add startup auto-resume.
- Add shutdown cleanup.
- Keep autoscreen behavior unchanged.

Verify:

```bash
node --test --test-concurrency=1 \
  tests/command-registry.test.js \
  tests/reconcile-startup.test.js \
  tests/shutdown-hardening.test.js
```

### Patch E: GPT-5.4 Mini - Documentation and Static Audit

Files:

```text
README.md
DEPLOYMENT_RUNBOOK.md
env.example
```

Scope:

- Document commands and thresholds.
- Clarify that `GMGN_API_KEY` is required.
- Clarify that Token Alerts never deploy.
- Do not change runtime code.

## 12. Required Unit Tests

Add these named tests or equivalent:

1. `volume exactly 100k passes`.
2. `volume below 100k fails`.
3. `market cap exactly 100k fails strict threshold`.
4. `market cap above 100k passes`.
5. `total fees exactly 10 SOL pass`.
6. `total fees below 10 SOL fail`.
7. `missing total fees fail closed`.
8. `root total_fee takes precedence over fallback fee fields`.
9. `trade_fee is not accepted as total fees`.
10. `age exactly 30 minutes passes`.
11. `age over 30 minutes fails`.
12. `migration timestamp takes precedence over open and creation`.
13. `open timestamp is fallback when migration is unavailable`.
14. `unknown age fails closed`.
15. `already alerted mint is skipped`.
16. `holder extraction removes pool and exchange rows`.
17. `holder enrichment failure renders TH as N/A`.
18. `Dex Paid is green when any paid field is positive`.
19. `GMGN-provided name and symbol are HTML escaped`.
20. `GMGN link contains only the validated Solana mint`.
21. `failed Telegram send does not persist alertedAt`.
22. `successful Telegram send persists alertedAt`.
23. `scan processes no more than maxPerScan`.
24. `second concurrent scan is rejected by in-flight guard`.
25. `start and stop are idempotent`.
26. `expired dedupe records are pruned`.
27. `token alert config nested keys resolve correctly`.
28. `/tokenalerts` regex is registered once`.
29. `startup resumes token alerts only when enabled`.
30. `shutdown stops token alert timer`.
31. `autoscreen startup policy remains unchanged`.

## 13. Live Read-Only Smoke Test

Run only after unit tests pass.

Use a non-production Telegram destination or temporarily inject a log sender.

Checklist:

1. Query GMGN `interval=5m` with the locked thresholds.
2. Confirm no token older than 30 minutes reaches the formatter.
3. Confirm market cap exactly USD 100,000 would be rejected locally.
4. Confirm a token with total fees below 10 SOL is rejected.
5. Confirm a token with total fees exactly 10 SOL passes.
6. Confirm holder pool/vault rows are absent from TH.
7. Confirm the GMGN anchor opens:
   `https://gmgn.ai/sol/token/{mint}`.
8. Run the same scan twice and confirm the second scan emits no duplicate.
9. Restart the process with `tokenAlertsEnabled=true` and confirm auto-resume.
10. Confirm no WATCH, deploy queue, Jupiter, or Meteora function is called.

Do not use a wallet private key for this smoke test beyond what the existing bot
startup currently requires. No trade or swap command is part of this feature.

## 14. Full Verification

After all patches:

```bash
npm run lint
npm test
```

Then inspect:

```bash
git diff --check
git status --short
```

Expected outcome:

- No lint errors.
- All existing tests pass.
- New token alert tests pass.
- No new dependency.
- No changes to deploy transaction code.
- No changes to existing GMGN pool-screening thresholds.

## 15. Acceptance Criteria

The patch is complete only when all criteria are true:

- `/tokenalerts on|off|status|scan` works.
- Token Alerts has its own Telegram menu/config section.
- Only Solana tokens are queried.
- Volume uses the GMGN 5-minute interval.
- Volume `>= 100000` is enforced locally.
- Market cap `> 100000` is enforced locally.
- GMGN total fees `>= 10 SOL` are enforced locally.
- Missing or invalid total fees are rejected.
- Age `<= 30m` is enforced locally using the canonical timestamp order.
- Unknown age is rejected.
- Each mint alerts successfully at most once.
- Dedupe survives process restart.
- Telegram send failure remains retryable.
- TH excludes pool/vault/exchange rows.
- GMGN website link is clickable and points to the mint.
- Enabling alerts cannot deploy capital.
- Existing `/autoscreen`, WATCH, queue, and shutdown tests remain green.

## 16. Stop Conditions

Pause implementation and escalate to GPT-5.4 if any of these occur:

- GMGN rank response no longer contains a usable token timestamp.
- GMGN changes auth requirements for `/v1/market/rank`.
- The rank route reports 5-minute volume with semantics inconsistent with the
  requested rolling 5-minute threshold.
- Telegram send success cannot be distinguished from failure.
- Implementing the feature would require touching deploy or position-management
  code.
- Existing user changes conflict with `src/config.js` or `src/index.js`.

Do not work around these conditions by scraping the GMGN website.

## 17. GPT-5.4 Execution Confirmation

GPT-5.4 is authorized to execute the core implementation described in this
document, subject to the stop conditions above.

Execution must remain surgical:

- Treat this document as the source of truth for thresholds and boundary rules.
- Keep Token Alerts read-only and independent from autoscreen/deploy.
- Do not change existing pool-screening thresholds or transaction paths.
- Review the Mini follow-up against the completed core diff before accepting it.
- Do not mark implementation complete until the full acceptance criteria pass.
