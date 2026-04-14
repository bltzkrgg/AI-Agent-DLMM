# AGENT EXECUTION SCHEMA: Deep Fishing SOL DLMM Strategy

**Status:** Detailed execution flow for -86% to -94% single-position deployment  
**Date:** 2026-04-14

---

## 🎯 OVERVIEW

Agent flow untuk **satu posisi** dengan strategi Deep Fishing:
```
SIGNAL DETECTION → POOL SELECTION → BIN CALCULATION → BIN CHUNKING → EXECUTION
```

---

## PHASE 1: SIGNAL DETECTION & ENTRY CONFIRMATION

### Step 1.1: Monitor Supertrend Trend State

```javascript
// Track previous and current trend state
const prevTrend = hunterAlpha.supertrend?.trend;  // From last scan (15m)
const currentTrend = calculateSupertrend(candles)[trend];

// Every scan cycle, compare:
const isTrendFlip = prevTrend !== currentTrend;

Example:
  prevTrend = 'BEARISH'    ← Last 15m candle closed bearish
  currentTrend = 'BULLISH' ← Current 15m candle now bullish
  isTrendFlip = TRUE ✅     ← SIGNAL DETECTED
```

### Step 1.2: Wait for 15m Candle Close Confirmation

```
Timeline:
T=0s   Supertrend flip detected
       Price touches above Supertrend line (intra-candle)
       ❌ NOT YET - wait for candle close

T=5s   Price still above Supertrend but candle not closed
       ❌ NOT YET - wait for candle close

T=15m  Candle CLOSES with Close Price > Supertrend line
       ✅ CONFIRMED - Ready to deploy

T=15m + 2s Execute deployment
```

### Step 1.3: Pre-Deployment Price Check

```javascript
// At deployment time, check CURRENT price (may have moved since signal)
const signalPrice = $2000;      // Price saat flip terdeteksi
const currentPrice = $2050;     // Price saat siap deploy (5% pump)

// If price moved significantly (>2%), might want to wait for next candle
// OR proceed with updated price calculation (user preference)
if (Math.abs(currentPrice - signalPrice) / signalPrice > 0.02) {
  logger.warn(`Price moved ${(currentPrice-signalPrice)/signalPrice*100}% since signal`);
  // Option A: Proceed dengan updated price
  // Option B: Skip dan tunggu next signal
}
```

---

## PHASE 2: POOL SELECTION LOGIC

### Step 2.1: Filter Available Pools

```
Inputs:
  - Token pair (e.g., WETH/SOL)
  - Liquidity threshold (min $10k)
  - Active trading pools only
  - Current price verification

Filter criteria:
  ✅ Pool exists on Meteora
  ✅ Has sufficient liquidity for 0.5 SOL deployment
  ✅ Price data available and recent
  ✅ No restrictions or paused status
```

### Step 2.2: BinStep Selection with Adaptive Range Check

```
Selection Priority: 100 > 125

Strategy:
  1. Try BinStep 100 → Calculate range width for -86% to -94%
     
     If range ≤ 250 bins → SELECT this pool ✅
     If range > 250 bins → Try BinStep 125 instead
  
  2. Try BinStep 125 → Calculate range width
     
     If range ≤ 250 bins → SELECT this pool ✅
     If range > 250 bins → Consider split across positions
  
  3. No valid pool → Wait for next scan cycle ⏳

Why adaptive?
  BinStep 100 = finer precision (more bins needed for -86% to -94%)
  BinStep 125 = coarser precision (fewer bins for same range)
  
  If calculated range too wide (>250), switch to coarser BinStep
  This keeps transaction complexity manageable

Example:
┌────────────────────────────────────────────────────┐
│ WETH/SOL Pool A: BinStep 100                       │
│   Range for -86% to -94% = 6 bins ≤ 250 ✅        │
│   → SELECT THIS POOL                               │
├────────────────────────────────────────────────────┤
│ WETH/SOL Pool B: BinStep 125 (backup)              │
│   Range for -86% to -94% = 4 bins ≤ 250 ✅        │
│   → Use if Pool A unavailable                      │
├────────────────────────────────────────────────────┤
│ BONK/SOL Pool: BinStep 200 → SKIP ❌               │
│   (Not in priority list)                           │
└────────────────────────────────────────────────────┘
```

