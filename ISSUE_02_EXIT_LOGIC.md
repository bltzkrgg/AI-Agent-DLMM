# 🔴 ISSUE #2: EXIT LOGIC VAGUE & INCOMPLETE

---

## **MASALAH**

Current exit config:
```javascript
exit: {
  mode: 'supertrend_flip',
  emergencyStopLossPct: 95,
  takeProfitPct: 20,
}
```

**3 Problem:**

1. **Supertrend flip trigger tidak jelas:**
   - Flip terjadi? Exit langsung (1 menit)
   - Atau wait confirmation? (berapa lama?)
   - Hasilnya: Sering exit premature atau hold terlalu lama

2. **Stop loss 95% = catastrophic:**
   - Hold sampai loss 95% = sudah bankruptcy
   - Should be 5-10% max untuk wide range
   - Hasilnya: Circuit breaker sering trigger terlalu late

3. **Tidak ada time-based exit:**
   - Wide range position = bisa hold forever jika no flip signal
   - No "max hold time" rule
   - Hasilnya: Dead capital stuck in unprofitable position

---

## **CURRENT CODE LOCATION**

- `src/strategies/strategyManager.js:42-45` — exit config definition
- `src/agents/healerAlpha.js` — exit logic execution (unclear exactly where)

---

## **PROPOSED SOLUTION (Simple)**

Replace vague exit dengan clear rules:

```javascript
exit: {
  mode: 'supertrend_flip',
  confirmationCandles: 2,        // Wait 2 candles after flip
  stopLossPct: 8,               // Force exit if -8% (realistic)
  takeProfitPct: 15,            // Exit if +15% profit
  maxHoldHours: 24,             // Force close after 24h regardless
  partialExitPct: 50,           // Claim 50% profit at TP, hold rest
}
```

**Impact:**
- ✅ Clear exit triggers
- ✅ Realistic stop loss (not catastrophic)
- ✅ Dead capital doesn't hang forever
- ✅ Partial profit taking reduces risk

---

## **EFFORT & TIMELINE**

| Task | Effort | Time |
|------|--------|------|
| Define exit rules | Low | 1 hour (discussion) |
| Update strategyManager.js | Low | 30 min |
| Update healerAlpha.js logic | Medium | 2-3 hours |
| Test exit flows | Medium | 1-2 hours |
| **Total** | **Medium** | **4-6 hours** |

---

## **DECISION NEEDED**

Setuju dengan proposed exit rules? Atau ada preference lain?

**Specific questions:**

1. **Stop loss:** Accept 8%? Or berbeda?
2. **Take profit:** Accept 15%? Or target APR lain?
3. **Max hold:** Accept 24 hours? Or longer?
4. **Partial exit:** Exit 50% at TP, hold rest? Or 100% exit at TP?
5. **Supertrend confirmation:** Wait 2 candles after flip? Or immediately?

Once you confirm, we can code this immediately.

---

**Status:** Waiting for your confirmation on exit rules →
