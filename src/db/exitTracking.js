/**
 * Exit Events Tracking
 * Captures TAE exit data untuk analysis & optimization
 */

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

    console.log(`[exitTracking] ✅ Recorded: ${exitData.positionAddress} (${exitData.exitTrigger}, PnL: ${exitData.pnlPct.toFixed(2)}%)`);
    return true;
  } catch (e) {
    console.error(`[exitTracking] ❌ Error recording exit:`, e.message);
    return false;
  }
}

/**
 * Query: Exit performance by trigger type
 * Shows which exit signals are most profitable
 */
export function getExitsByTrigger() {
  try {
    return db.prepare(`
      SELECT
        exit_trigger,
        COUNT(*) as count,
        ROUND(AVG(pnl_pct), 2) as avg_pnl_pct,
        ROUND(AVG(pnl_usd), 2) as avg_pnl_usd,
        SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
        ROUND(AVG(hold_minutes), 0) as avg_hold_minutes,
        MAX(pnl_pct) as best_pnl,
        MIN(pnl_pct) as worst_pnl
      FROM exit_events
      GROUP BY exit_trigger
      ORDER BY avg_pnl_pct DESC
    `).all();
  } catch (e) {
    console.error('[exitTracking] Error in getExitsByTrigger:', e.message);
    return [];
  }
}

/**
 * Query: Exit performance by zone
 * Shows which profit zones have best outcomes
 */
export function getExitsByZone() {
  try {
    return db.prepare(`
      SELECT
        exit_zone,
        COUNT(*) as count,
        ROUND(AVG(pnl_pct), 2) as avg_pnl_pct,
        ROUND(AVG(hold_minutes), 0) as avg_hold,
        SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
        ROUND(AVG(exit_retracement), 2) as avg_retracement
      FROM exit_events
      GROUP BY exit_zone
      ORDER BY avg_pnl_pct DESC
    `).all();
  } catch (e) {
    console.error('[exitTracking] Error in getExitsByZone:', e.message);
    return [];
  }
}

/**
 * Query: LP Patience modifier effectiveness
 * Does holding longer (with high fees) improve outcomes?
 */
export function getPatientExitAnalysis() {
  try {
    return db.prepare(`
      SELECT
        CASE WHEN lper_patience_active = 1 THEN 'Active (High Fee)' ELSE 'Inactive (Low Fee)' END as mode,
        COUNT(*) as count,
        ROUND(AVG(pnl_pct), 2) as avg_pnl_pct,
        SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
        ROUND(CAST(SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as float) / COUNT(*) * 100, 1) as win_rate_pct,
        ROUND(AVG(hold_minutes), 0) as avg_hold_minutes
      FROM exit_events
      GROUP BY lper_patience_active
    `).all();
  } catch (e) {
    console.error('[exitTracking] Error in getPatientExitAnalysis:', e.message);
    return [];
  }
}

/**
 * Query: Recent exits untuk dashboard/monitoring
 */
export function getRecentExits(limit = 10) {
  try {
    return db.prepare(`
      SELECT
        position_address, pool_address, token_mint,
        exit_time, hold_minutes,
        pnl_pct, pnl_usd, fees_claimed_usd,
        exit_trigger, exit_zone, profit_or_loss,
        ROUND(AVG(pnl_pct) OVER (PARTITION BY exit_trigger), 2) as trigger_avg_pnl
      FROM exit_events
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
  } catch (e) {
    console.error('[exitTracking] Error in getRecentExits:', e.message);
    return [];
  }
}

/**
 * Query: Overall TAE system performance
 */
export function getTAESummary() {
  try {
    const summary = db.prepare(`
      SELECT
        COUNT(*) as total_exits,
        ROUND(AVG(pnl_pct), 2) as overall_avg_pnl,
        SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as total_wins,
        ROUND(CAST(SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as float) / COUNT(*) * 100, 1) as overall_win_rate,
        ROUND(AVG(hold_minutes), 0) as avg_hold,
        MAX(pnl_pct) as best_exit,
        MIN(pnl_pct) as worst_exit,
        ROUND(SUM(pnl_usd), 2) as total_pnl_usd,
        ROUND(SUM(fees_claimed_usd), 2) as total_fees
      FROM exit_events
    `).get();

    return summary || {};
  } catch (e) {
    console.error('[exitTracking] Error in getTAESummary:', e.message);
    return {};
  }
}

/**
 * Query: Trigger effectiveness comparison
 * Detailed breakdown per trigger
 */
export function getTriggerComparison() {
  try {
    return db.prepare(`
      SELECT
        exit_trigger,
        COUNT(*) as total,
        SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl_pct <= 0 THEN 1 ELSE 0 END) as losses,
        ROUND(CAST(SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as float) / COUNT(*) * 100, 1) as win_rate,
        ROUND(AVG(pnl_pct), 2) as avg_pnl_pct,
        ROUND(AVG(pnl_usd), 2) as avg_pnl_usd,
        ROUND(AVG(hold_minutes), 0) as avg_hold_min,
        MAX(pnl_pct) as best,
        MIN(pnl_pct) as worst
      FROM exit_events
      GROUP BY exit_trigger
      ORDER BY win_rate DESC, avg_pnl_pct DESC
    `).all();
  } catch (e) {
    console.error('[exitTracking] Error in getTriggerComparison:', e.message);
    return [];
  }
}

/**
 * Export: Get all exit events (for backup/analysis)
 */
export function getAllExitEvents() {
  try {
    return db.prepare('SELECT * FROM exit_events ORDER BY created_at DESC').all();
  } catch (e) {
    console.error('[exitTracking] Error in getAllExitEvents:', e.message);
    return [];
  }
}

/**
 * Stats: Count total exits recorded
 */
export function getExitEventCount() {
  try {
    return db.prepare('SELECT COUNT(*) as count FROM exit_events').get()?.count || 0;
  } catch (e) {
    console.error('[exitTracking] Error in getExitEventCount:', e.message);
    return 0;
  }
}
