# Deployment Runbook

Production incident response and staged rollout guide.

---

## 1. RPC Failure

**Detection Signal:**
- Connection errors in bot logs: `connection refused` or `socket hang up`
- Transaction broadcast timeouts (>10s repeated)
- `getSlot()` failures on primary RPC endpoint

**Immediate Action:**
1. Check active RPC via `getThresholds().rpcEndpoint` or env var `SOLANA_RPC_URL`
2. Switch to backup RPC:
   ```bash
   export SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
   # or use second backup:
   export SOLANA_RPC_URL=https://solana-rpc.publicnode.com
   ```
3. Restart bot: `npm start` or send `/status` command to verify reconnection

**Recovery Verification:**
1. Run `/health` and confirm `rpcStatus: HEALTHY`
2. Execute test transaction: `/testslot` → should return current slot
3. Monitor logs for 5 minutes — no connection errors

**Escalation:**
- If both primary and backup RPCs fail: **Manual Halt** — pause autonomy
- Check RPC provider status page (Helius, Alchemy, etc.)
- Switch to alternative provider or self-hosted if possible
- Resume only after RPC confirmed stable

---

## 2. DexScreener Stale/Timeout

**Detection Signal:**
- Log entry: `historySuccess: false` in OHLCV fetch logs
- Repeated `DexScreener timeout after 5000ms` messages
- OHLCV data > 90 minutes stale (for 15m candles)

**Immediate Action:**
1. Check DexScreener status: curl https://api.dexscreener.com/latest/dex
2. Bot continues with fallback oracle chain: DexScreener → Jupiter → Meteora price
3. **Do not enter new positions** — skip entry until DexScreener recovers (cached fallback insufficient for confidence)
4. Monitor existing positions normally (exit logic uses on-chain price)

**Recovery Verification:**
1. Check logs for: `historySuccess: true` on next OHLCV fetch
2. Confirm OHLCV timestamp recent (within 5 minutes)
3. Entry screening resumes automatically once oracle logs show success

**Escalation:**
- If DexScreener down > 30 minutes: Check public status (status.dexscreener.com)
- Contact DexScreener support if extended outage
- Fallback: Use Jupiter price API for OHLCV approximation (less reliable)

---

## 3. Swap Fail / Manual Review

**Detection Signal:**
- Log: `LIQUIDITY_TRAP: insufficient liquidity for exit swap`
- Repeated swap failures (>2 consecutive attempts)
- Manual `/pause` command issued by operator

**Immediate Action:**
1. Pause bot: `/pause` — stops all autonomous entry/exit
2. Check position state in database:
   ```bash
   sqlite3 positions.db "SELECT poolAddress, bins, amountSol, pnlPct FROM positions WHERE status='active';"
   ```
3. Verify position still exists on chain via Meteora UI or scanner
4. If swap fails: **Manual close required**
   - Log into Meteora UI directly
   - Remove liquidity manually from affected position
   - Verify transaction settles on-chain

**Recovery Verification:**
1. Confirm position fully closed in DB: `status='closed'`
2. Verify on-chain: pool bin bins owned by bot are empty
3. Resume autonomy: `/resume`

**Escalation:**
- If manual close fails (UI error): Contact Meteora support with position details
- If swap blocked by chain: Wait 2 minutes and retry (temporary congestion)
- If persistent: Move capital to different token pair and redeploy

---

## 4. Circuit Breaker Tripped

**Detection Signal:**
- Telegram alert: `⚡ CIRCUIT BREAKER TRIPPED`
- Log entry: `slCount >= slCircuitBreakerCount (${config.slCircuitBreakerCount})`
- All autonomous operations halted

**Persistence note:** Circuit breaker state is written to `runtime-state.json`. A bot restart does **not** reset the pause — the cooldown continues through restarts.

**Immediate Action:**
1. **Do NOT manually override** — circuit breaker is a safety mechanism
2. Wait for auto-pause timer: `slCircuitBreakerPauseMin` (default 60 minutes)
3. Monitor logs for auto-resume message:
   ```
   ✅ Hunter Circuit Breaker Reset — Buffer SL lama dibersihkan, hunter kembali normal.
   ```
4. On resume, bot automatically clears `recent-sl-events` and deletes `hunter-circuit-breaker` from state
5. If no auto-resume after 2× `pauseMin`: Check `runtime-state.json` → delete `hunter-circuit-breaker` key manually → restart bot

**Recovery Verification:**
1. Confirm `runtime-state.json` no longer has `hunter-circuit-breaker.pausedUntil`
2. After resume, confirm entry resumes: new positions in logs
3. Run `/health` → `circuitBreaker: CLOSED`
4. Check PnL over next 30 minutes — confirm positions profitable