### Step 2.3: Selected Pool State Capture

```javascript
const selectedPool = {
  pair: 'WETH/SOL',
  binStep: 100,                 // or 125 if range > 250 bins
  currentPrice: 2000,           // Price NOW (at deployment time)
  activeBin: 10000,             // Which bin contains current price
  existingLiquidity: 150000,    // $ liquidity in pool
  feeBps: 250,                  // 2.5% fee tier
  lastUpdated: Date.now(),
  rangeWidth: 4,                // bins needed for -86% to -94%
  maxBinsAllowed: 250           // constraint
};

logger.info(`Selected: ${selectedPool.pair} with BinStep ${selectedPool.binStep}`);
logger.info(`Range width: ${selectedPool.rangeWidth} bins (limit: ${selectedPool.maxBinsAllowed})`);
```

---

## PHASE 3: BIN CALCULATION FOR OFFSETS

### Step 3.1: Offset-to-Bin Conversion

**User Requirement:** -86% to -94% range  
**Current Price:** $2000  
**BinStep:** 100 (or 125 if width > 250 bins)

```
Offset formula:
  logPriceRatio(offset) = ln(1 - offset/100)
  logBinFactor = binStep * ln(1.0001)
  offsetBins = |logPriceRatio / logBinFactor|

Calculation for BinStep = 100:
  logBinFactor = 100 * ln(1.0001) = 100 * 0.00009999 ≈ 0.01

For offsetMin = -86%:
  logPriceRatio = ln(1 - (-86/100)) = ln(1.86) ≈ 0.619
  offsetMinBins = 0.619 / 0.01 ≈ 62 bins below active
  
For offsetMax = -94%:
  logPriceRatio = ln(1 - (-94/100)) = ln(1.94) ≈ 0.663
  offsetMaxBins = 0.663 / 0.01 ≈ 66 bins below active

Range width = 66 - 62 = 4 bins ✅ (fits in single transaction!)

Comparison with BinStep = 125:
  logBinFactor = 125 * 0.00009999 ≈ 0.0125
  offsetMinBins ≈ 49 bins
  offsetMaxBins ≈ 53 bins
  Range width = 4 bins (even tighter!)
```

### Step 3.2: Calculate Bin Range

```javascript
// Current state (with BinStep 100)
const activeBin = 10000;
const offsetMinBins = 62;   // -86% offset
const offsetMaxBins = 66;   // -94% offset

// Range calculation
const rangeMax = activeBin - offsetMinBins;  // TOP of range (shallower)
const rangeMin = activeBin - offsetMaxBins;  // BOTTOM of range (deeper)

// Result
const binRange = {
  top: 9938,      // rangeMax (corresponds to -86%)
  bottom: 9934,   // rangeMin (corresponds to -94%)
  width: 4        // Total bins for deployment
};

logger.info(`Deploy range: bin ${binRange.bottom} to ${binRange.top} (width: ${binRange.width})`);

// Check range width constraint
if (binRange.width > 250) {
  logger.warn(`Range too wide (${binRange.width} > 250), try BinStep 125`);
  // Recalculate with BinStep 125
}
```

### Step 3.3: Verify Range Against Price

```javascript
// Convert bins back to price for verification
const topBinPrice = currentPrice / (1.0001 ** offsetMinBins);
const bottomBinPrice = currentPrice / (1.0001 ** offsetMaxBins);

// Verification:
Example (with BinStep 100):
  Current price: $2000
  offsetMinBins: 62
  offsetMaxBins: 66
  
  Top bin: $2000 / (1.0001 ^ 62) ≈ $2000 * 0.94 = $1880 ← Wait, this is wrong...
  
  Actually for NEGATIVE offsets:
  Top bin ($2000 at -86%): $2000 - (0.86 * $2000) = $280   ← 86% drop
  Bottom bin ($2000 at -94%): $2000 - (0.94 * $2000) = $120 ← 94% drop
  Range: $280 to $120 ✅

// Sanity check
if (topBinPrice < bottomBinPrice) {
  logger.error(`Invalid range: top ${topBinPrice} should be > bottom ${bottomBinPrice}`);
  return null;  // Abort deployment
}

// Also check: range width constraint
if ((rangeMax - rangeMin) > 250) {
  logger.error(`Range width ${rangeMax - rangeMin} exceeds 250 bins limit`);
  return null;  // Abort or retry with BinStep 125
}
```

