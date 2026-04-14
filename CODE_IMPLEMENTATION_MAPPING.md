# CODE IMPLEMENTATION MAPPING: Deep Fishing Strategy

**Mapping Schema → Current Code Location**

---

## PHASE 1: ENTRY SIGNAL DETECTION

### Current Implementation

**File:** `src/utils/ta.js:113-169`
```javascript
export function calculateSupertrend(candles, period = 10, multiplier = 3) {
  // Returns: { trend: 'BULLISH' | 'BEARISH', value: X, changed: boolean }
}
```

**File:** `src/agents/hunterAlpha.js`
- Uses Supertrend for screening
- Current: Checks `requireSupertrendBullish: true`
- Issue: No FLIP detection or candle close confirmation

### Required Changes (PHASE 1)

```javascript
// Need to add to hunterAlpha.js or new hunterDeepFishing.js:

1. TRACK PREVIOUS TREND STATE:
   ├─ Store in memory: lastSupertrend = { trend, timestamp }
   └─ Compare on each scan: previousTrend vs currentTrend

2. FLIP DETECTION:
   ├─ isTrendFlip = (prevTrend !== currentTrend)
   ├─ IF isTrendFlip AND currentTrend === 'BULLISH'
   └─ THEN trigger candle close wait

3. CANDLE CLOSE CONFIRMATION:
   ├─ Get 15m candle: candles[candles.length - 1]
   ├─ Check: close > supertrendValue
   ├─ Check: candle is fully closed (timestamp + 15m <= now)
   └─ THEN ready to deploy
```

### Code Location for Implementation

- **Supertrend calculation:** `src/utils/ta.js` (already exists, reuse)
- **Trend state tracking:** Add to `src/agents/hunterAlpha.js` or new file
- **Flip detection logic:** Add to entry screening
- **Candle confirmation:** Add pre-deployment validation

---

## PHASE 2: POOL SELECTION

### Current Implementation

**File:** `src/agents/hunterAlpha.js:200-350`
```javascript
// Pool filtering and scoring logic
const eligiblePools = await getEligiblePools();
const scoredPools = await rankPools(eligiblePools);
```

**File:** `src/strategies/strategyManager.js:20-30`
```javascript
allowedBinSteps: [100, 125],  // Current state
```

### Required Changes (PHASE 2)

```javascript
// No change to allowedBinSteps needed - already has [100, 125]
// Just implement adaptive selection logic:

// In hunterAlpha.js:
1. POOL SELECTION WITH ADAPTIVE BINSTEP:
   
   function selectPoolByBinStep(candidatePools) {
     // Try BinStep 100 first
     const pool100 = candidatePools.find(p => p.binStep === 100);
     if (pool100) {
       const range100 = calculateRangeWidth(-86, -94, 100);
       if (range100 <= 250) return pool100;  // Within limit
     }
     
     // Try BinStep 125 if 100 doesn't work
     const pool125 = candidatePools.find(p => p.binStep === 125);
     if (pool125) {
       const range125 = calculateRangeWidth(-86, -94, 125);
       if (range125 <= 250) return pool125;  // Within limit
     }
     
     return null;  // No valid pool
   }

3. VERIFY POOL STATE:
   ├─ pool.currentPrice (for bin calculation)
   ├─ pool.activeBin (active trading bin)
   ├─ pool.binStep (confirmed)
   └─ pool.feeTier (for reference)
```

### Code Location for Implementation

- **BinStep configuration:** `src/strategies/strategyManager.js:23`
- **Pool selection logic:** Add new function in `src/agents/hunterAlpha.js`
- **Pool state capture:** Add validation before deployment

---

## PHASE 3: BIN CALCULATION

### Current Implementation

**File:** `src/solana/meteora.js:422-449`
```javascript
if (Number.isFinite(offsetMin) && Number.isFinite(offsetMax)) {
  const logPriceRatio = (offset) => Math.log(1 - offset / 100);
  const logBinFactor = binStepInt * Math.log(1.0001);
  
  const offsetMinBins = Math.round(Math.abs(logPriceRatio(offsetMin) / logBinFactor)) || 0;
  rangeMax = activeBin.binId - offsetMinBins;
  
  const offsetMaxBins = Math.round(Math.abs(logPriceRatio(offsetMax) / logBinFactor));
  rangeMin = activeBin.binId - offsetMaxBins;
}
```