**Escalation:**
- If circuit breaker trips repeatedly (>3× per day): Adjust `slCircuitBreakerCount` up or `stopLossPct` down
- Root cause: Underlying market conditions or strategy misalignment
- Review last 5 exits via `/positions history` to diagnose SL pattern
- Consider: if regime shows `BEAR_DEFENSE`, hunter is already blocking new entries — let it run

---

## 5. DB Recovery

**Detection Signal:**
- Log: `SQLite: database disk image malformed` or `SQLITE_READONLY`
- Bot cannot read/write positions table
- `/health` returns: `Database: UNHEALTHY`

**Immediate Action:**
1. Stop bot immediately: `npm stop`
2. Backup corrupt database:
   ```bash
   cp positions.db positions.db.backup.$(date +%s)
   ```
3. Check if recovery script exists:
   ```bash
   ls scripts/repairDb.js
   ```
4. If exists, run repair:
   ```bash
   node scripts/repairDb.js
   ```
5. If no script: Manual repair using SQLite CLI:
   ```bash
   sqlite3 positions.db
   > PRAGMA integrity_check;  # Check damage
   > VACUUM;                   # Attempt repair
   > .exit
   ```

**Recovery Verification:**
1. Check positions table is readable:
   ```bash
   sqlite3 positions.db "SELECT COUNT(*) FROM positions;"
   ```
2. Verify key columns exist: `poolAddress`, `bins`, `amountSol`, `status`
3. Restart bot: `npm start`
4. Confirm `/health` returns `Database: HEALTHY`

**Escalation:**
- If VACUUM fails: Database is corrupted beyond repair
- Restore from backup: `mv positions.db.backup.${TIMESTAMP} positions.db`
- **Reconcile with on-chain**: Manually query Meteora to list active positions, update DB
- If no backup and on-chain reconciliation impossible: Wipe DB and start fresh

---

## Regime Bear Defense — Entry Block Behavior

When `classifyMarketRegime()` returns `BEAR_DEFENSE`, hunter **hard-blocks all new entries** with policy code `REGIME_BEAR_DEFENSE`. No position is opened regardless of individual signal strength.

**What triggers BEAR_DEFENSE:**
- `supertrend.trend === 'BEARISH'`, OR
- `priceChangeH1 < -5%`

**Operator actions:**
- No intervention needed — this is correct behavior
- Existing positions continue to be managed by healer (exits still fire normally)
- Wait for regime to shift back to `BULL_TREND` or `SIDEWAYS_CHOP`
- Monitor: watch for `REGIME_BEAR_DEFENSE` policy blocks in logs

---

## Max Hold Exit Clustering

**Detection Signal:**
- Multiple Telegram notifications: `⏱ Max Hold Exit — CLOSE` within 1-2 hours
- All positions opened around the same time are force-closed together
- `exitTrigger: MAX_HOLD_EXIT` in exit_events table

**What it means:**
- Positions opened in same entry window reached `maxHoldHours` without TAE/SL trigger
- Indicates stagnant market — no strong exit signal materialized

**Immediate Action:**
1. Review market conditions — check if regime shifted to SIDEWAYS_CHOP
2. No intervention needed — this is dead capital cleanup working correctly
3. If clustering happens repeatedly: reduce `maxHoldHours` (6→4) in user-config.json

**Safe Resume:**
- Bot auto-resumes entry after max-hold positions close
- Confirm no circuit breaker trip accompanies clustering

---

## Operator Incident Quick Cards

### QC-1: Circuit Breaker Tripped
```
DETECT:  runtime-state.json has hunter-circuit-breaker.pausedUntil key
         Telegram "⚡ CIRCUIT BREAKER TRIPPED"
         logs: slCount >= slCircuitBreakerCount in window
NOTE:    SL_CLUSTER_THRESHOLD_MET will NOT appear in exit_events DB (schema-only)
FIRST 5 MIN:
  1. Do NOT override — this is a safety mechanism, not a bug
  2. Confirm hunter blocked: /health → circuitBreaker: OPEN
  3. Check SL cluster cause: /positions history → review last 3–5 exits
  4. Existing positions continue to be managed (exits still fire normally)
VERIFY:  Wait slCircuitBreakerPauseMin (default 60min) — state persists through restarts
         Telegram "✅ Hunter Circuit Breaker Reset" = safe to resume
         /health → circuitBreaker: CLOSED
         runtime-state.json: hunter-circuit-breaker key no longer present
ESCALATE IF: Trips >3× per day → increase slCircuitBreakerCount (3→4) or reduce stopLossPct
MANUAL RESET (emergency only): Delete hunter-circuit-breaker from runtime-state.json → restart
```

