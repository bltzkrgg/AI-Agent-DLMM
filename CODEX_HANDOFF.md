# Codex Handoff - LP Agent DLMM
**Date:** 2026-04-25 | **Status:** Evil Panda operating doctrine is canonical

This file is the handoff source of truth for AI agents and developers working on the DLMM LP agent. If another document, comment, strategy preset, or old backlog conflicts with this file, this file wins until the conflict is explicitly resolved in code and config.

---

## 1. System Architecture

Autonomous Meteora DLMM liquidity-provision agent on Solana.

Core runtime:
- **Hunter** - `src/agents/hunterAlpha.js`: scans pools, applies entry policy, resolves strategy profile, deploys positions.
- **Healer** - `src/agents/healerAlpha.js`: monitors open positions, evaluates Net-PnL, applies exit policy, records close events.
- **Strategy Manager** - `src/strategies/strategyManager.js`: parses strategy parameters and resolves deployment shape.
- **Strategy Handler** - `src/strategies/strategyHandler.js`: orchestrates deploy/close calls through Meteora SDK.
- **Meteora SDK Adapter** - `src/solana/meteora.js`: DLMM contract integration.
- **Runtime State** - `src/runtime/state.js`: position/runtime key-value state persisted to `runtime-state.json`.
- **Config** - `src/config.js`: canonical source for dynamic thresholds and operational tunables.

Operational rule: shared behavior belongs in config/helpers. Do not hide trading thresholds inside agent functions.

---

## 2. Absolute Operating Doctrine: Evil Panda

These rules are mandatory for AI agent decisions, developer changes, tests, docs, and operator runbooks.

### 2.1 Position Structure

- Evil Panda is a logarithmic DLMM net with depth down to **-94%**.
- Evil Panda is **pure asset Y (SOL)**.
- Deployment must preserve the intended single-side SOL posture unless an explicit human-approved migration changes the strategy.

### 2.2 Stop-Loss

- Evil Panda stop-loss is **bin-position based only**:
  - Trigger condition: `activeBin < rangeFloor - toleranceBins`
  - `rangeFloor` is the lower bin of the deployed Evil Panda range.
  - `toleranceBins` must be read from `src/config.js`.
- Percentage-price stop-loss is forbidden for Evil Panda.
- Any logic equivalent to `pnlPct < -stopLossPct`, price drawdown, or percentage range break must not close Evil Panda as `STOP_LOSS`.
- Percentage SL may exist only for non-Evil-Panda strategies and must use config-derived values.

### 2.3 Duration

- Evil Panda `maxHoldHours` is overridden to **72 hours**.
- No profile or runtime default may shorten Evil Panda below 72 hours without explicit human approval.
- `MAX_HOLD_EXIT` is not a blind close. It is subject to the Efficiency Veto below.

---

## 3. Pool Efficiency & Position Management

### 3.1 Efficiency Veto

Healer must not close a position only because it exceeded `maxHoldHours` when the pool is still efficient.

Efficiency score:

```text
efficiencyScore = volume24h / tvl
```

Veto condition:
- `efficiencyScore > 1.5`, or
- `feeApr > 60%`

When the veto applies:
- Block `MAX_HOLD_EXIT`.
- Apply a **4-hour grace period**.
- Re-evaluate after the grace period instead of closing immediately.

### 3.2 Zombie Exit

Force `ZOMBIE_EXIT` when:
- position age is greater than or equal to **6 hours**, and
- `efficiencyScore < 0.2`.

Zombie logic must not wait for percentage PnL deterioration when the pool has gone dead.

### 3.3 Net-PnL Only

All position evaluation must use Net-PnL:

```text
Net-PnL = Capital PnL + Fees Claimed
```

Do not evaluate profitability, TP, emergency decisions, or performance history using capital-only PnL when claimed fees exist. Fee income is part of the position result.

---

## 4. Emergency System & Execution

### 4.1 TVL Drain Guard

Use `entryTvl` as the absolute baseline.

Trigger:

```text
(entryTvl - currentTvl) / entryTvl > 0.50
```

Required behavior:
- Exit reason must be `PANIC_EXIT_TVL_DRAIN`.
- Exit execution must force slippage to **750 bps (7.5%)**.
- `entryTvl` must be captured from the first reliable pool snapshot for that position and persisted in runtime state.
- Do not re-baseline `entryTvl` downward after entry.

### 4.2 Nascent Pool Slippage

Any target pool younger than **1 hour** must force deploy slippage to **750 bps (7.5%)**.

This is mandatory anti-revert behavior for volatile newborn pools. It must not be replaced by conservative dynamic slippage.

---

## 5. Contract & Infrastructure Constraints

### 5.1 DLMM Invariant Violation

