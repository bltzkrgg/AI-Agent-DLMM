# 🛠️ IMPLEMENTATION PLAN: TAE EXIT TRACKING

**Decision Confirmed:**
- Storage: Database ✅
- Timing: Real-time capture ✅
- Retention: Keep semua history ✅

---

## **STEP 1: Create `exit_events` Table**

**File:** `src/db/database.js` (add table creation)

```sql
CREATE TABLE IF NOT EXISTS exit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_address TEXT NOT NULL UNIQUE,
  pool_address TEXT NOT NULL,
  token_mint TEXT,
  
  -- Entry timing
  entry_time TEXT,
  entry_price REAL,
  
  -- Exit timing & price
  exit_time TEXT,
  exit_price REAL,
  hold_minutes INTEGER,
  
  -- PnL & returns
  pnl_pct REAL,
  pnl_usd REAL,
  fees_claimed_usd REAL,
  total_return_usd REAL,
  
  -- TAE exit metadata
  exit_trigger TEXT,            -- TRAILING_TP_HIT | SUPERTREND_FLIP | OOR_BAILOUT | ZOMBIE | OVER_DUMP
  exit_zone TEXT,               -- ZONE_1_SNIPER | ZONE_2_RUNNER | ZONE_3_MOONSHOT
  exit_retracement REAL,        -- Persentase drop dari peak
  exit_retracement_cap REAL,    -- Cap yang di-set untuk zone itu
  
  -- Fee & modifier status saat exit
  fee_ratio_at_exit REAL,       -- feeUsd / tvl
  fee_velocity_increasing INTEGER, -- 1 = true, 0 = false
  lper_patience_active INTEGER, -- 1 = true, 0 = false (fee modifier applied?)
  
  -- Outcome
  profit_or_loss TEXT,          -- PROFIT | LOSS | BREAKEVEN
  exit_reason TEXT,             -- Full description
  close_reason_code TEXT,       -- Code dari closePositionDLMM reason
  
  -- Metadata
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(position_address) REFERENCES positions(position_address)
);

CREATE INDEX IF NOT EXISTS idx_exit_trigger ON exit_events(exit_trigger);
CREATE INDEX IF NOT EXISTS idx_exit_zone ON exit_events(exit_zone);
CREATE INDEX IF NOT EXISTS idx_created_at ON exit_events(created_at);
```

**Effort:** 30 menit

---

## **STEP 2: Create `src/db/exitTracking.js` Helper**

```javascript
// src/db/exitTracking.js

import db from './database.js';

export function recordExitEvent(exitData) {
  try {
    const stmt = db.prepare(`
      INSERT INTO exit_events (
        position_address, pool_address, token_mint,
        entry_time, entry_price,
        exit_time, exit_price, hold_minutes,
        pnl_pct, pnl_usd, fees_claimed_usd, total_return_usd,
        exit_trigger, exit_zone, exit_retracement, exit_retracement_cap,
        fee_ratio_at_exit, fee_velocity_increasing, lper_patience_active,
        profit_or_loss, exit_reason, close_reason_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      exitData.positionAddress,
      exitData.poolAddress,
      exitData.tokenMint,
      exitData.entryTime,
      exitData.entryPrice,
      exitData.exitTime,
      exitData.exitPrice,
      exitData.holdMinutes,
      exitData.pnlPct,
      exitData.pnlUsd,
      exitData.feesClaimedUsd,
      exitData.totalReturnUsd,
      exitData.exitTrigger,
      exitData.exitZone,
      exitData.exitRetracement,
      exitData.exitRetrancementCap,
      exitData.feeRatioAtExit,
      exitData.feeVelocityIncreasing ? 1 : 0,
      exitData.lperPatienceActive ? 1 : 0,
      exitData.profitOrLoss,
      exitData.exitReason,
      exitData.closeReasonCode
    );
    
    console.log(`[exitTracking] Recorded exit: ${exitData.positionAddress} (${exitData.exitTrigger})`);
  } catch (e) {
    console.error(`[exitTracking] Error recording exit:`, e.message);
  }
}

