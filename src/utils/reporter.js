'use strict';

/**
 * Format cycle report for Telegram
 * @param {Array} cycleReport 
 * @returns {string}
 */
export async function sendTelegramCycleReport(cycleReport) {
  let text = '';
  if (!Array.isArray(cycleReport) || cycleReport.length === 0) {
    text = '🚫 Tidak ada deploy pada siklus ini';
  } else {
    text = cycleReport.map((row, idx) => {
      const status = (row.status || 'REJECT').toUpperCase();
      const stageFailed = row.stageFailed || 'NONE';
      const reason = row.reason || 'Tidak ada alasan tercatat';
      
      let report = `${idx + 1}) ${row.name} — ${status}\n`;
      report += `Tahap gagal: ${stageFailed}\n`;
      report += `Alasan:\n${reason}\n`;
      report += `Gate:\n`;
      
      const gates = [
        'STAGE_0_DISCOVERY',
        'BLACKLIST_LOCAL',
        'STAGE_1_PUBLIC',
        'STAGE_2_GMGN',
        'STAGE_3_JUPITER',
        'MERIDIAN_VETO',
        'PENDING_RETEST',
        'FLAT_CONFIG_GATE',
        'SCOUT_AGENT'
      ];

      gates.forEach(gate => {
        let state = row.gates[gate] || 'SKIPPED';
        if (gate === 'SCOUT_AGENT' && state === 'DEFER') {
          const metadata = row.metadata || {};
          state = `DEFER (Entry=${metadata.entry || 'N/A'}, Breakout=${metadata.breakout || 'N/A'})`;
        }
        report += `${gate}: ${state}\n`;
      });

      return report;
    }).join('\n\n');
  }

  const { getConfig } = await import('../config.js');
  const cfg = getConfig();
  const nextScreenMin = cfg.intervals?.screeningIntervalMin || cfg.screeningIntervalMin || 15;
  const agentModel = cfg.llm?.agentModel || cfg.agentModel || 'UNKNOWN';
  
  text += `\n\nNext screen in: ${nextScreenMin}m | Model used: ${agentModel}`;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!token || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID tidak ditemukan di environment variables.');
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
}

