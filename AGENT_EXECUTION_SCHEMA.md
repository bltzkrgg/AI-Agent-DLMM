# Agent Execution Schema

Generalized decision taxonomy and structured decision context for entry, hold, and exit flows.

---

## What Changed (2026-04-19)

| Module | Change |
|--------|--------|
| `src/agents/hunterAlpha.js` | Gates entry with `classifyMarketRegime()` — emits `REGIME_BEAR_DEFENSE` policy block |
| `src/agents/healerAlpha.js` | Max-hold forced exit emits `exitTrigger: MAX_HOLD_EXIT` (not EXPIRED) |
| `src/agents/healerAlpha.js` | Calls `recordStrategyPerformance()` on close — updates `strategy-library.json` performanceHistory |
| `src/runtime/state.js` | `hunter-circuit-breaker` + `recent-sl-events` persisted to `runtime-state.json` (survives restart) |
| `src/strategies/strategyManager.js` | `Deep Fishing` added to BASELINE_STRATEGIES |
| `src/strategies/strategyManager.js` | `parseStrategyParameters`: `strategyType` now derives from `deploy.strategyType` or strategy type mapping |

---

## Canonical Reason Code Table

> Single source of truth. All docs and operator messages reference these exact codes.

### Entry Codes — emitted by `hunterAlpha.js`

| Code | Description | Condition | Where Emitted |
|------|-------------|-----------|---------------|
| `SUPERTREND_BULL` | Supertrend 15m in BULLISH state | supertrend.trend === 'BULLISH' | hunterAlpha — entry evaluation |
| `HTF_CONFIRMED` | 1h timeframe momentum aligned | momentum aligned with 15m signal | hunterAlpha — entry evaluation |
| `ATR_OK` | Volatility sufficient for IL protection | atrPct > minAtrPctForEntry | hunterAlpha — entry evaluation |
| `FEE_VELOCITY_UP` | Fee accumulation trend positive | consecutive rising feeTvlRatio samples | hunterAlpha — entry evaluation |
| `SMART_WALLET_HIT` | Smart money accumulation detected | whale_wallet_activity > threshold | hunterAlpha — smart wallet scan |
| `DARWIN_SCORE_HIGH` | AI-adjusted entry confidence high | darwinScore > 0.65 | hunterAlpha — darwin scoring |

### Hold Codes — emitted by `healerAlpha.js`

| Code | Description | Condition | Where Emitted |
|------|-------------|-----------|---------------|
| `TREND_RECOVERY_HOLD` | Trend recovering but not reversed | supertrend stable, price recovering | healerAlpha — hold decision |
| `TP_TRAILING_ACTIVE` | Trailing take-profit in motion | trailingTriggerPct achieved, monitoring peak | healerAlpha — trailing TP path |
| `BULLISH_CONFLUENCE` | Multiple bullish signals aligned | 3+ entry codes active simultaneously | healerAlpha — hold decision |

### Exit Codes — emitted as `exitTrigger` / `closeReasonCode` by `healerAlpha.js`

> ⚠️ **Split naming:** Some watchdog paths emit different values for `exitTrigger` (analytics/DB field) and `closeReasonCode` (DB record). Both columns are authoritative for their respective fields. Do NOT treat them as interchangeable.

#### Main Loop — `exitTrigger` = `closeReasonCode` (consistent)

| Code | Description | Condition | Where Emitted |
|------|-------------|-----------|---------------|
| `TRAILING_TAKE_PROFIT` | Peak profit trailing drop exceeded | peak - current > trailingDropPct | healerAlpha — main loop |
| `TAKE_PROFIT` | Static profit threshold reached | pnlPct >= takeProfitFeePct | healerAlpha — main loop |
| `MAX_HOLD_EXIT` | Force close after maxHoldHours (dead capital) | positionAge >= maxHoldHours × 60 min | healerAlpha — main loop |
| `STOP_LOSS` | Drawdown threshold breached | pnlPct < -stopLossPct | healerAlpha — main loop |
| `OOR_BINS_EXCEEDED` | Price out-of-range bin count exceeded limit | outOfRangeBins >= outOfRangeBinsToClose | healerAlpha — main loop |

#### Watchdog Sub-loops — `exitTrigger` ≠ `closeReasonCode` (⚠️ split)

