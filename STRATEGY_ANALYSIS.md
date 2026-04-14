# USER STRATEGY ANALYSIS: -86% to -94% Deep Range SOL Spot LP

**Status:** ANALYSIS ONLY - No changes made  
**Date:** 2026-04-14

---

## 📋 STRATEGI USER (EXACT SPECIFICATION)

### Signal Entry
```
TRIGGER: 15-minute Supertrend Bullish Flip
CONDITION: Price > Supertrend line (trend flips from BEARISH to BULLISH)
WAIT: Candle close confirmation ABOVE Supertrend (not just wick touch)
```

### Position Type
```
MODE: One-Sided SOL (Spot DLMM)
TOKEN X SIDE: 0 (no purchase of alternate token)
TOKEN Y SIDE: Full SOL amount (buy-side liquidity only)
PAIRS: WETH/SOL, USDC/SOL, etc.
```

### Liquidity Range (EXACT OFFSETS)
```
CURRENT PRICE: 100%
MIN OFFSET: -94%  ← Lower boundary (deeper)
MAX OFFSET: -86%  ← Upper boundary (shallower)
RANGE WIDTH: -94% to -86% (8 percentage points ONLY)
STRATEGY: "Deep Fishing" — Only bid in crash zone
```

### Pool Selection Priority
```
PRIORITY 1: BinStep = 80  (finest precision, 0.008% per bin)
PRIORITY 2: BinStep = 100 (standard, 0.01% per bin)
PRIORITY 3: BinStep = 125 (balanced, 0.0125% per bin)
AVOID: > 125 (too coarse for precision range)
```

### Execution Logic
```
STEP 1: Wait 15m candle to CLOSE above Supertrend line
STEP 2: Calculate liquidity range using -86% to -94% offsets
STEP 3: Deploy SOL into pool within that range
STEP 4: If price moves DURING execution, RECALCULATE offsets
        to maintain the -86% to -94% gap relative to NEW price
STEP 5: Continuous monitoring - adjust range if needed
```

---

## 🔍 CURRENT CODE ANALYSIS

### 1. OFFSET IMPLEMENTATION (Current Evil Panda)

**File:** `src/strategies/strategyManager.js:37-38`
```javascript
deploy: {
  entryPriceOffsetMin: 0,    // Current price (TOP of range)
  entryPriceOffsetMax: 94,   // 94% below current (BOTTOM of range)
}
```

**Current Range:** 0% → -94% (entire spectrum from current → 94% drop)  
**User Requirement:** -86% → -94% (narrow deep zone only)

**MISMATCH:** Current opens range from 0% down to -94%  
User wants range ONLY from -86% down to -94% (8% window)

---

### 2. OFFSET CALCULATION (Current Meteora.js)

**File:** `src/solana/meteora.js:422-449`
```javascript
if (Number.isFinite(offsetMin) && Number.isFinite(offsetMax)) {
  // Logarithmic bin calculation
  const logPriceRatio = (offset) => Math.log(1 - offset / 100);
  const logBinFactor = binStepInt * Math.log(1.0001);
  
  const offsetMinBins = Math.round(Math.abs(logPriceRatio(offsetMin) / logBinFactor)) || 0;
  rangeMax = activeBin.binId - offsetMinBins;  // TOP
  
  const offsetMaxBins = Math.round(Math.abs(logPriceRatio(offsetMax) / logBinFactor));
  rangeMin = activeBin.binId - offsetMaxBins;  // BOTTOM (deeper)
}
```

**Math Verification for User Requirements:**

```
binStep = 100 (0.01% per bin)
logBinFactor = 100 * ln(1.0001) ≈ 100 * 0.0001 = 0.01

For offsetMin = -86%:
  logPriceRatio = ln(1 - (-86/100)) = ln(1.86) ≈ 0.619
  offsetMinBins = 0.619 / 0.01 ≈ 62 bins below active

For offsetMax = -94%:
  logPriceRatio = ln(1 - (-94/100)) = ln(1.94) ≈ 0.663
  offsetMaxBins = 0.663 / 0.01 ≈ 66 bins below active

RANGE WIDTH: 66 - 62 = 4 bins (representing 8% price drop)
```

**ISSUE:** Range is VERY narrow (4 bins) — risky untuk liquidity depth

---

### 3. SUPERTREND INTEGRATION (Current Status)

**File:** `src/utils/ta.js:113-169`
```javascript
export function calculateSupertrend(candles, period = 10, multiplier = 3) {
  // Returns: { trend: 'BULLISH' | 'BEARISH', value: X, changed: boolean }
}
```

**Current Usage:**
- ✅ Supertrend calculated in hunterAlpha screening
- ✅ Entry requires `requireSupertrendBullish: true`
- ❌ BUT: Not checking for FLIP (trend change)
- ❌ But: Not monitoring 15m candle CLOSE confirmation

**Current Code:**
```javascript
// hunterAlpha.js (simplified)
if (pool.multiTFScore < 0.4 && !isGlobalBullish) {
  score *= 0.5; // Penalize bearish
}
```

**User Requirement:**
```
Wait for 15m candle to CLOSE above Supertrend (not just high touch)
Detect FLIP: previous candle trend ≠ current candle trend
Then deploy immediately
```

---