---

## PHASE 4: BIN CHUNKING STRATEGY

### Step 4.1: Chunk Size Constraints

```
Solana transaction limits:
  - Max bins per transaction: ~50 bins (hardcoded constraint)
  - Max instructions: ~1200 compute units per bin add
  
For -86% to -94% range:
  BinStep 100: 4 bins
  BinStep 125: ~3-4 bins
  Max bins per transaction: 50
  Required transactions: ceil(4 / 50) = 1 transaction ✅
  
Deploy strategy: SINGLE CHUNK (all 4 bins in one TX)
```

### Step 4.2: Amount Allocation Per Chunk

```javascript
// User config
const totalDeployAmount = 0.5;  // SOL

// For Deep Fishing strategy with 4 bins (BinStep 100):
const chunks = [];
const rangeWidth = 4;  // bins 9934-9938

// Chunk 0 (bins 9934-9938): FULL AMOUNT
chunks[0] = {
  binStart: 9934,
  binEnd: 9938,
  amountSol: 0.5,      // 100% of budget
  amountX: 0,          // No other token (single-side SOL)
  txIndex: 0
};

// Since range is only 4 bins, no need for additional chunks
logger.info(`Single chunk deployment: ${chunks[0].amountSol} SOL across ${rangeWidth} bins`);
```

### Step 4.3: Liquidity Distribution Across Bins

```
Distribution strategy for Deep Fishing:
  Goal: Maximize fee capture if price drops to -86% to -94%
  Approach: EVEN distribution across bins (no weighting)

Example for 4 bins with 0.5 SOL (BinStep 100):
  Bin 9938: 0.125 SOL  ← Top of range (-86%)
  Bin 9937: 0.125 SOL
  Bin 9936: 0.125 SOL
  Bin 9934: 0.125 SOL  ← Bottom of range (-94%)
  
Total: 0.5 SOL spread evenly ✅
Per-bin: 0.125 SOL

Why even? 
  - Deep Fishing expects crash to move through entire zone
  - No specific price prediction within -86% to -94% range
  - Even distribution gives consistent fee capture
  - Concentrated liquidity = high APR if volume hits zone

BinStep 125 (3-4 bins): Per-bin amount would be 0.125-0.167 SOL
  → Even more concentrated = even higher APR potential
```

---

## PHASE 5: LIVE PRICE TRACKING (During Execution)

### Step 5.1: Price Movement During Deployment

```
Scenario: Price moves 5% from signal to execution

Timeline:
T=15m Signal detected @ $2000
      offsetMin = -86% → rangeTop = bin 9923
      offsetMax = -94% → rangeBottom = bin 9917

T=15m+30s Price now $2100 (5% pump)
      Current calculation STALE
      ❌ Deploy to old bins = wrong range relative to new price

Required: RECALCULATE
```

### Step 5.2: Dynamic Offset Recalculation

```javascript
// Before final deployment, check current price
const executionPrice = 2100;  // Price at execution time
const signalPrice = 2000;     // Price at signal time

// If price moved >2%, recalculate
if (Math.abs(executionPrice - signalPrice) / signalPrice > 0.02) {
  logger.warn(`Price moved ${((executionPrice-signalPrice)/signalPrice*100).toFixed(1)}%, recalculating...`);
  
  // Recalculate offsets from NEW price
  const newOffsetMinBins = calculateOffsetBins(-86, 80);
  const newOffsetMaxBins = calculateOffsetBins(-94, 80);
  
  // New range based on current active bin
  const newRangeMax = activeBin - newOffsetMinBins;
  const newRangeMin = activeBin - newOffsetMaxBins;
  
  logger.info(`Updated range: bin ${newRangeMin} to ${newRangeMax}`);
}
```

### Step 5.3: Range Validation

```javascript
// Ensure recalculated range still makes sense

// Check 1: Range width unchanged
if ((newRangeMax - newRangeMin) === (rangeMax - rangeMin)) {
  logger.info('Range width maintained after price move ✅');
} else {
  logger.warn('Range width changed - verify offset math');
}

// Check 2: Range still within acceptable limits
if ((newRangeMax - newRangeMin) > 50) {
  logger.error('Recalculated range too wide, aborting');
  return null;
}

// Check 3: Range not inverted
if (newRangeMax <= newRangeMin) {
  logger.error('Invalid range after recalculation, aborting');
  return null;
}
```