| exitTrigger | closeReasonCode | Condition | Watchdog |
|-------------|----------------|-----------|---------|
| `GUARDIAN_ANGEL_DUMP` | `GUARDIAN_ANGEL_DUMP_EXIT` | Price dump velocity > guardian threshold | guardian watchdog |
| `ZOMBIE_EXIT` | `ZOMBIE_EXIT_${reason}` (dynamic) | Fees zero + price stagnant | zombie watchdog |
| `TRAILING_TP_HIT` | `TAE_WATCHDOG_EXIT_${zone}` (dynamic) | Trailing TP hit in TAE zone | TAE watchdog |
| `SUPERTREND_FLIP` | `TAE_WATCHDOG_MOMENTUM_EXIT_${zone}` (dynamic) | Supertrend flipped BEARISH in TAE zone | TAE watchdog |
| `OOR_BAILOUT` | `OOR_HARD_EXIT_WATCHDOG` | OOR beyond bail threshold | OOR watchdog |
| `PANIC_EXIT_BEARISH_OOR` | `PANIC_EXIT_BEARISH_OOR` | OOR + bearish panic — both fields consistent | OOR panic watchdog |
| `PROFIT_PROTECTION` | `PROFIT_PROTECTION_BEARISH` | Profit threshold + bearish flip detected | profit-protection watchdog |

#### Other Exits — operator initiated (`exitTrigger` = `closeReasonCode`)

| Code | Description | Where Emitted |
|------|-------------|---------------|
| `MANUAL_CLOSE` | Operator-initiated close | healerAlpha — tool execution |
| `AGENT_CLOSE` | AI agent-initiated close | healerAlpha — tool execution |
| `ZAP_OUT` | Close position + swap all tokens to SOL | healerAlpha — zap_out path |

#### Circuit Breaker Event — recorded separately (NOT in `exit_events`)

| Code | Status | Notes |
|------|--------|-------|
| `SL_CLUSTER_THRESHOLD_MET` | Writes to `circuit_breaker_events` via `recordCircuitBreakerEvent()` | Side-effect of SL cluster → writes a row to `circuit_breaker_events` table with `poolAddress`, `slCount`, `pausedUntil`. The triggering SL close still records `STOP_LOSS` in `exit_events`. Does **not** appear in `exit_events`. |

### Blocked Codes — emitted by `hunterAlpha.js` (entry blocked, no position opened)

| Code | Description | Condition | Where Emitted |
|------|-------------|-----------|---------------|
| `REGIME_BEAR_DEFENSE` | Market regime bearish — hard entry block | classifyMarketRegime() === 'BEAR_DEFENSE' | hunterAlpha — regime check |
| `CIRCUIT_BREAKER_ACTIVE` | Circuit breaker paused (persisted in runtime-state.json) | hunter-circuit-breaker.pausedUntil > now | hunterAlpha — top of runHunterAlpha |
| `FAIL_SAFE_UNRELIABLE_DATA` | Oracle/TA data unreliable — all entries blocked | failSafeModeOnDataUnreliable=true AND (!dataReliable OR !taReliable) | hunterAlpha — Phase 2.0b data guard |
| `TREND_BEARISH` | Supertrend BEARISH signal | supertrend.trend === 'BEARISH' | hunterAlpha — entry evaluation |
| `ATR_LOW` | Volatility too low for safe entry | atrPct < minAtrPctForEntry | hunterAlpha — entry evaluation |
| `FEE_VELOCITY_DOWN` | Fee declining — unfavorable entry | 3-sample feeTvlRatio strictly descending | hunterAlpha — entry evaluation |
| `HTF_NULL_STRICT_ATR` | 1h data missing + ATR below threshold | history null AND atrPct < 2.0 | hunterAlpha — Phase 2.0b guard |

> **`SL_COOLDOWN_ACTIVE` — Healer HOLD-delay only, not a Hunter block.**  
> This code applies inside `healerAlpha.js` when a recent stop-loss creates a hold delay before the next close decision. It does NOT block hunter from opening new positions. The hunter's equivalent gate is `CIRCUIT_BREAKER_ACTIVE`.

---

## Structured Decision Context Schema