### Current Issue

**Line 445-449:**
```javascript
const MAX_BINS_LIMIT = 1000;
if (rangeMax - rangeMin > MAX_WIDTH) {
  rangeMin = rangeMax - MAX_WIDTH;  // CLAMPS ALL RANGES!
}
```

This hardcoded 1000-bin limit breaks user's -86% to -94% range!

### Required Changes (PHASE 3)

```javascript
// Option A: Remove MAX_BINS_LIMIT for Deep Fishing strategy
// Option B: Make it configurable per strategy

// For Deep Fishing:
1. USE CORRECT OFFSETS:
   offsetMin: -86  (not 0)
   offsetMax: -94  (correct)

2. REMOVE OR CONDITIONAL LIMIT:
   const MAX_BINS_LIMIT = strategy.type === 'deepFishing' ? 10 : 1000;
   
   // OR better:
   if (rangeMax - rangeMin > MAX_ALLOWED_FOR_STRATEGY) {
     // For Deep Fishing, ~6 bins is expected
     // For Evil Panda, ~1000 bins is expected
   }

3. VERIFY CALCULATED RANGE:
   const expectedWidth = 6;  // For -86% to -94%
   const actualWidth = rangeMax - rangeMin;
   if (Math.abs(actualWidth - expectedWidth) > 1) {
     logger.warn(`Unexpected bin width: ${actualWidth} vs ${expectedWidth}`);
   }
```

### Code Location for Implementation

- **Offset-to-bin math:** `src/solana/meteora.js:428-440` (reuse, correct)
- **Hardcoded MAX_BINS_LIMIT:** `src/solana/meteora.js:445-449` (REMOVE/FIX)
- **New offset values:** `src/strategies/strategyManager.js:37-38`

---

## PHASE 4: LIVE PRICE TRACKING

### Current Implementation

**No current implementation!**

Currently offsets are calculated once at deployment time.

### Required Changes (PHASE 4)

```javascript
// Add to hunterAlpha.js or executionService.js:

function checkPriceDrift(signalPrice, currentPrice, threshold = 0.02) {
  const drift = Math.abs(currentPrice - signalPrice) / signalPrice;
  return drift > threshold;
}

function recalculateOffsetsIfNeeded(signalPrice, currentPrice, pool) {
  if (checkPriceDrift(signalPrice, currentPrice)) {
    logger.info(`Price moved, recalculating offsets...`);
    
    // Recalculate from NEW price
    const newActiveBin = calculateActiveBin(currentPrice, pool);
    const newRangeMax = calculateBinForOffset(-86, newActiveBin, pool.binStep);
    const newRangeMin = calculateBinForOffset(-94, newActiveBin, pool.binStep);
    
    return {
      recalculated: true,
      newRangeMax,
      newRangeMin,
      newActiveBin
    };
  }
  
  return { recalculated: false };
}

// Call in deployment flow BEFORE sending TX
const priceCheck = recalculateOffsetsIfNeeded(signalPrice, currentPrice, pool);
if (priceCheck.recalculated) {
  rangeMax = priceCheck.newRangeMax;
  rangeMin = priceCheck.newRangeMin;
}
```

### Code Location for Implementation

- **New function:** Add to `src/agents/hunterAlpha.js` or `src/solana/meteora.js`
- **Call location:** Before `_openPositionLogic()` in execution flow
- **File:** `src/app/executionService.js:executeControlledOperation()`

---

## PHASE 5: BIN CHUNKING

### Current Implementation

**File:** `src/solana/meteora.js:561-575` (FIXED in previous session!)

```javascript
// Chunk 0 gets FULL amount
if (ci === 0) {
  chunkTotalX = totalXBN;
  chunkTotalY = totalYBN;
} else {
  chunkTotalX = new BN(0);
  chunkTotalY = new BN(0);  // Chunks 1+: ZERO
}
```

### How It Works for Deep Fishing

For -86% to -94% range (~6 bins):