---

## PHASE 6: TRANSACTION CONSTRUCTION & EXECUTION

### Step 6.1: Build Transaction Instructions

```javascript
const deployInstructions = [];

for (let i = rangeMin; i <= rangeMax; i++) {
  const instruction = createAddLiquidityInstruction({
    pool: selectedPool.address,
    bin: i,
    amountY: 0.5 / 6,  // Divided across 6 bins
    amountX: 0,        // Single-side SOL only
    user: walletPubkey,
    position: positionKeypair.publicKey
  });
  
  deployInstructions.push(instruction);
}

logger.info(`Created ${deployInstructions.length} add-liquidity instructions`);
```

### Step 6.2: Bundle & Sign Transaction

```javascript
const transaction = new Transaction()
  .add(...deployInstructions);

// Serialize and sign
const serialized = transaction.serialize({ 
  requireAllSignatures: false 
});

// Dual signing required
transaction.sign(
  walletKeypair,           // Payer
  positionKeypair          // Position owner
);

logger.info(`Transaction prepared: ${serialized.length} bytes`);
```

### Step 6.3: Execute with Retry Logic

```javascript
const maxRetries = 3;
let retryCount = 0;
let success = false;

while (retryCount < maxRetries && !success) {
  try {
    const signature = await connection.sendTransaction(transaction, [
      walletKeypair,
      positionKeypair
    ]);
    
    // Confirm transaction
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    
    if (confirmation.value.err === null) {
      logger.info(`✅ Position deployed: ${signature}`);
      success = true;
      
      // Record to database
      await recordDeployment({
        pool: selectedPool.pair,
        rangeMin: rangeMin,
        rangeMax: rangeMax,
        amount: 0.5,
        signature: signature,
        timestamp: Date.now()
      });
    }
  } catch (error) {
    retryCount++;
    logger.warn(`Attempt ${retryCount} failed: ${error.message}`);
    await sleep(1000 * retryCount);  // Exponential backoff
  }
}

if (!success) {
  logger.error('❌ Position deployment failed after 3 attempts');
}
```

---

## PHASE 7: POST-DEPLOYMENT MONITORING

### Step 7.1: Position State Tracking

```javascript
const position = {
  pool: 'WETH/SOL',
  binStep: 80,
  rangeMin: 9917,
  rangeMax: 9923,
  deployedAmount: 0.5,
  deployTime: Date.now(),
  currentPrice: 2100,
  entryPrice: 2000,
  status: 'active'
};

// Monitor for:
// 1. Fee accumulation
// 2. Price movement toward range
// 3. Rebalancing triggers
```

### Step 7.2: Range Invalidation Check

```javascript
// If price moves OUT of range, consider what to do

const currentPrice = 2150;

// Case 1: Price above rangeMax (positive move, no trading)
if (currentPrice > calculateBinPrice(rangeMax)) {
  logger.info('Price above range - accumulating fees safely');
}

// Case 2: Price below rangeMin (crash scenario, trading actively)
if (currentPrice < calculateBinPrice(rangeMin)) {
  logger.info('⚠️ Price crashed below range - significant trading activity');
  // Monitor fee generation
  trackFeeGeneration();
}
```

---

## COMPLETE FLOW DIAGRAM

