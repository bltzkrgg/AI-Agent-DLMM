# Codex Handoff — LP Agent DLMM
**Date:** 2026-04-19 | **Status:** Engine complete, integration tests pending

---

## 1. What This Codebase Is

Autonomous Meteora DLMM liquidity-provision agent on Solana.

Two main agents:
- **Hunter** (`src/agents/hunterAlpha.js`) — scans pools, classifies market regime, deploys positions
- **Healer** (`src/agents/healerAlpha.js`) — monitors open positions, fires exit triggers, records performance

Key supporting modules:
- `src/strategies/strategyManager.js` — parses strategy parameters, resolves strategy from library
- `src/strategies/strategyHandler.js` — orchestrates deploy/close calls via Meteora SDK
- `src/runtime/state.js` — runtime key-value store, flushed to `runtime-state.json` (persists across restarts)
- `src/market/strategyLibrary.js` — `recordStrategyPerformance()` updates rolling performance in `strategy-library.json`

---

## 2. Current Engine State (DO NOT re-implement these — they are done)

| Feature | Where | Status |
|---------|-------|--------|
| `classifyMarketRegime()` gates all hunter entries | `hunterAlpha.js:708` | ✅ Done |
| `REGIME_BEAR_DEFENSE` hard-blocks entry | `hunterAlpha.js:713` | ✅ Done |
| Circuit breaker check at top of hunter loop | `hunterAlpha.js:960` | ✅ Done |
| `MAX_HOLD_EXIT` force-close after `maxHoldHours` | `healerAlpha.js:1137,1316,1324` | ✅ Done |
| `recordStrategyPerformance()` on every close | `healerAlpha.js:93` | ✅ Done |
| Circuit breaker state persisted to `runtime-state.json` | `healerAlpha.js:1465 + runtime/state.js` | ✅ Done |
| `parseStrategyParameters` derives `strategyType` from `deploy.strategyType` or `strategy.type` | `strategyManager.js` | ✅ Done |
| `Deep Fishing` added to `BASELINE_STRATEGIES` | `strategyManager.js` | ✅ Done |

**Test suite: 65/65 pass** (`npm test`)

---

## 3. Canonical Exit / Block Codes

These are the exact strings emitted in logs, Telegram, and DB. Do not invent aliases.

**Exit triggers (healerAlpha `exitTrigger` field):**
```
TRAILING_TAKE_PROFIT   peak - current > trailingDropPct
TAKE_PROFIT            pnlPct >= takeProfitFeePct
MAX_HOLD_EXIT          positionAge >= maxHoldHours × 60 min
STOP_LOSS              pnlPct < -stopLossPct
OOR_BINS_EXCEEDED      outOfRangeBins >= outOfRangeBinsToClose
IL_VS_HODL_EXIT        dailyFeeYieldPct < ilPct
LOW_FEE_YIELD_EXIT     fee stalled 2h+
VOLUME_COLLAPSE        vol24h / entryVol24h < volCollapseThresholdPct
ZOMBIE_FEE_STAGNATION  feeTvlRatio unchanged 3+ cycles
SL_CLUSTER_THRESHOLD_MET  slCount >= slCircuitBreakerCount (sets circuit breaker)
MANUAL_CLOSE           operator command
AGENT_CLOSE            AI reasoning close
ZAP_OUT                close + swap to SOL
```

**Entry blocked (hunterAlpha `policy` field):**
```
REGIME_BEAR_DEFENSE    classifyMarketRegime() === 'BEAR_DEFENSE'
CIRCUIT_BREAKER_ACTIVE hunter-circuit-breaker.pausedUntil > now (from runtime-state.json)
TREND_BEARISH          supertrend.trend === 'BEARISH'
ATR_LOW                atrPct < minAtrPctForEntry
FEE_VELOCITY_DOWN      feeTvlRatio 3-sample descending
HTF_NULL_STRICT_ATR    1h data missing + atrPct < 2.0
```

**Important distinction:**
- `SL_COOLDOWN_ACTIVE` = healer HOLD-delay only (delays close decision inside healer). Does NOT block hunter entry.
- Hunter entry block = `CIRCUIT_BREAKER_ACTIVE` (reads `hunter-circuit-breaker` key from runtime-state.json).

---

## 4. Config: 3 Deployment Profiles

Defined in `user-config.example.json` under `_profiles`. Active values are the flat keys below the `_profiles` block. Copy profile values to override:

