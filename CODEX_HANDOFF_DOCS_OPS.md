# Codex Handoff — Docs/Ops
**Date:** 2026-04-19 | **Tests:** 65/65 ✅ | **Lint:** clean ✅

---

## Constraint: DO NOT TOUCH
```
src/agents/healerAlpha.js
src/agents/hunterAlpha.js
src/solana/meteora.js
```

Target files this sprint: `AGENT_EXECUTION_SCHEMA.md`, `DEPLOYMENT_RUNBOOK.md`,
`AGENT_QUICK_REFERENCE.txt`, `API_PROVIDERS.md`, `user-config.example.json`

---

## Canonical Code Table

### Exit — Main Loop (`healerAlpha.js:1322`)
Five and only five `triggerCode` values. `exitTrigger` = `closeReasonCode` (consistent).

| Code | Condition |
|------|-----------|
| `TRAILING_TAKE_PROFIT` | peak − current > trailingDropPct |
| `TAKE_PROFIT` | pnlPct >= takeProfitFeePct |
| `MAX_HOLD_EXIT` | positionAge >= maxHoldHours × 60 min |
| `OOR_BINS_EXCEEDED` | outOfRangeBins >= outOfRangeBinsToClose |
| `STOP_LOSS` | pnlPct < −stopLossPct |

### Exit — Watchdog Sub-loops (⚠️ `exitTrigger` ≠ `closeReasonCode`)

| exitTrigger | closeReasonCode | Source line |
|-------------|----------------|-------------|
| `GUARDIAN_ANGEL_DUMP` | `GUARDIAN_ANGEL_DUMP_EXIT` | healer:1966 |
| `ZOMBIE_EXIT` | `ZOMBIE_EXIT_${reason}` (dynamic) | healer:2037 |
| `TRAILING_TP_HIT` | `TAE_WATCHDOG_EXIT_${zone}` (dynamic) | healer:2126 |
| `SUPERTREND_FLIP` | `TAE_WATCHDOG_MOMENTUM_EXIT_${zone}` (dynamic) | healer:2184 |
| `OOR_BAILOUT` | `OOR_HARD_EXIT_WATCHDOG` | healer:2245 |
| `PANIC_EXIT_BEARISH_OOR` | `PANIC_EXIT_BEARISH_OOR` ✅ | healer:2377 |
| `PROFIT_PROTECTION` | `PROFIT_PROTECTION_BEARISH` | healer:2446 |

### Other Exits (operator-initiated)

| Code | Notes |
|------|-------|
| `MANUAL_CLOSE` | exitTrigger = closeReasonCode ✅ |
| `AGENT_CLOSE` | exitTrigger = closeReasonCode ✅ |
| `ZAP_OUT` | exitTrigger = closeReasonCode ✅ |

### Entry Block Codes — Hunter (`hunterAlpha.js`)

| Code | Condition | Source |
|------|-----------|--------|
| `REGIME_BEAR_DEFENSE` | classifyMarketRegime() === 'BEAR_DEFENSE' | hunter:713 |
| `CIRCUIT_BREAKER_ACTIVE` | runtime-state.json `hunter-circuit-breaker.pausedUntil` > now | hunter:960 |
| `FAIL_SAFE_UNRELIABLE_DATA` | `failSafeModeOnDataUnreliable=true` AND (!dataReliable OR !taReliable) | hunter:729 |
| `TREND_BEARISH` | supertrend.trend === 'BEARISH' | hunter entry eval |
| `ATR_LOW` | atrPct < minAtrPctForEntry | hunter entry eval |
| `FEE_VELOCITY_DOWN` | 3-sample feeTvlRatio descending | hunter entry eval |
| `HTF_NULL_STRICT_ATR` | history null AND atrPct < 2.0 | hunter:717 |

### Schema-only / Clarifications

| Code | Status | Rule |
|------|--------|------|
| `SL_CLUSTER_THRESHOLD_MET` | ⚠️ NOT in src (`rg src = 0`) | Side-effect only — SL cluster writes circuit breaker to runtime-state.json. Triggering SL close records `STOP_LOSS`. Never appears in exit_events DB. |
| `SL_COOLDOWN_ACTIVE` | Healer HOLD delay | Delays close decision inside healerAlpha. Does NOT block Hunter entry. |

---

## Deployment Profiles

Exact match to `user-config.example.json → _profiles`:

| Parameter | `conservative_live` | `balanced` | `aggressive_experimental` |
|-----------|--------------------|-----------|--------------------------:|
| `dryRun` | `false` | `true` | `false` |
| `deployAmountSol` | `0.25` | `0.5` | `1.0` |
| `maxPositions` | `1` | `3` | `5` |
| `stopLossPct` | `3` | `5` | `8` |
| `maxHoldHours` | `4` | `6` | `12` |
| `maxTvl` | `100000` | `500000` | `2000000` |
| `minVolumeTvlRatio` | `30` | `20` | `10` |
| `dailyLossLimitUsd` | `10` | `25` | `50` |

---

## Operator Playbook

### QC-1 — Circuit Breaker Tripped
```
DETECT:  runtime-state.json has hunter-circuit-breaker.pausedUntil key
         Telegram: "⚡ CIRCUIT BREAKER TRIPPED"
         logs: slCount >= slCircuitBreakerCount in window
NOTE:    SL_CLUSTER_THRESHOLD_MET will NOT appear in exit_events DB (schema-only)
FIRST 5: 1. Do NOT override
         2. /health → circuitBreaker: OPEN
         3. /positions history → last 3–5 exits for SL cluster
WAIT:    slCircuitBreakerPauseMin (default 60 min) — persists through restarts
VERIFY:  /health → circuitBreaker: CLOSED
         runtime-state.json: hunter-circuit-breaker key absent
MANUAL RESET: Delete hunter-circuit-breaker from runtime-state.json → restart
ESCALATE: Trips >3×/day → increase slCircuitBreakerCount (3→4)
```

### QC-2 — Stale Data / Unreliable Oracle
```
DETECT:  historySuccess: false in logs
         policy: 'FAIL_SAFE_UNRELIABLE_DATA' in logs
         /providers → DexScreener DEGRADED
ACTION:  No new entries (FAIL_SAFE blocks all if failSafeModeOnDataUnreliable=true)
         Exits continue on on-chain price — safe
RESUME:  historySuccess: true on next cycle → entry auto-resumes
ESCALATE: DexScreener down >30min AND Meteora price unreliable → /pause
```

### QC-3 — Swap Fail / manual_review
```
DETECT:  status='manual_review' in DB | "LIQUIDITY_TRAP" in logs
ACTION:  1. /pause
         2. sqlite3 positions.db "SELECT poolAddress,status FROM positions WHERE status='manual_review';"
         3. Verify on-chain via Meteora UI → manual close if open
         4. UPDATE positions SET status='closed' WHERE position_address='...'
RESUME:  /resume after manual_review count = 0
ESCALATE: Manual close fails → contact Meteora support with txHash
```

### QC-5 — Daily Drawdown Limit Breached
```
DETECT:  src/index.js:506 — dailyPnl < -cfg.dailyLossLimitUsd → Hunter paused
         Telegram: "⛔ DAILY LOSS LIMIT REACHED"
FIRST 5: 1. New entries auto-blocked (exits still fire)
         2. /status → check dailyLossUsd + open positions
         3. /positions history → identify loss source
RESUME:  Next UTC midnight (auto-reset) OR /resume if root cause confirmed
ESCALATE: 3 consecutive days → reduce deployAmountSol or stopLossPct
```

---

## Residual Risks

### P0 — Blocks live capital deployment

**P0-A: `SL_CLUSTER_THRESHOLD_MET` never written to exit_events**
- `rg "SL_CLUSTER_THRESHOLD_MET" src` = 0. Schema-only code.
- Runbook QC-1 detect instruction previously said to look for this in exit_events — incorrect. Fixed to detect via runtime-state.json key.
- Remaining gap: no analytics event fired when circuit breaker trips. Operator has no DB query to count cluster events.
- Fix: after `setRuntimeState('hunter-circuit-breaker')` at healer:1465, emit an analytics row with trigger=`SL_CLUSTER_THRESHOLD_MET` to a separate `circuit_breaker_events` table OR add a note field to the triggering STOP_LOSS exit row.

**P0-B: No integration test for entry→hold→exit cycle**
- All 65 tests unit-level, mocked deps.
- No test covers: pool discovered → deployed → healer cycle → DB status closed.

**P0-C: Zero real performance data**
- `strategy-library.json` performanceHistory = [] for all strategies.
- darwinScore / confidence have no signal at go-live.

### P1 — Degrades autonomy

**P1-A: Momentum-Proxy fallback unvalidated** (`oracle.js:317-327`)
- Activates when `historySuccess=false`. False-positive rate unknown.