`autoHarvestCompound: true` is forbidden for straddle positions that cut across the active price when the deposit is single-side.

Required mode:
- Always use **Realize** for this shape.
- Claim fees to wallet.
- Do not compound harvested fees back into the position.

Rationale: Meteora Spot/straddle + single-side compound can hit DLMM invariant violations.

### 5.2 Rent Guard

Reject execution when the target price range would require initializing a new Bin Array with non-refundable rent cost of about **0.07 SOL**.

This is a pre-execution guard. Do not treat the rent as acceptable slippage or normal gas.

### 5.3 Config vs Code

All dynamic thresholds must be read from `src/config.js`.

Config-owned values include:
- slippage thresholds and emergency slippage
- take-profit and stop-loss thresholds
- Evil Panda `maxHoldHours`
- Evil Panda bin tolerance
- TVL drain threshold
- pool efficiency thresholds
- zombie thresholds
- hold/grace-period limits
- auto-harvest/compound behavior

Forbidden:
- hardcoding trading parameters inside `src/agents/healerAlpha.js`
- hardcoding trading parameters inside `src/agents/hunterAlpha.js`
- adding new strategy thresholds only in docs or strategy comments

If a new threshold is needed, add it to `src/config.js`, validate it there, and consume it from config in the agent.

---

## 6. Canonical Exit / Block Codes

Use exact codes in logs, Telegram, DB, and tests. Do not invent aliases.

Exit triggers:

```text
TRAILING_TAKE_PROFIT
TAKE_PROFIT
MAX_HOLD_EXIT
STOP_LOSS
OOR_BINS_EXCEEDED
IL_VS_HODL_EXIT
LOW_FEE_YIELD_EXIT
VOLUME_COLLAPSE
ZOMBIE_EXIT
ZOMBIE_FEE_STAGNATION
PANIC_EXIT_TVL_DRAIN
SL_CLUSTER_THRESHOLD_MET
MANUAL_CLOSE
AGENT_CLOSE
ZAP_OUT
```

Entry blocked:

```text
REGIME_BEAR_DEFENSE
CIRCUIT_BREAKER_ACTIVE
TREND_BEARISH
ATR_LOW
FEE_VELOCITY_DOWN
HTF_NULL_STRICT_ATR
RENT_GUARD_BIN_ARRAY_INIT
```

Important distinction:
- `SL_COOLDOWN_ACTIVE` is a healer hold-delay only.
- Hunter entry block remains `CIRCUIT_BREAKER_ACTIVE` when the persisted circuit breaker is active.

---

## 7. Implementation Checklist For Any Agent Change

Before editing `hunterAlpha.js`, `healerAlpha.js`, or Meteora execution code, confirm:

- Evil Panda still uses bin-position SL only.
- Evil Panda `maxHoldHours` resolves to 72 hours.
- `MAX_HOLD_EXIT` is vetoed by efficient pools and delayed by the 4-hour grace period.
- `ZOMBIE_EXIT` fires after 6 hours when `volume24h / tvl < 0.2`.
- Net-PnL includes claimed fees.
- TVL drain uses immutable `entryTvl`, exits on >50% drain, and forces 750 bps.
- Pools younger than 1 hour deploy with 750 bps slippage.
- Single-side straddle fee handling uses Realize, not compound.
- Rent Guard blocks new Bin Array rent around 0.07 SOL.
- New or changed thresholds live in `src/config.js`.

---

## 8. Verification Commands

Run after any implementation change that touches strategy, healer, hunter, or execution:

```bash
npm test
rg -n "PANIC_EXIT_TVL_DRAIN|ZOMBIE_EXIT|MAX_HOLD_EXIT|STOP_LOSS|autoHarvestCompound|entryTvl|toleranceBins|maxHoldHours|slippageBps" src CODEX_HANDOFF.md
rg -n "stopLossPct|750|72|1.5|0.2|0.07|60" src/agents/healerAlpha.js src/agents/hunterAlpha.js
```

Interpretation:
- Hardcoded constants in agent files are suspect unless they are config fallbacks being removed or migrated.
- A passing test suite is required but not sufficient; review the grep output against this handoff.

---

## 9. Reference Map

| Question | Go to |
|----------|-------|
| Dynamic threshold source | `src/config.js` |
| Evil Panda deploy shape | `src/strategies/strategyManager.js`, `src/market/strategyLibrary.js` |
| Hunter entry and deploy slippage | `src/agents/hunterAlpha.js` |
| Healer exits and Net-PnL | `src/agents/healerAlpha.js` |
| DLMM deploy/close execution | `src/solana/meteora.js` |
| Runtime position state | `src/runtime/state.js`, `runtime-state.json` |