### 4. PRICE RECALCULATION DURING EXECUTION

**Current Behavior:**
- Offsets hardcoded at deploy time
- If price moves DURING execution, offsets NOT recalculated
- Range stays at original offset from WHEN execution started

**User Requirement:**
```
If price moves before TX settles, RECALCULATE:
- offsetMin = current_price - (0.86 * current_price)
- offsetMax = current_price - (0.94 * current_price)
- Deploy to updated range (maintain -86% to -94% gap)
```

**RISK:** If price pumps 5% during deployment, current code uses OLD offsets  
User wants LIVE tracking to maintain the -86% to -94% window

---

### 5. BIN STEP PRIORITY (Current)

**File:** `src/strategies/strategyManager.js:23`
```javascript
allowedBinSteps: [100, 125],
```

**Current:** Only allows 100 and 125  
**User Priority:** 80 > 100 > 125

**Issue:** BinStep 80 not in allowedBinSteps (missing!)

---

## 📊 GAP ANALYSIS: Current vs Requirement

| **Aspek** | **Current** | **User Requirement** | **Status** |
|---|---|---|---|
| **Offset Min** | 0% | -86% | ❌ WRONG |
| **Offset Max** | -94% | -94% | ✅ OK |
| **Range Type** | Full spectrum (0→-94%) | Deep zone only (-86→-94%) | ❌ WRONG |
| **Supertrend Signal** | Bullish OK | Bullish FLIP on 15m close | ⚠️ PARTIAL |
| **Candle Confirmation** | Not implemented | Wait for close above ST line | ❌ MISSING |
| **Price Recalc** | NO | YES (live tracking) | ❌ MISSING |
| **BinStep Priority** | [100, 125] | [80, 100, 125] | ❌ MISSING 80 |
| **Range Width (bins)** | ~1000 clamped | ~4-6 bins | ❌ WRONG |

---

## 🔢 EXAMPLE SCENARIO

### Situation
```
Pool: WETH/SOL
BinStep: 100
Current Price: $2000
Active Bin: 10000
Supertrend: $1980 (bullish line)
Price just closed ABOVE Supertrend
```

### Current Code Behavior
```
offsetMin: 0 → rangeMax at bin 10000 (current price)
offsetMax: 94 → rangeMin at bin 9000 (approx 94% below)
Deploy range: bins 9000-10000 (1000 bin width)
Result: Full liquidity from current price all the way down
```

### User Strategy Should Do
```
offsetMin: -86% → rangeMax at bin 9862 (86% below = $280)
offsetMax: -94% → rangeMin at bin 9660 (94% below = $120)
Deploy range: bins 9660-9862 (deep zone only, ~4 bins)
Result: Concentrated liquidity ONLY in -86% to -94% zone
        (buying massive drops, not catching upside at all)
```

---

## ⚠️ STRATEGIC IMPLICATIONS

### What User is Doing
1. **Wait for bullish signal** (Supertrend flip) = confirmation of downtrend reversal
2. **Place deep bid** only in crash zone (-86% to -94%) = extreme value hunting
3. **Pray for crash** = if price drops 86-94%, massive fee generation
4. **If no crash** = sit holding dead capital in deep zone

### Risk Profile
```
UPSIDE:     If crash happens → HUGE fee APR generation
DOWNSIDE:   If price doesn't crash → capital trapped deep
CAPITAL USE: Highly inefficient (entire 0.5 SOL sits unused)
TIME VALUE: Position valuable ONLY if crash within N hours
```

### This is NOT Standard "Wide Range"
- **Wide Range** = captures both upside AND downside = dual-purpose
- **User Strategy** = ultra-deep one-sided bid = crash-only play
- **Best Case** = crash happens, fees print
- **Worst Case** = market rallies, position dead weight

---

## 🎯 NEXT STEPS (When you're ready to code)

1. **Create new strategy** (don't modify Evil Panda yet)
   - Name: `"Deep Fishing"` or `"Crash Buyer"`
   - Offsets: min=-86, max=-94
   
2. **Add Supertrend flip detection**
   - Compare current trend vs previous trend
   - Wait for 15m candle close confirmation
   
3. **Add live price tracking**
   - Before deployment, check current price
   - Recalc offsets if price moved
   - Maintain -86% to -94% window
   
4. **Add BinStep 80 support**
   - Update allowedBinSteps: [80, 100, 125]
   
5. **Validate bin width**
   - Current math gives ~4 bins for 8% window
   - May need fallback for very narrow ranges

---

## 📌 KEY INSIGHTS

1. **User strategy is INVERTED** from current Evil Panda
   - Current: 0% to -94% (full spectrum)
   - User: -86% to -94% (deep zone only)

2. **Very narrow range** (4-6 bins for -86% to -94%)
   - Pros: Concentrated liquidity, massive APR if crash hits
   - Cons: Dead capital if no crash, risky if price moves mid-deployment

3. **Supertrend as ENTRY TIMER** (not exit)
   - Bullish flip = signal to place deep bid
   - 15m close confirmation = reduce false triggers

4. **Live price tracking critical**
   - Price moves during deployment
   - Need to recalc to maintain intended window

5. **This is a TACTICAL trade**, not strategic wide range

---

**Status:** ✅ Analysis complete, awaiting your confirmation before implementation
