# Strategy Regime Matrix

Market-responsive strategy selection based on real-time regime classification.

## Regimes

| Regime | Trigger Conditions | Recommended Strategy | Blockers |
|--------|-------------------|----------------------|----------|
| **BULL_TREND** | Supertrend BULLISH + priceChangeH1 > 2% + volumeTvlRatio > 1.5 | evil_panda | None — high confidence entry |
| **SIDEWAYS_CHOP** | \|priceChangeH1\| < 2% + atrPct < 3% + range24hPct < 8% | sideways_yield | Low volatility — IL risk without fee compensation |
| **BEAR_DEFENSE** | Supertrend BEARISH OR priceChangeH1 < -5% | bear_defense_idle | Bearish trend — entry forbidden |
| **LOW_LIQ_HIGH_RISK** | tvl < $50k OR volumeTvlRatio < 0.3 | AVOID | Insufficient liquidity or trader flow |

## Strategy Profiles

### Evil Panda
**Type:** Single-side SOL LP (Full Range)  
**Regime:** BULL_TREND  
**Entry Signal:** Supertrend 15m BULLISH + green momentum  
**Range:** 0% (current price) → -94% below  
**BinStep:** 100–125 (standard precision)  
**Confidence:** 85%  
**Thesis:** Bullish conviction play. Captures full upside fee generation and crash-zone profit if reversal occurs.

**Exit Conditions:**
- Supertrend 15m flip to BEARISH (primary exit)
- 5–8% drawdown (stop loss)
- 6 hours elapsed (dead capital cleanup)

---

### Deep Fishing
**Type:** Single-side SOL LP (Crash Zone Only)  
**Regime:** BULL_TREND (crash hunting)  
**Entry Signal:** Supertrend 15m BULLISH FLIP + volume surge  
**Range:** -86% to -94% below current price  
**BinStep:** 80 > 100 > 125 (priority)  
**Confidence:** 72%  
**Thesis:** Extreme value hunting. Concentrated liquidity in deep bid zone only. Profitable only if major crash occurs; otherwise dead capital.

**Exit Conditions:**
- Price crashes below -86% (fee accumulation)
- 6 hours elapsed (no crash = exit)
- Supertrend flip + 2 candle confirmation

---

### Sideways Yield
**Type:** Dual-side LP (Balanced)  
**Regime:** SIDEWAYS_CHOP  
**Entry Signal:** Price mid-range + ATR < 5% + multiple confirmed candles  
**Range:** ±15% around current price  
**BinStep:** 100–125 (standard)  
**Confidence:** 65%  
**Thesis:** Fee capture in ranging markets. Symmetric exposure protects against directional moves. Exit when out-of-range.

**Exit Conditions:**
- Price breaks range band by 2%
- 12 hours elapsed (time decay dominates)
- Out-of-range without retracement

---

### Bear Defense Idle
**Type:** Hold USDC/SOL (No Deployment)  
**Regime:** BEAR_DEFENSE  
**Entry Signal:** Supertrend BEARISH OR strong downtrend (H1 < -5%)  
**Range:** N/A — capital preserved  
**BinStep:** N/A  
**Confidence:** 80%  
**Thesis:** Capital preservation during downtrends. Wait for regime reversal before resuming entry. Avoids IL losses in crash zones.

**Exit Conditions:**
- Supertrend flips to BULLISH with 2 candle confirmation
- Market regime classifies as BULL_TREND or SIDEWAYS_CHOP

---

## Regime Classification Logic

**BULL_TREND Trigger:**
```
supertrend.trend === 'BULLISH'
  AND priceChangeH1 > 2%
  AND volumeTvlRatio > 1.5
  → Recommend: evil_panda
  → Confidence: 85%
```

**SIDEWAYS_CHOP Trigger:**
```
|priceChangeH1| < 2%
  AND atrPct < 3%
  AND range24hPct < 8%
  → Recommend: sideways_yield or WAIT
  → Confidence: 60%
  → Blocker: "Low volatility — IL risk without fee compensation"
```

**BEAR_DEFENSE Trigger:**
```
supertrend.trend === 'BEARISH' OR priceChangeH1 < -5%
  → Recommend: AVOID (hold cash)
  → Confidence: 75–80%
  → Blocker: "Bearish trend — entry forbidden"
```

**LOW_LIQ_HIGH_RISK Trigger:**
```
tvl < $50,000 OR volumeTvlRatio < 0.3
  → Recommend: AVOID
  → Confidence: 65%
  → Blocker: "Insufficient liquidity or trader flow"
```

---

## Reason Codes

Codes below align with `AGENT_EXECUTION_SCHEMA.md` (canonical source of truth).

**Entry Confidence Codes:**
- `SUPERTREND_BULL` — Supertrend BULLISH state (was: `TREND_BULL`)
- `HTF_CONFIRMED` — 1h momentum aligned with 15m signal
- `FEE_VELOCITY_UP` — feeTvlRatio rising (volumeTvlRatio > 1.5)
- `ATR_OK` — atrPct within safe range for entry

**Blocker Codes:**
- `REGIME_BEAR_DEFENSE` — `classifyMarketRegime()` returned BEAR_DEFENSE; hunter hard-blocks all entries
- `TREND_BEARISH` — Supertrend BEARISH signal (was: `TREND_BEAR`)
- `ATR_LOW` — atrPct < 3% in sideways regime
- `HTF_NULL_STRICT_ATR` — 1h data unavailable AND ATR below threshold
- `FEE_VELOCITY_DOWN` — feeTvlRatio declining

---

## Usage in Agents

**Hunter (hunterAlpha.js):**
- Calls `classifyMarketRegime(snapshot)` before every entry evaluation
- If `regime === 'BEAR_DEFENSE'` → returns `blocked: true, policy: 'REGIME_BEAR_DEFENSE'` immediately; no further evaluation
- Uses `recommendation` field to select baseline strategy
- Respects `blockers` array — **do not override**
- Logs `reasonCodes` for post-trade analysis

**Healer (healerAlpha.js):**
- Monitors regime shifts during holding period
- If regime flips to BEAR_DEFENSE, escalates exit decision
- On close: calls `recordStrategyPerformance(strategyId, result)` → rolling performance in `strategy-library.json`
- Max hold (`MAX_HOLD_EXIT`) fires unconditionally after `maxHoldHours` regardless of regime

---

**Last Updated:** 2026-04-19

---

**Last Updated:** 2026-04-19