// Query helpers
export function getExitsByTrigger() {
  return db.prepare(`
    SELECT exit_trigger, COUNT(*) as count, 
           AVG(pnl_pct) as avg_pnl,
           SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
           AVG(hold_minutes) as avg_hold_minutes
    FROM exit_events
    GROUP BY exit_trigger
    ORDER BY avg_pnl DESC
  `).all();
}

export function getExitsByZone() {
  return db.prepare(`
    SELECT exit_zone, COUNT(*) as count,
           AVG(pnl_pct) as avg_pnl,
           AVG(hold_minutes) as avg_hold
    FROM exit_events
    GROUP BY exit_zone
  `).all();
}

export function getPatientExitAnalysis() {
  return db.prepare(`
    SELECT lper_patience_active, AVG(pnl_pct) as avg_pnl,
           COUNT(*) as count,
           SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as wins
    FROM exit_events
    GROUP BY lper_patience_active
  `).all();
}

export function getRecentExits(limit = 10) {
  return db.prepare(`
    SELECT * FROM exit_events 
    ORDER BY created_at DESC 
    LIMIT ?
  `).all(limit);
}
```

**Effort:** 1 jam

---

## **STEP 3: Update `healerAlpha.js` - Inject Tracking**

**Locations to modify:**

### **3a. Trailing TP Exit (Line ~1733)**
```javascript
// BEFORE
await closePositionDLMM(pos.pool_address, pos.position_address, {
  pnlUsd: posSnapshot.pnlUsd, pnlPct: posSnapshot.pnlPct, feesUsd: posSnapshot.feesUsd,
  closeReason: `TAE_WATCHDOG_EXIT_${zone.replace(/ /g, '_')}`, lifecycleState: 'closed_panic'
}, { isUrgent: true });

// AFTER - Capture exit data BEFORE closing
const exitData = {
  positionAddress: pos.position_address,
  poolAddress: pos.pool_address,
  tokenMint: pos.token_x || pos.token_y,
  entryTime: pos.created_at,
  entryPrice: pos.entry_price || 0,
  exitTime: new Date().toISOString(),
  exitPrice: currentPrice,
  holdMinutes: Math.floor((Date.now() - new Date(pos.created_at)) / 60000),
  pnlPct: pnlPct,
  pnlUsd: posSnapshot.pnlUsd,
  feesClaimedUsd: posSnapshot.feesUsd,
  totalReturnUsd: (posSnapshot.pnlUsd || 0) + (posSnapshot.feesUsd || 0),
  exitTrigger: 'TRAILING_TP_HIT',
  exitZone: zone,
  exitRetracement: retracementDrop,
  exitRetrancementCap: retracementCap,
  feeRatioAtExit: feeRatio,
  feeVelocityIncreasing: isFeeVelocityIncreasing,
  lperPatienceActive: isLPerPatienceEnabled,
  profitOrLoss: pnlPct > 0 ? 'PROFIT' : pnlPct < 0 ? 'LOSS' : 'BREAKEVEN',
  exitReason: `Trailing TP hit at ${zone}. Peak PnL: +${peak.toFixed(2)}%, Exit: +${pnlPct.toFixed(2)}%`,
  closeReasonCode: `TAE_WATCHDOG_EXIT_${zone.replace(/ /g, '_')}`
};
recordExitEvent(exitData);