```json
{
  "decisionType": "EXIT" | "ENTRY" | "HOLD",
  "trigger": "STOP_LOSS" | "TAKE_PROFIT" | "SUPERTREND_BULL" | "...",
  "confidence": 0.92,
  "blockers": ["SL_COOLDOWN_RECORDED"],
  "safeguardsApplied": ["SL_COOLDOWN_RECORDED", "POOL_MEMORY_UPDATED"],
  "fallbackUsed": false,
  "positionAge": 142,
  "pnlPct": -10.3,
  "regimeAtEntry": "BULL_TREND",
  "regimeAtDecision": "BEAR_DEFENSE",
  "reasonCodes": ["SUPERTREND_BULL", "FEE_VELOCITY_UP"],
  "notes": "Supertrend flip detected + drawdown threshold. Stop-loss executed."
}
```

**Field Descriptions:**
- **decisionType** — ENTRY, HOLD, EXIT
- **trigger** — Primary reason code driving decision
- **confidence** — 0.0–1.0 decision certainty
- **blockers** — Overriding conditions preventing execution
- **safeguardsApplied** — Risk management steps taken
- **fallbackUsed** — Whether fallback logic was invoked
- **positionAge** — Minutes since entry
- **pnlPct** — Current P&L percentage
- **regimeAtEntry** — Market regime at entry time (from `classifyMarketRegime`)
- **regimeAtDecision** — Current market regime
- **reasonCodes** — Array of applicable reason codes
- **notes** — Human-readable summary

---

## Flow Examples

### Entry Flow

```json
{
  "decisionType": "ENTRY",
  "trigger": "SUPERTREND_BULL",
  "confidence": 0.87,
  "blockers": [],
  "safeguardsApplied": ["REGIME_CHECK_PASSED", "FEE_VELOCITY_CONFIRMED"],
  "fallbackUsed": false,
  "positionAge": 0,
  "pnlPct": 0,
  "regimeAtEntry": "BULL_TREND",
  "regimeAtDecision": "BULL_TREND",
  "reasonCodes": ["SUPERTREND_BULL", "HTF_CONFIRMED", "FEE_VELOCITY_UP", "ATR_OK"],
  "notes": "Evil Panda entry: Supertrend BULLISH confirmed, 1h momentum aligned, fees rising. Deploying 0.5 SOL."
}
```

### Hold Flow

```json
{
  "decisionType": "HOLD",
  "trigger": "TREND_RECOVERY_HOLD",
  "confidence": 0.71,
  "blockers": [],
  "safeguardsApplied": ["TRAILING_TP_UPDATED"],
  "fallbackUsed": false,
  "positionAge": 73,
  "pnlPct": 3.2,
  "regimeAtEntry": "BULL_TREND",
  "regimeAtDecision": "BULL_TREND",
  "reasonCodes": ["BULLISH_CONFLUENCE", "TP_TRAILING_ACTIVE"],
  "notes": "Position in profit. Supertrend stable. Trailing take-profit active at peak +3.2%. Holding for further gains."
}
```

### Exit Flow

```json
{
  "decisionType": "EXIT",
  "trigger": "STOP_LOSS",
  "confidence": 0.98,
  "blockers": [],
  "safeguardsApplied": ["SL_COOLDOWN_RECORDED", "POOL_MEMORY_UPDATED", "CIRCUIT_BREAKER_CHECKED", "POSITION_CLOSED"],
  "fallbackUsed": false,
  "positionAge": 142,
  "pnlPct": -7.8,
  "regimeAtEntry": "BULL_TREND",
  "regimeAtDecision": "BEAR_DEFENSE",
  "reasonCodes": ["STOP_LOSS", "SUPERTREND_FLIP"],
  "notes": "Stop-loss triggered at -7.8%. Supertrend flipped to BEARISH. Closed position, SL cooldown 120min recorded, circuit breaker count incremented."
}
```

---

## Agent Integration Points

**Hunter (Entry):**
- Classify regime: `const regime = classifyMarketRegime(snapshot)`
- Hard block: `if (regime?.regime === 'BEAR_DEFENSE') → return blocked with policy: 'REGIME_BEAR_DEFENSE'`
- Check circuit breaker: reads `hunter-circuit-breaker` from `runtime-state.json` (persisted across restart)
- Build context: populate `decisionType: "ENTRY"` and `reasonCodes`