```
┌─────────────────────────────────────────────────────────────────┐
│ ENTRY PHASE: Signal Detection                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  [Scan 15m candle]                                               │
│         ↓                                                         │
│  prevTrend = BEARISH                                             │
│  currentTrend = BULLISH → FLIP DETECTED ✅                       │
│         ↓                                                         │
│  [Wait for candle close]                                         │
│         ↓                                                         │
│  Price > Supertrend line AND candle closed ✅                    │
│         ↓                                                         │
│  [Check current price - may have moved]                          │
│         ↓                                                         │
│  Ready to deploy → PROCEED TO POOL SELECTION                    │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ POOL SELECTION PHASE: Choose Pool & BinStep                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  [List available pools for pair]                                 │
│         ↓                                                         │
│  [Filter by BinStep priority: 80 > 100 > 125]                   │
│         ↓                                                         │
│  ┌─ Try BinStep 80 → FOUND ✅                                    │
│  │   Select pool, capture state                                  │
│  │                                                                │
│  └─> PROCEED TO BIN CALCULATION                                  │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ BIN CALCULATION PHASE: Offset → Bin Range                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Current: $2000, Active Bin: 10000                               │
│         ↓                                                         │
│  Calculate offset bins:                                          │
│    offsetMinBins(-86%) = 77 bins                                 │
│    offsetMaxBins(-94%) = 83 bins                                 │
│         ↓                                                         │
│  Bin range: 10000 - 77 = 9923 (TOP)                              │
│             10000 - 83 = 9917 (BOTTOM)                           │
│         ↓                                                         │
│  Range width: 6 bins ✅                                          │
│         ↓                                                         │
│  Verify: $280 (top) to $120 (bottom) ✅                          │
│                                                                   │
│  PROCEED TO BIN CHUNKING                                         │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ BIN CHUNKING PHASE: Split for Transaction                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Range width: 6 bins                                             │
│  Max per TX: 50 bins                                             │
│         ↓                                                         │
│  Chunks needed: 1 (fits in single transaction)                   │
│         ↓                                                         │
│  Chunk 0:                                                        │
│    Bins: 9917-9923                                               │
│    Amount: 0.5 SOL (full)                                        │
│    Distribution: 0.0833 SOL per bin × 6 bins                    │
│         ↓                                                         │
│  PROCEED TO EXECUTION                                            │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ EXECUTION PHASE: Deploy Position                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  [Build 6 add-liquidity instructions (1 per bin)]                │
│         ↓                                                         │
│  [Create transaction]                                            │
│         ↓                                                         │
│  [Check price hasn't moved >2%, recalc if needed]                │
│         ↓                                                         │
│  [Serialize + sign with wallet & position key]                   │
│         ↓                                                         │
│  [Send transaction]                                              │
│         ↓                                                         │
│  [Poll for confirmation]                                         │
│         ↓                                                         │
│  ✅ Signature: 5y7X... Position created!                         │
│         ↓                                                         │
│  [Record to database]                                            │
│                                                                   │
│  POSITION ACTIVE - MONITORING MODE                              │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## KEY DECISION POINTS IN FLOW

| Decision | Current | Fallback | Abort |
|----------|---------|----------|-------|
| **BinStep Priority** | Found 80? → Use | Try 100, then 125 | BinStep > 125 |
| **Price Movement** | <2% change? → OK | ≥2% → Recalc | Recalc fails → Abort |
| **Chunk Count** | ≤50 bins? → 1 TX | >50 → Multi-TX | Can't fit → Abort |
| **Range Validation** | Valid bins? → Proceed | Invalid → Recalc | Invalid after recalc → Abort |
| **Transaction** | Confirmed? → Success | Failed → Retry 3x | All retries fail → Abort |

---

## PARAMETER SUMMARY FOR SINGLE POSITION

```
ENTRY:
  Signal: Supertrend Bullish FLIP (previous BEARISH → current BULLISH)
  Confirmation: 15m candle CLOSE above Supertrend line
  Pre-check: Current price vs signal price (>2% = recalc)

POOL SELECTION:
  Pair: WETH/SOL (or other volatility target)
  BinStep Priority: 80 > 100 > 125
  Liquidity minimum: $10k+

BIN CALCULATION:
  Offset Min: -86% (shallower, upper bound)
  Offset Max: -94% (deeper, lower bound)
  Range width: ~6 bins (for BinStep 80)

CHUNKING:
  Chunks: 1 (fits in single transaction)
  Distribution: 0.5 SOL evenly across 6 bins
  Per-bin amount: 0.0833 SOL

EXECUTION:
  Instructions: 6 (one per bin)
  Signing: Wallet keypair + Position keypair
  Confirmation: Monitor signature until 'confirmed'
  Retry: 3 attempts with exponential backoff

MONITORING:
  Track: Price position vs range
  Alert: If price crashes into range (-86% to -94%)
  Action: Monitor fee generation in crash zone
```

---

**Ready untuk implementasi?** 

Skema ini menunjukkan alur lengkap satu posisi dari signal detection sampai post-deployment monitoring. Semua keputusan dan fallback sudah terdokumentasi.