| Parameter | Conservative Live | Balanced (default) | Aggressive Experimental |
|-----------|-------------------|-------------------|------------------------|
| `dryRun` | `false` | `true` | `false` |
| `deployAmountSol` | `0.25` | `0.5` | `1.0` |
| `maxPositions` | `1` | `3` | `5` |
| `stopLossPct` | `3` | `5` | `8` |
| `maxHoldHours` | `4` | `6` | `12` |
| `maxTvl` | `100000` | `500000` | `2000000` |
| `minVolumeTvlRatio` | `30` | `20` | `10` |
| `dailyLossLimitUsd` | `10` | `25` | `50` |

---

## 5. Residual Risks (Prioritized)

### P0 — Blocks live capital deployment

**P0-A: `SL_CLUSTER_THRESHOLD_MET` not verified as emitted**
- `healerAlpha.js:1465` sets the circuit breaker state but the exit code that gets recorded in `exit_events` needs verification
- Check: does the `closeReasonCode` / `exitTrigger` on the triggering SL close actually read `'SL_CLUSTER_THRESHOLD_MET'`? Or does it read `'STOP_LOSS'` (the individual SL) while circuit breaker is a side-effect?
- Action: grep `recordExitEvent` calls near `setRuntimeState('hunter-circuit-breaker')` — confirm `exitTrigger` value

**P0-B: No integration test for full entry→hold→exit cycle**
- All 65 tests are unit-level (mocked deps)
- No test verifies: pool discovered → position deployed → healer cycles → exit fires → DB status = closed
- Risk: silent contract breakage between hunter/healer/meteora/DB

**P0-C: Zero real performance data**
- `performanceHistory: []` for all strategies in `strategy-library.json`
- `darwinScore` and `confidence` adjustments have no signal to work from
- Agent enters live trading with 0 calibration baseline

### P1 — Degrades autonomy, not blocking

**P1-A: Supertrend signal accuracy unvalidated**
- Win rate unknown, false positive rate unknown
- Entry blindly trusts Supertrend BULLISH flip
- Action needed: backtest last 100+ 15m candles on a real pool

**P1-B: PnL source hierarchy untested under failure**
- 3 sources: LP Agent API → SDK → manual fallback
- If all error simultaneously: healer evaluates positions with stale PnL
- Action: add integration test that kills primary source and verifies fallback fires

**P1-C: Daily drawdown auto-pause behavior unverified**
- `dailyLossLimitUsd` check exists in config; verify hunter/healer actually read and enforce it
- Search: `dailyLossLimitUsd` usage in hunterAlpha.js and healerAlpha.js

### P2 — Operator UX, non-blocking

**P2-A: Telegram /claim_fees, /pause mid-trade, /override_range not implemented**
- REVIEW_SUMMARY.md flags these; currently only alerts + text commands
- QC-3 (manual review) requires manual DB edits — should be a Telegram command

**P2-B: No APY dashboard / real fee yield tracking**
- `performanceHistory` accumulates data but no read path for operator
- No `/apystats` or `/strategy_report` command

---

## 6. Codex Action List

Execute these in order. Each is independently mergeable.

### Sprint 1 — Verify & Harden (no new features)

**Task 1.1 — Confirm `SL_CLUSTER_THRESHOLD_MET` is correctly recorded (P0-A)**
```
File: src/agents/healerAlpha.js
Find:  the block near line 1457–1471 where setRuntimeState('hunter-circuit-breaker') is called
Check: what exitTrigger / closeReasonCode is passed to recordExitEvent() on the triggering SL close
Fix:   if it records 'STOP_LOSS' only, add a second recordExitEvent call (or note field) with
       trigger: 'SL_CLUSTER_THRESHOLD_MET' after the circuit breaker fires
Verify: unit test in tests/circuit-breaker-persist.test.js already covers persistence;
        add assertion that exit_events table contains 'SL_CLUSTER_THRESHOLD_MET' on cluster
```

**Task 1.2 — Integration test: full position lifecycle (P0-B)**
```
File: tests/integration/position-lifecycle.test.js (create new)
Scope: mock Solana/Meteora SDK calls (not real RPC)
Test cases:
  - pool discovered by hunter → position opened → DB status = 'active'
  - healer cycles → STOP_LOSS fires → DB status = 'closed', exitTrigger = 'STOP_LOSS'
  - healer cycles → maxHoldHours elapsed → DB status = 'closed', exitTrigger = 'MAX_HOLD_EXIT'
  - hunter blocked by REGIME_BEAR_DEFENSE → no position opened
  - hunter blocked by CIRCUIT_BREAKER_ACTIVE → no position opened, runtime-state.json has key
Constraint: do NOT require real Solana RPC — inject mock closePositionDLMM and deployDLMM
```