**Healer (Hold/Exit):**
- Max hold: evaluates `maxHoldTriggered` → emits `exitTrigger: 'MAX_HOLD_EXIT'`, `triggerLabel: 'Max Hold Exit'`
- After close: calls `recordStrategyPerformance(strategyId, result)` → appends to `strategy-library.json[].performanceHistory` (rolling 50)
- After SL cluster: writes `hunter-circuit-breaker.pausedUntil` + flushes `runtime-state.json`
- Log all exits with full context
- Use `safeguardsApplied` to track risk controls

---

## Wording & Label Mapping

| Machine Code | exitTrigger | closeReasonCode | Telegram Label | Operator Interpretation |
|-------------|-------------|----------------|---------------|------------------------|
| `TRAILING_TAKE_PROFIT` | ✅ | = exitTrigger | "Trailing Take Profit" | Main loop — peak drop exceeded |
| `TAKE_PROFIT` | ✅ | = exitTrigger | "Take Profit" | Main loop — static TP threshold |
| `MAX_HOLD_EXIT` | ✅ | = exitTrigger | "Max Hold Exit" | Main loop — dead capital cleanup |
| `STOP_LOSS` | ✅ | = exitTrigger | "Stop-Loss" | Main loop — drawdown threshold |
| `OOR_BINS_EXCEEDED` | ✅ | = exitTrigger | "OOR Bins Exceeded" | Main loop — OOR bin count exceeded |
| `GUARDIAN_ANGEL_DUMP` | ✅ | `GUARDIAN_ANGEL_DUMP_EXIT` | "Guardian Dump Exit" | ⚠️ Watchdog split — analytics vs DB differ |
| `ZOMBIE_EXIT` | ✅ | `ZOMBIE_EXIT_${reason}` | "Zombie Exit" | ⚠️ Watchdog split — closeReasonCode dynamic |
| `TRAILING_TP_HIT` | ✅ | `TAE_WATCHDOG_EXIT_${zone}` | "Trailing TP Hit" | ⚠️ Watchdog split — TAE zone appended to DB code |
| `SUPERTREND_FLIP` | ✅ | `TAE_WATCHDOG_MOMENTUM_EXIT_${zone}` | "Supertrend Flip" | ⚠️ Watchdog split — TAE zone appended to DB code |
| `OOR_BAILOUT` | ✅ | `OOR_HARD_EXIT_WATCHDOG` | "OOR Bailout" | ⚠️ Watchdog split — DB code is static string |
| `PANIC_EXIT_BEARISH_OOR` | ✅ | = exitTrigger | "Panic OOR Exit" | Watchdog — both fields consistent ✅ |
| `PROFIT_PROTECTION` | ✅ | `PROFIT_PROTECTION_BEARISH` | "Profit Protection" | ⚠️ Watchdog split — DB code has \_BEARISH suffix |
| `MANUAL_CLOSE` | ✅ | = exitTrigger | (no Telegram alert) | Operator-initiated close |
| `AGENT_CLOSE` | ✅ | = exitTrigger | "AGENT_CLOSE" | AI agent-initiated close |
| `ZAP_OUT` | ✅ | = exitTrigger | (zap flow) | Close + swap to SOL |
| `REGIME_BEAR_DEFENSE` | policy block | — | "Regime BEAR_DEFENSE: …" | Hunter blocked — bearish regime |
| `CIRCUIT_BREAKER_ACTIVE` | policy block | — | "Circuit Breaker Active" | Hunter blocked — persisted pause state |
| `FAIL_SAFE_UNRELIABLE_DATA` | policy block | — | (entry skipped) | Hunter blocked — oracle/TA unreliable |
| `SL_COOLDOWN_ACTIVE` | HOLD code | — | (skip, not closed) | Healer HOLD delay only — NOT a Hunter block |
| `HTF_NULL_STRICT_ATR` | policy block | — | (skip, not closed) | Hunter blocked — 1h data missing + ATR too low |
| `SL_CLUSTER_THRESHOLD_MET` | `circuit_breaker_events` table | — | (side effect) | Writes to `circuit_breaker_events` via `recordCircuitBreakerEvent()` — NOT in `exit_events` |

---

**Last Updated:** 2026-04-19