```javascript
// Configuration in strategyManager.js
maxBinsPerPosition: 125,  // Can fit 6 bins easily

// In chunking logic:
const rangeWidth = rangeMax - rangeMin;      // 6 bins
const maxBinsPerTX = 50;                      // Solana limit
const chunksNeeded = Math.ceil(rangeWidth / maxBinsPerTX);
// Result: 1 chunk (6 <= 50)

// Chunk allocation:
// Chunk 0: 0.5 SOL (all of it)
// Total binCount: 6
// perBinAmount: 0.5 / 6 = 0.0833 SOL per bin
```

### Current Issue

**File:** `src/config.js`
```javascript
maxBinsPerPosition: 125,  // Conflicts with code behavior
deployAmountSol: 0.1,     // May differ from user's 0.5
```

### Required Changes (PHASE 5)

```javascript
// In config.js:
deployAmountSol: 0.5,  // Match user's amount

// In strategyManager.js:
// Deep Fishing specific:
deepFishing: {
  maxBinsPerPosition: 50,  // Can fit full range
  deployAmount: 0.5,
  ...
}

// Chunking already works! Just need to verify:
// Per-bin amount calculation is correct
const perBinAmount = deployAmount / rangeWidth;
// 0.5 / 6 = 0.0833 SOL per bin ✅
```

### Code Location for Implementation

- **Chunking logic:** `src/solana/meteora.js:561-575` (already correct)
- **Config values:** `src/config.js` (update for consistency)
- **Chunk amount distribution:** Already implemented, no changes needed

---

## PHASE 6: TRANSACTION EXECUTION

### Current Implementation

**File:** `src/solana/meteora.js:600-650`
```javascript
const instructions = [];
for (let i = rangeMin; i <= rangeMax; i++) {
  instructions.push(
    createAddLiquidityInstruction({ bin: i, ...params })
  );
}
```

**File:** `src/solana/meteora.js:723-737`
```javascript
transaction.sign(
  walletKeypair,      // Signer 1
  positionKeypair     // Signer 2
);

const signature = await connection.sendTransaction(transaction, [
  walletKeypair,
  positionKeypair
]);
```

### How It Works

For 6-bin range: 6 instructions, single transaction

```javascript
const transaction = new Transaction();
for (let bin = 9917; bin <= 9923; bin++) {
  transaction.add(
    createAddLiquidityInstruction({
      pool: selectedPool.address,
      bin: bin,
      amountY: 0.0833,  // Per bin
      amountX: 0,       // Single-side
      user: walletPubkey
    })
  );
}
// 6 instructions added ✅

// Sign with both keys
transaction.sign(walletKeypair, positionKeypair);

// Send
const signature = await connection.sendTransaction(transaction, [...]);
```

### Required Changes (PHASE 6)

```javascript
// No major changes needed! Current implementation handles it.

// But add:
1. PRE-SEND VALIDATION:
   ├─ Verify TX size (< 1232 bytes)
   ├─ Verify instructions (should be 6 for Deep Fishing)
   └─ Verify signers (wallet + posKey)

2. RETRY LOGIC (already exists):
   // Keep existing retry with exponential backoff

3. CONFIRMATION TRACKING:
   // Poll until 'confirmed' status
```

### Code Location for Implementation

- **Instruction building:** `src/solana/meteora.js:600-620` (reuse)
- **Transaction signing:** `src/solana/meteora.js:723-737` (already correct)
- **Send & confirm:** `src/solana/meteora.js:750-770` (already has retry)

---

## PHASE 7: POST-DEPLOYMENT MONITORING

### Current Implementation

**File:** `src/agents/hunterHealer.js`
- Monitors existing positions
- Tracks fee generation
- Handles rebalancing

**File:** `src/app/executionService.js`
- Records operation state to DB
- Handles recovery from failures

### How It Works for Deep Fishing

```javascript
// After position deployed:
const position = {
  pool: 'WETH/SOL',
  binStep: 80,
  rangeMin: 9917,
  rangeMax: 9923,
  deployAmount: 0.5,
  entryPrice: 2000,
  status: 'active'
};

// Monitor scenarios:
if (currentPrice > topBinPrice) {
  logger.info('Price safe above range - zero IL');
}
if (currentPrice >= bottomBinPrice && currentPrice <= topBinPrice) {
  logger.info('Price IN range - trading/fees generating');
}
if (currentPrice < bottomBinPrice) {
  logger.warn('Price crashed below range - may want to close');
}
```