### QC-2: Data Stale / Unreliable Market Snapshot
```
DETECT:  Logs: historySuccess: false OR OHLCV timestamp > maxOhlcvStaleMinutes
         /providers shows DexScreener DEGRADED
         policy: 'FAIL_SAFE_UNRELIABLE_DATA' in logs (failSafeModeOnDataUnreliable=true triggered)
ACTION:  1. No new entries will be placed automatically (entry requires OHLCV confidence)
         2. FAIL_SAFE_UNRELIABLE_DATA blocks ALL entries if failSafeModeOnDataUnreliable=true in config
         3. Existing position exits continue using on-chain price (safe)
         4. Check DexScreener fallback chain: DexScreener → Jupiter → Meteora
RESUME:  Logs show historySuccess: true on next cycle
CHECK:   /providers → all HEALTHY
         Entry screening resumes automatically
ESCALATE IF: DexScreener down >30min AND Meteora price unreliable → /pause
```

### QC-3: Swap Unresolved / manual_review Lifecycle
```
DETECT:  Position stuck in status='manual_review' in DB
         Repeated swap failure logs
         Telegram: "LIQUIDITY_TRAP: insufficient liquidity"
ACTION:  1. /pause → stop autonomous operations
         2. sqlite3 positions.db "SELECT poolAddress,status FROM positions WHERE status='manual_review';"
         3. Verify position on-chain via Meteora UI
         4. Manual close if confirmed still open
         5. After manual close: UPDATE positions SET status='closed' WHERE position_address='...'
RESUME:  /resume after manual_review queue = 0
CHECK:   sqlite3 "SELECT COUNT(*) FROM positions WHERE status='manual_review';" → must be 0
ESCALATE IF: Manual close fails on Meteora UI → contact Meteora support with txHash
```

### QC-4: Max Hold Exits Clustering
```
DETECT:  Multiple "Max Hold Exit — CLOSE" Telegram alerts in short window
         exitTrigger='MAX_HOLD_EXIT' in exit_events for many positions same hour
FIRST 5 MIN:
  1. No intervention needed — this is dead capital cleanup working correctly
  2. /status → confirm positions are closed (not manual_review)
  3. Check: was regime SIDEWAYS_CHOP during holding period?
VERIFY:  Bot auto-resumes entry after positions close
         /health → no circuit breaker or error anomalies
CHECK:   If clustering repeats weekly: reduce maxHoldHours (6→4) in user-config.json
ESCALATE IF: Max-hold exits + circuit breaker trips simultaneously → /pause + root-cause review
```

### QC-5: Daily Drawdown Limit Breached
```
DETECT:  Log: "Daily loss limit reached" | dailyLossUsd >= dailyLossLimitUsd (default $25)
         Telegram: "⛔ DAILY LOSS LIMIT REACHED — autonomous ops paused"
FIRST 5 MIN:
  1. Bot auto-pauses new entries — no new positions will open
  2. Existing positions continue to be managed (exits still fire normally)
  3. /status → note dailyLossUsd, open position count, and current PnL
  4. /positions history → identify the SL pattern or single large loss causing breach
VERIFY:  /health → dailyLoss: LIMIT_REACHED
         No new entries in logs after pause trigger
RESUME:  Next UTC midnight — daily loss counter resets automatically
         /resume for manual override (only if root cause confirmed and addressed)
ESCALATE IF: Limit hit 3 consecutive days → reduce deployAmountSol or stopLossPct;
             audit regime classification to confirm BEAR_DEFENSE firing correctly
```

---

## Staged Rollout Gate

### Canary Stage (≤ 1 position)

**Pre-flight Requirements (ALL must pass):**
- `/preflight` score ≥ 85/100
- `circuitBreaker = CLOSED` (check runtime-state.json)
- `pendingReconcile = 0`
- Error rate < 2 errors/min (last 5 min of logs)
- DexScreener success rate ≥ 95% (historySuccess: true on last 5 fetches)

**Entry:**
```bash
/stage canary 1
/autoscreen on 15
```

**Promotion Criteria (ALL must be met before advancing):**
- ≥ 3 positions closed (entry → exit cycle completed, not just opened)
- No `CIRCUIT_BREAKER_ACTIVE` trip
- No `manual_review` queue entries
- Cumulative PnL ≥ –(dailyLossLimitUsd × 0.5) [i.e., within half the daily cap]
- DexScreener degraded time < 5% of monitoring window

