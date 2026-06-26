'use strict';

export const EXIT_REASON_CATEGORIES = Object.freeze([
  'TAKE_PROFIT',
  'STOP_LOSS',
  'TRAILING_STOP',
  'OUT_OF_RANGE',
  'POOL_IMPACT_GUARD',
  'MANUAL_EXIT',
  'MANUAL_STOP',
  'SAFE_EXIT',
  'VETO_NON_REFUNDABLE_RENT',
  'DEPLOY_FAILED',
  'UNKNOWN',
]);

export function normalizeExitReason(reason = '', context = {}) {
  const raw = String(reason || '').trim();
  const text = raw.toUpperCase();
  const source = String(context?.source || '').toUpperCase();

  if (!text && !source) return 'UNKNOWN';
  if (text.includes('VETO_NON_REFUNDABLE_RENT') || text.includes('BIN_ARRAY_RENT_REQUIRED')) {
    return 'VETO_NON_REFUNDABLE_RENT';
  }
  if (text.includes('POOL_IMPACT_GUARD') || text.includes('POOL IMPACT')) return 'POOL_IMPACT_GUARD';
  if (text.includes('OUT_OF_RANGE') || text === 'OOR' || text.includes(' OOR')) return 'OUT_OF_RANGE';
  if (text.includes('TRAILING')) return 'TRAILING_STOP';
  if (text.includes('STOP_LOSS') || text.includes('HARD SL')) return 'STOP_LOSS';
  if (text.includes('MANUAL_STOP')) return 'MANUAL_STOP';
  if (text.includes('MANUAL_COMMAND') || text.includes('MANUAL_EXIT') || text.includes('MANUAL_WITHDRAW')) {
    return 'MANUAL_EXIT';
  }
  if (text.includes('TAKE_PROFIT') || text.includes('TAKE PROFIT')) return 'TAKE_PROFIT';
  if (
    text.includes('PARTIAL_DEPLOY_ROLLBACK') ||
    text.includes('DEPLOY_FAILED') ||
    text.includes('DEPLOY FAILED') ||
    text.includes('EXECUTION_FAILED')
  ) {
    return 'DEPLOY_FAILED';
  }
  if (
    text.includes('SAFE_EXIT') ||
    text.includes('SHUTDOWN') ||
    text.includes('LOOP_STOPPED') ||
    text.includes('MONITOR_ERROR') ||
    text.includes('STATUS_ERROR')
  ) {
    return 'SAFE_EXIT';
  }

  return 'UNKNOWN';
}

export function getExitDisplayMeta(reason = '', normalizedReason = '') {
  const raw = String(reason || '').trim();
  const text = raw.toUpperCase();
  const normalizedInput = String(normalizedReason || '').trim().toUpperCase();
  const normalized = EXIT_REASON_CATEGORIES.includes(normalizedInput)
    ? normalizedInput
    : normalizeExitReason(normalizedInput || raw);

  if (text.includes('TAKE_PROFIT') || text.includes('TAKE PROFIT') || normalized === 'TAKE_PROFIT') {
    if (text.includes('TRAILING')) {
      return {
        title: 'TAKE PROFIT',
        reasonLabel: 'Trailing Profit Trigger',
        normalizedReason: normalized || 'TAKE_PROFIT',
      };
    }

    if (text.includes('_A')) {
      return {
        title: 'TAKE PROFIT',
        reasonLabel: 'Take Profit Trigger',
        normalizedReason: normalized || 'TAKE_PROFIT',
      };
    }

    if (text.includes('_B')) {
      return {
        title: 'TAKE PROFIT',
        reasonLabel: 'Take Profit Trigger (RSI + MACD)',
        normalizedReason: normalized || 'TAKE_PROFIT',
      };
    }

    if (text.includes('_TA')) {
      return {
        title: 'TAKE PROFIT',
        reasonLabel: 'Take Profit Trigger (TA Smart Exit)',
        normalizedReason: normalized || 'TAKE_PROFIT',
      };
    }

    if (text.includes('_C') || text.includes('DEFENSIVE')) {
      return {
        title: 'TAKE PROFIT',
        reasonLabel: 'Defensive Exit Trigger',
        normalizedReason: normalized || 'TAKE_PROFIT',
      };
    }

    return {
      title: 'TAKE PROFIT',
      reasonLabel: 'Take Profit Trigger',
      normalizedReason: normalized || 'TAKE_PROFIT',
    };
  }

  if (text.includes('STOP_LOSS') || text.includes('HARD SL') || normalized === 'STOP_LOSS') {
    return {
      title: 'STOP LOSS',
      reasonLabel: 'Stop Loss Trigger',
      normalizedReason: normalized || 'STOP_LOSS',
    };
  }

  if (text.includes('MAX_HOLD') || text.includes('MAX HOLD')) {
    return {
      title: 'MAX HOLD EXIT',
      reasonLabel: 'Max Hold Trigger',
      normalizedReason: normalized || 'SAFE_EXIT',
    };
  }

  if (text.includes('POOL_IMPACT_GUARD') || text.includes('POOL IMPACT')) {
    return {
      title: 'POOL IMPACT EXIT',
      reasonLabel: 'Pool Impact Trigger',
      normalizedReason: normalized || 'POOL_IMPACT_GUARD',
    };
  }

  if (text.includes('OUT_OF_RANGE') || text === 'OOR' || text.includes(' OOR')) {
    return {
      title: 'OUT OF RANGE',
      reasonLabel: 'Out of Range Trigger',
      normalizedReason: normalized || 'OUT_OF_RANGE',
    };
  }

  if (text.includes('MANUAL_COMMAND') || text.includes('MANUAL_EXIT') || text.includes('MANUAL_WITHDRAW')) {
    return {
      title: 'MANUAL CLOSE',
      reasonLabel: 'Manual Close Trigger',
      normalizedReason: normalized || 'MANUAL_EXIT',
    };
  }

  if (
    text.includes('SAFE_EXIT') ||
    text.includes('SHUTDOWN') ||
    text.includes('LOOP_STOPPED') ||
    text.includes('MONITOR_ERROR') ||
    text.includes('STATUS_ERROR')
  ) {
    return {
      title: 'SAFE EXIT',
      reasonLabel: 'Safe Exit Trigger',
      normalizedReason: normalized || 'SAFE_EXIT',
    };
  }

  return {
    title: normalized || 'EXIT',
    reasonLabel: raw || 'Exit Trigger',
    normalizedReason: normalized || 'UNKNOWN',
  };
}

export function getTakeProfitDisplayLabel(reason = '', normalizedReason = '') {
  const meta = getExitDisplayMeta(reason, normalizedReason);
  return {
    title: 'TAKE PROFIT',
    reasonLabel: meta.reasonLabel,
    normalizedReason: meta.normalizedReason,
  };
}

export function formatTakeProfitRiskLabel(takeProfitMinNetPnlPct = 0, stopLossPct = 10) {
  void takeProfitMinNetPnlPct;
  return `TP: <code>trailing-only</code> | SL: <code>-${stopLossPct || 10}%</code>`;
}