### Required Changes (PHASE 7)

```javascript
// In hunterHealer.js, add Deep Fishing specific logic:

function monitorDeepFishingPosition(position) {
  const currentPrice = getPrice(position.pool);
  const topPrice = position.entryPrice * 0.14;    // -86%
  const bottomPrice = position.entryPrice * 0.06; // -94%
  
  if (currentPrice < bottomPrice) {
    logger.warn('CRASH COMPLETED - consider closing');
    return 'crash_completed';
  }
  
  if (currentPrice >= topPrice) {
    logger.info('Price safe - no impermanent loss');
    return 'safe';
  }
  
  logger.info('Price in range - actively generating fees 🔥');
  return 'trading';
}

// Track fee accumulation
function trackDeepFishingFees(position) {
  const feeGenerated = position.feeY + position.feeX;
  const daysSinceEntry = (Date.now() - position.entryTime) / 86400000;
  const aprRate = (feeGenerated / position.deployAmount / daysSinceEntry) * 365;
  
  logger.info(`APR estimate: ${aprRate.toFixed(2)}% (if crash)`);
}
```

### Code Location for Implementation

- **Monitoring logic:** `src/agents/hunterHealer.js` (extend existing)
- **Position tracking:** `src/db/models/Position.js` (existing schema)
- **Fee calculation:** Add helper function in `src/utils/analytics.js`

---

## SUMMARY: What Needs to Be Added vs Reused

### ✅ REUSE (Already Implemented)

| Phase | Component | Location | Status |
|-------|-----------|----------|--------|
| 1 | Supertrend calculation | `ta.js:113-169` | Reuse as-is |
| 3 | Offset-to-bin math | `meteora.js:428-440` | Reuse as-is |
| 5 | Chunk allocation | `meteora.js:561-575` | Fixed & working |
| 6 | TX building | `meteora.js:600-620` | Reuse as-is |
| 6 | TX signing | `meteora.js:723-737` | Reuse as-is |
| 7 | Position monitoring | `hunterHealer.js` | Extend existing |

### ⚠️ MODIFY (Need Changes)

| Phase | Component | Location | Change |
|-------|-----------|----------|--------|
| 1 | Flip detection | `hunterAlpha.js` | ADD trend comparison |
| 1 | Candle confirmation | `hunterAlpha.js` | ADD close validation |
| 2 | BinStep priority | `strategyManager.js:23` | ADD 80 to list |
| 3 | MAX_BINS_LIMIT | `meteora.js:445-449` | REMOVE/CONDITIONAL |
| 3 | Strategy offsets | `strategyManager.js:37-38` | CHANGE to -86/-94 |
| 4 | Price tracking | `hunterAlpha.js` or new | ADD price drift check |
| 4 | Offset recalc | `hunterAlpha.js` or new | ADD recalculation logic |

### 🆕 CREATE (New Implementation)

| Phase | Component | Suggested Location | Purpose |
|-------|-----------|-------------------|---------|
| 1 | Deep Fishing Strategy | `strategies/deepFishing.js` | New strategy definition |
| 4 | Price drift check | `utils/priceChecks.js` | Live price validation |
| 4 | Offset recalculator | `solana/offsetCalculator.js` | Dynamic bin recalculation |
| 7 | Deep Fishing monitor | In `hunterHealer.js` | Crash-specific tracking |

---

## IMPLEMENTATION ORDER (Recommended)

1. **Create Deep Fishing strategy** → New strategy config (offset -86 to -94)
2. **Add adaptive BinStep selection** → `hunterAlpha.js` (100 > 125, check range ≤ 250 bins)
3. **Remove MAX_BINS_LIMIT** → `meteora.js:445-449` (or make conditional)
4. **Add flip detection** → `hunterAlpha.js` (compare previous vs current trend)
5. **Add candle confirmation** → `hunterAlpha.js` (wait for close above ST)
6. **Add price tracking** → Pre-deployment validation (check if moved >2%)
7. **Add offset recalculation** → If price moved >2% (maintain -86% to -94% window)
8. **Extend monitoring** → `hunterHealer.js` (Deep Fishing specific tracking)

---

**Status:** Ready for step-by-step implementation ✅