await closePositionDLMM(pos.pool_address, pos.position_address, {
  pnlUsd: posSnapshot.pnlUsd, pnlPct: posSnapshot.pnlPct, feesUsd: posSnapshot.feesUsd,
  closeReason: exitData.closeReasonCode, lifecycleState: 'closed_panic'
}, { isUrgent: true });
```

### **3b. Supertrend Flip Exit (Line ~1764)**
```javascript
// Similar pattern, tapi exitTrigger = 'SUPERTREND_FLIP'
exitData.exitTrigger = 'SUPERTREND_FLIP';
exitData.exitReason = `Trend flipped to BEARISH at ${zone}. Profit locked.`;
recordExitEvent(exitData);
```

### **3c. OOR Bailout (Line ~1796)**
```javascript
// exitTrigger = 'OOR_BAILOUT'
exitData.exitTrigger = 'OOR_BAILOUT';
exitData.exitReason = `Out of range > 15 minutes. Emergency exit.`;
recordExitEvent(exitData);
```

### **3d. Zombie Pool Exit (Line ~1674)**
```javascript
// exitTrigger = 'ZOMBIE_EXIT'
exitData.exitTrigger = 'ZOMBIE_EXIT';
exitData.exitReason = `Zombie pool: ${reason === "FEE_STAGNATION" ? "No fees for 1h" : "Volume < $400k"}`;
recordExitEvent(exitData);
```

### **3e. Over-dump Emergency (Add new section)**
```javascript
// exitTrigger = 'OVER_DUMP_EXIT'
if (pnlPct < -20) {
  exitData.exitTrigger = 'OVER_DUMP_EXIT';
  exitData.exitReason = `Emergency exit: PnL < -20% (${pnlPct.toFixed(2)}%)`;
  recordExitEvent(exitData);
}
```

**Effort:** 2-3 jam (hati-hati inject di multiple locations)

---

## **STEP 4: Import & Init**

**File: `src/agents/healerAlpha.js` (top)**
```javascript
import { recordExitEvent } from '../db/exitTracking.js';
```

**Effort:** 5 menit

---

## **STEP 5: Add Analytics Endpoint (Optional)**

**File: `src/index.js` - add Telegram command**
```javascript
bot.onText(/\/tae_stats/, async (msg) => {
  const exitsByTrigger = getExitsByTrigger();
  const exitsByZone = getExitsByZone();
  const patientAnalysis = getPatientExitAnalysis();
  
  const report = `
📊 *TAE ANALYTICS*

*By Exit Trigger:*
${exitsByTrigger.map(r => 
  `${r.exit_trigger}: ${r.count} exits, avg PnL ${r.avg_pnl.toFixed(2)}%, win rate ${((r.wins/r.count)*100).toFixed(0)}%`
).join('\n')}

*By Zone:*
${exitsByZone.map(r =>
  `${r.exit_zone}: avg PnL ${r.avg_pnl.toFixed(2)}%, hold ${r.avg_hold.toFixed(0)}m`
).join('\n')}

*Patience Modifier Impact:*
${patientAnalysis.map(r =>
  `${r.lper_patience_active ? 'Active' : 'Inactive'}: ${r.avg_pnl.toFixed(2)}% avg`
).join('\n')}
  `;
  
  await notify(report);
});
```

**Effort:** 1 jam (optional)

---

## **TIMELINE TOTAL**

| Step | Task | Effort | Time |
|------|------|--------|------|
| 1 | Create table | Low | 30 min |
| 2 | Create exitTracking.js | Low | 1 jam |
| 3 | Inject tracking di healerAlpha | Medium | 2-3 jam |
| 4 | Import & init | Low | 5 min |
| 5 | Analytics endpoint (optional) | Low | 1 jam |
| **TOTAL** | | **Medium** | **4.5-5.5 jam** |

---

## **TESTING CHECKLIST**

Sebelum go live:
- [ ] Database table created & indexed
- [ ] exitTracking.js helper functions work
- [ ] Dry run 1 position closing → data captured
- [ ] Query `getExitsByTrigger()` returns correct data
- [ ] Telegram `/tae_stats` command works (if implemented)

---

## **SIAP DIMULAI?**

Konfigurasi sudah clear. Mau aku mulai Step 1 (create table)?

Atau ada pertanyaan dulu sebelum code?