**Rollback Triggers:**
- Any unhandled exception in logs
- `manual_review` queue > 0
- Single position loss > stopLossPct × 1.5

---

### Limited Stage (≤ 3 positions)

**Entry:**
```bash
/stage canary 3
/autoscreen on 15
```

**Promotion Criteria (ALL must be met before advancing):**
- ≥ 5 positions closed
- Win rate ≥ 30% (exits via TAKE_PROFIT or TRAILING_TAKE_PROFIT ÷ total exits)
- Circuit breaker not tripped during this stage
- No cascading exits (≥ 2 simultaneous SL closures)
- Cumulative PnL ≥ –dailyLossLimitUsd

**Rollback Triggers:**
- Circuit breaker trips during stage
- Cumulative PnL < –dailyLossLimitUsd
- `manual_review` count > 1

---

### Full Stage

**Entry:**
```bash
/stage full
/autoscreen on 15
```

**Minimum Sample Before Trusting Results:**
- ≥ 10 positions closed across BULL_TREND and SIDEWAYS_CHOP regimes
- ≥ 7 days of operation

**Continuous Monitoring:**
- `/status` every 15 minutes during trading hours
- `/health` once per hour
- Daily: `/positions history` — confirm exit distribution across trigger codes

**Abort Triggers (immediate /pause):**
- `CIRCUIT_BREAKER_ACTIVE` trips
- `manual_review` queue > 1
- 2+ simultaneous SL closures within 10 minutes
- Error rate ≥ 5 errors/min for 2 consecutive minutes
- DexScreener degraded > 15% of a 1-hour window

**Rollback to Canary:**
- After abort: minimum 60-minute cooldown before retry
- Re-run `/preflight` — must score ≥ 85 before re-entry
- Document root cause before resuming

---

## When to Pause Autonomy Checklist

| Condition | Action | Resume After |
|-----------|--------|--------------|
| **RPC failures** | `/pause` → switch RPC → `/resume` | RPC healthy + 1 successful getSlot |
| **DexScreener timeout** | Auto-pause entries only (exits continue) | historySuccess: true on next fetch |
| **Circuit breaker tripped** | Auto-pause (persisted), wait for timer | slCircuitBreakerPauseMin elapsed + runtime-state.json cleared |
| **Regime BEAR_DEFENSE** | No action needed — entry auto-blocked | Regime shifts to BULL_TREND or SIDEWAYS_CHOP |
| **Max hold exits clustering** | No action needed — dead capital cleanup | Review market regime; reduce maxHoldHours if recurring |
| **Manual review queued** | `/pause` if `autoPauseOnManualReview: true` | Review complete + `/resume` |
| **Swap failure** | `/pause` → manual close → `/resume` | Position fully closed on-chain |
| **3+ errors in 5 min** | Emergency `/pause` | Root cause identified + fix deployed |
| **Database corrupt** | Stop bot → repair → restart | DB integrity verified |

---

## Post-Deploy Checklist

After transitioning from shadow → canary → full:

1. ✅ Snapshot initial `/health` output
2. ✅ Monitor 6 hours for:
   - Failed operation counts (should be 0–1)
   - Manual review queue growth (should be stable)
   - Reconcile queue depth (should decline)
3. ✅ Check `/positions history` — confirm positions entering/exiting correctly
4. ✅ Verify `/health` hourly — no new unhealthy indicators
5. ✅ If anomalies detected: escalate to Limited stage immediately

---

---

## What Changed (2026-04-19)

| Module | Change | Impact |
|--------|--------|--------|
| `hunterAlpha.js` | `classifyMarketRegime()` gates all entries; BEAR_DEFENSE = hard block | No new positions during bearish regimes |
| `healerAlpha.js` | `MAX_HOLD_EXIT` trigger force-closes positions after `maxHoldHours` | Dead capital cleaned up automatically |
| `healerAlpha.js` | `recordStrategyPerformance()` called on close → updates `strategy-library.json` | Strategy confidence self-adjusts over time |
| `runtime/state.js` | Circuit breaker state persisted to `runtime-state.json` | Restart no longer resets pause timer |
| `strategyManager.js` | `Deep Fishing` added to BASELINE_STRATEGIES | `getStrategy('Deep Fishing')` now works without JSON file |
| `strategyManager.js` | `parseStrategyParameters` maps `single_side_y` → `strategyType: 2` | Correct bin deployment for single-sided strategies |

**Last Updated:** 2026-04-19