**P1-B: PnL always uses `lp_agent` on divergence** (`pnl.js:17-44`)
- Divergence logged but lp_agent value always used. No hard fallback.

### P2 — Operator UX

**P2-A: `/claim_fees` not registered** — `/claim` exists at `src/index.js:1555`. `/claim_fees` will 404. Fix: register alias or update docs to use `/claim`.

**P2-B: No `/strategy_report` command** — performanceHistory accumulates but no read path.

---

## Codex Action Queue

### Sprint 1 — Verify & Harden

**1.1 Emit circuit breaker event to DB (P0-A)**
```
File: src/db/exitTracking.js  ← NOT a protected file
After: healer:1465 (setRuntimeState circuit breaker) fires
Add:   insert row into exit_events (or new circuit_breaker_events table)
       with trigger='SL_CLUSTER_THRESHOLD_MET', poolAddress, timestamp
Test:  unit test in tests/circuit-breaker-persist.test.js — assert row exists after cluster
```

**1.2 Integration test: position lifecycle (P0-B)**
```
File: tests/integration/position-lifecycle.test.js (new)
Cases: deploy → active | STOP_LOSS → closed | MAX_HOLD_EXIT → closed
       REGIME_BEAR_DEFENSE → no position | CIRCUIT_BREAKER_ACTIVE → no position
Constraint: mock closePositionDLMM + deployDLMM, no real RPC
```

**1.3 Verify dailyLossLimitUsd (P1-C)**
```
Confirmed: enforced at src/index.js:506
Action:    add unit test — mock dailyPnl < -limit → assert hunter call skipped
           check healer: exits must still fire when limit reached (they should)
```

### Sprint 2 — Signal Validation

**2.1 Momentum-Proxy vs Supertrend backtest (P1-A)**
```
File: scripts/backtestMomentumProxy.js (new, read-only diagnostic)
Input: 200 15m OHLCV candles from DexScreener for one real pool
Output: match rate, false-positive rate → scripts/backtest-results.json
```

**2.2 PnL hard fallback on divergence (P1-B)**
```
File: src/app/pnl.js  ← NOT a protected file
Fix:  if abs(lp_agent - sdk) / sdk > config.pnlDivergenceHardFallbackPct (default 10%)
      → use SDK value + log WARN
Test: divergence=15% → SDK value used
```

### Sprint 3 — Operator UX

**3.1 /claim_fees alias (P2-A)**
```
File: src/index.js
Find: '/claim' handler (~line 1555)
Add:  register '/claim_fees' pointing to same handler. No logic change.
```

**3.2 /strategy_report (P2-B)**
```
File: src/index.js
Add:  /strategy_report command
Read: strategy-library.json[].performanceHistory
Out:  per strategy: name | trades | win rate % | avg PnL % | confidence
Format: Telegram text message
```

---

## Verification

```bash
npm test          # must be 65/65 before + after each sprint task
npm run lint      # must be clean

# Confirm canonical codes consistent across docs
rg -n "SL_CLUSTER_THRESHOLD_MET|CIRCUIT_BREAKER_ACTIVE|FAIL_SAFE_UNRELIABLE_DATA|MAX_HOLD_EXIT|REGIME_BEAR_DEFENSE" \
  AGENT_EXECUTION_SCHEMA.md DEPLOYMENT_RUNBOOK.md AGENT_QUICK_REFERENCE.txt

# Confirm dailyLossLimitUsd enforcement location
rg -n "dailyLossLimitUsd" src/index.js
# Expected: line 506 — dailyPnl < -liveCfg.dailyLossLimitUsd

# Confirm SL_CLUSTER_THRESHOLD_MET not in src (schema-only)
rg "SL_CLUSTER_THRESHOLD_MET" src
# Expected: 0 results
```

---

## Reference Map

| Question | Go to |
|----------|-------|
| Why did hunter block? | AGENT_EXECUTION_SCHEMA.md → Entry Block Codes |
| Why did healer close? | AGENT_EXECUTION_SCHEMA.md → Exit Codes |
| exitTrigger vs closeReasonCode mismatch? | AGENT_EXECUTION_SCHEMA.md → Watchdog table |
| Circuit breaker tripped | DEPLOYMENT_RUNBOOK.md → QC-1 |
| Data stale / fail-safe | DEPLOYMENT_RUNBOOK.md → QC-2 |
| Daily loss limit | DEPLOYMENT_RUNBOOK.md → QC-5 + src/index.js:506 |
| Config profiles | user-config.example.json → `_profiles` block |
| AI model setup | API_PROVIDERS.md |
