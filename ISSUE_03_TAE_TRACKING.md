# 📊 ISSUE #3: ADD TAE EXIT TRACKING (Option C)

---

## **APA YANG PERLU DI-TRACK?**

Setiap kali position ditutup, capture ini 10 data points:

```javascript
{
  // Position info
  "positionAddress": "ABC123...",
  "poolAddress": "XYZ789...",
  "tokenMint": "SOL/USDC",
  
  // Entry data
  "entryTime": "2026-04-17T10:30:00Z",
  "entryPrice": 150.00,
  "deployedCapitalSol": 0.1,
  
  // Exit data
  "exitTime": "2026-04-17T14:45:00Z",
  "exitPrice": 155.00,
  "holdMinutes": 255,
  
  // PnL & fees
  "pnlPct": 3.33,
  "pnlUsd": 50.00,
  "feesClaimedUsd": 15.00,
  "totalReturnUsd": 65.00,
  
  // EXIT TRIGGER (Critical for analysis)
  "exitTrigger": "TRAILING_TP_HIT",  // or SUPERTREND_FLIP, OOR_BAILOUT, ZOMBIE, OVER_DUMP
  "exitZone": "ZONE_2_RUNNER",        // Which zone was position in
  "exitRetracement": 3.2,             // How much dropped from peak
  "exitRetrancementCap": 3.5,         // What was the cap
  
  // Fee tracking
  "feeRatioAtExit": 0.035,
  "feeVelocityIncreasing": true,
  "wasLPerPatienceActive": true,
  
  // Status
  "profitOrLoss": "PROFIT",  // or LOSS
  "exitReason": "TAE_WATCHDOG_EXIT_ZONE_2_RUNNER"
}
```

---

## **DI MANA DI-TRACK?**

### **Location 1: Exit Trigger Point**
File: `src/agents/healerAlpha.js`
- Line 1733 (TAE-LP EXIT)
- Line 1764 (ADAPTIVE ZAP OUT)
- Line 1796 (OOR HARD EXIT)
- Other exit locations

**Action:** Setiap kali `await closePositionDLMM()` dipanggil, capture exit metadata sebelumnya.

### **Location 2: Storage**
Create new file: `src/db/exitTracking.js`

```javascript
export function recordExitEvent(exitData) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO exit_events (
      position_address, pool_address, token_mint,
      entry_time, exit_time, hold_minutes,
      pnl_pct, pnl_usd, fees_usd,
      exit_trigger, exit_zone, exit_retracement,
      fee_ratio, lper_patience_active,
      profit_or_loss, exit_reason,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    exitData.positionAddress,
    exitData.poolAddress,
    exitData.tokenMint,
    // ... etc
  );
}
```

---

## **SCHEMA CHANGE NEEDED**

### **New Table: `exit_events`**

```sql
CREATE TABLE IF NOT EXISTS exit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_address TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  token_mint TEXT,
  
  -- Timing
  entry_time TEXT,
  exit_time TEXT,
  hold_minutes INTEGER,
  
  -- Financial
  pnl_pct REAL,
  pnl_usd REAL,
  fees_usd REAL,
  total_return_usd REAL,
  
  -- Exit metadata (CRITICAL)
  exit_trigger TEXT,           -- TRAILING_TP_HIT | SUPERTREND_FLIP | OOR | ZOMBIE | OVER_DUMP
  exit_zone TEXT,              -- ZONE_1 | ZONE_2 | ZONE_3
  exit_retracement REAL,       -- How much dropped from peak
  fee_ratio REAL,              -- Fee APR at time of exit
  lper_patience_active INTEGER, -- Boolean: was patience modifier active?
  
  -- Outcome
  profit_or_loss TEXT,         -- PROFIT | LOSS
  exit_reason TEXT,            -- Full reason string
  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(position_address) REFERENCES positions(position_address)
);
```

---

## **WHAT WE'LL LEARN (After 10-20 exits)**

### **Query 1: Which triggers actually profitable?**
```sql
SELECT exit_trigger, COUNT(*) as count, AVG(pnl_pct) as avg_pnl, 
       SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as wins
FROM exit_events
GROUP BY exit_trigger
ORDER BY avg_pnl DESC;

Output:
exit_trigger          | count | avg_pnl | wins
TRAILING_TP_HIT      | 8     | +4.5%   | 7
SUPERTREND_FLIP      | 5     | +2.1%   | 3
OOR_BAILOUT          | 4     | -1.2%   | 1
ZOMBIE_EXIT          | 2     | -5.3%   | 0

→ Insight: TRAILING_TP_HIT is best, OOR_BAILOUT hurts
```

### **Query 2: Does fee-patience modifier help?**
```sql
SELECT lper_patience_active, AVG(pnl_pct) as avg_pnl, COUNT(*) as count
FROM exit_events
GROUP BY lper_patience_active;

Output:
lper_patience_active | avg_pnl | count
0 (No patience)      | +1.8%   | 8
1 (Patient, fees up) | +3.5%   | 12

→ Insight: Patience modifier WORKS, helps profitability
```

### **Query 3: Zone retracement caps optimal?**
```sql
SELECT exit_zone, AVG(pnl_pct) as avg_pnl, AVG(hold_minutes) as avg_hold
FROM exit_events
GROUP BY exit_zone;

Output:
exit_zone      | avg_pnl | avg_hold
ZONE_1_SNIPER  | +2.1%   | 45
ZONE_2_RUNNER  | +3.8%   | 120
ZONE_3_MOONSHOT| +5.2%   | 240

→ Insight: ZONE_3 most profitable, maybe should adjust caps
```

---

## **IMPLEMENTATION EFFORT**

| Task | Effort | Time |
|------|--------|------|
| Create `exit_events` table | Low | 30 min |
| Create `exitTracking.js` helper | Low | 1 hour |
| Update `healerAlpha.js` to capture metadata | Medium | 2 hours |
| Add exit data points to DB insert | Low | 1 hour |
| Create analytics queries | Low | 1 hour |
| **TOTAL** | **Medium** | **5-6 hours** |

---

## **BENEFITS (After Implementation)**

✅ **Visible data** — Know which exit triggers work  
✅ **Optimize TAE** — Adjust caps/thresholds based on real results  
✅ **Detect problems** — Catch if strategy underperforming  
✅ **Build confidence** — Prove or disprove TAE effectiveness  
✅ **Future tuning** — Data foundation for improvements  

---

## **DECISION QUESTIONS**

1. **Database or JSON file?** (DB recommended, easier to query)
2. **Real-time tracking or batch insert?** (Real-time = capture immediately on exit)
3. **Retention:** Keep all historical data, or only last 30 days?

---

## **STATUS: Waiting for confirmation →**

Setuju dengan approach ini? Ada adjustment?

Once confirmed → Langsung code implementation.