**Task 1.3 — Verify `dailyLossLimitUsd` enforcement (P1-C)**
```
Files: src/agents/hunterAlpha.js, src/agents/healerAlpha.js
Check: grep 'dailyLossLimitUsd' in both files
If missing in hunter: add check before entry — if dailyLossUsd >= dailyLossLimitUsd, block entry
Add unit test in tests/safety.test.js: daily loss at limit → entry blocked
```

### Sprint 2 — Signal Validation

**Task 2.1 — Supertrend backtest (P1-A)**
```
File: scripts/backtestSupertrend.js (create new)
Input: fetch last 200 15m OHLCV candles from DexScreener for a target pool
Compute: Supertrend(period=10, multiplier=3) on historical data
Output: signal log — each flip (BULLISH/BEARISH), price at flip, price 1h/4h/24h after flip
Metric: win rate = % of BULLISH flips where price was higher 4h later
Report: console table + write to scripts/backtest-results.json
Do NOT modify hunterAlpha — this is a read-only diagnostic
```

**Task 2.2 — PnL fallback chain integration test (P1-B)**
```
File: tests/integration/pnl-fallback.test.js (create new)
Test: simulate LP Agent API timeout → confirm SDK fallback fires within 5s
Test: simulate SDK error → confirm manual calculation fallback fires
Test: all sources fail → verify healer skips close decision (does NOT use stale data)
```

### Sprint 3 — Operator UX

**Task 3.1 — Telegram /claim_fees command (P2-A)**
```
Search existing Telegram command registry (grep 'registerCommand\|addCommand' in src/)
Add: /claim_fees [position_address]
  → calls autoHarvestFees() on specified position (or all active if no arg)
  → replies with: position address, claimed SOL amount, tx signature
Add: /pause command if not present (check first — may already exist)
Constraint: do NOT modify healerAlpha.js directly; use existing command dispatch pattern
```

**Task 3.2 — Strategy performance report (P2-B)**
```
File: add /strategy_report Telegram command
Reads: strategy-library.json[].performanceHistory
Output (per strategy):
  - strategy name
  - total trades in history (up to 50)
  - win rate %
  - avg PnL %
  - current confidence score
```

---

## 7. Files You Must NOT Touch

```
src/agents/healerAlpha.js   — engine is live and tested; changes require full regression
src/agents/hunterAlpha.js   — same
src/solana/meteora.js       — Solana SDK integration; changes require devnet test
```

If a task requires changes in these files, flag for human review first.

---

## 8. Verification Commands

```bash
# All tests green before and after each task
npm test

# Confirm reason codes are consistent across docs (no aliases)
rg -n "CIRCUIT_BREAKER|SL_CLUSTER_THRESHOLD_MET|MAX_HOLD_EXIT|REGIME_BEAR_DEFENSE|SL_COOLDOWN_ACTIVE" \
  AGENT_EXECUTION_SCHEMA.md DEPLOYMENT_RUNBOOK.md AGENT_QUICK_REFERENCE.txt

# Check circuit breaker persistence key
node -e "import('./src/runtime/state.js').then(m => console.log(m.getRuntimeState('hunter-circuit-breaker', null)))"

# Confirm strategyType derives correctly for single_side_y
npm test -- --test-name-pattern "parseStrategyParameters"
```

---

## 9. Reference Map

| Question | Go to |
|----------|-------|
| Why did hunter block entry? | `AGENT_EXECUTION_SCHEMA.md` → Blocked Codes table |
| Why did healer close a position? | `AGENT_EXECUTION_SCHEMA.md` → Exit Codes table |
| What are the 3 config profiles? | `user-config.example.json` → `_profiles` block |
| Circuit breaker tripped in prod | `DEPLOYMENT_RUNBOOK.md` → QC-1 |
| Daily loss limit hit | `DEPLOYMENT_RUNBOOK.md` → QC-5 |
| When to promote canary → full | `DEPLOYMENT_RUNBOOK.md` → Staged Rollout Gate |
| Strategy regime selection logic | `STRATEGY_ANALYSIS.md` |
| All config parameters explained | `AGENT_QUICK_REFERENCE.txt` |
