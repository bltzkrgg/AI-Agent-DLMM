import { getConfig } from '../config.js';

class ReportManager {
  constructor() {
    this.currentCycle = [];
    this.cycleId = 0;
  }

  newCycle() {
    this.currentCycle = [];
    this.cycleId++;
    console.log(`📋 [ReportManager] Memulai siklus baru #${this.cycleId}`);
  }

  addToken(tokenName, tokenAddress = '') {
    const existing = this.currentCycle.find(t => t.name === tokenName);
    if (existing) return existing;

    const tokenReport = {
      name: tokenName,
      address: tokenAddress,
      status: 'PENDING',
      gates: {
        STAGE_0_DISCOVERY: 'NOT_STARTED',
        BLACKLIST_LOCAL: 'NOT_STARTED',
        STAGE_1_PUBLIC: 'NOT_STARTED',
        STAGE_2_GMGN: 'NOT_STARTED',
        STAGE_3_JUPITER: 'NOT_STARTED',
        MERIDIAN_VETO: 'NOT_STARTED',
        FLAT_CONFIG_GATE: 'NOT_STARTED',
        PENDING_RETEST: 'NOT_STARTED',
        SCOUT_AGENT: 'NOT_STARTED'
      },
      reason: '',
      finalVerdict: null,
      details: {}
    };
    this.currentCycle.push(tokenReport);
    return tokenReport;
  }

  updateGate(tokenName, gateName, result, details = '') {
    const token = this.currentCycle.find(t => t.name === tokenName);
    if (!token) {
      console.warn(`[ReportManager] Token ${tokenName} tidak ditemukan saat update gate ${gateName}`);
      return;
    }
    token.gates[gateName] = result;
    if (details) token.details[gateName] = details;
    if (result === 'FAIL' && !token.reason) {
      token.reason = details || `Gagal di gate ${gateName}`;
    }
  }

  setFinalVerdict(tokenName, verdict, reason = '') {
    const token = this.currentCycle.find(t => t.name === tokenName);
    if (!token) return;
    token.finalVerdict = verdict;
    token.status = verdict === 'DEPLOYED' ? 'DEPLOYED' : 'REJECTED';
    if (reason) token.reason = reason;
  }

  getFirstFailedGate(token) {
    const entries = Object.entries(token.gates);
    for (const [gate, status] of entries) {
      if (status === 'FAIL') return gate;
    }
    return null;
  }

  generateReport() {
    if (this.currentCycle.length === 0) {
      return '🚫 Tidak ada deploy pada siklus ini.';
    }

    const totalScanned = this.currentCycle.length;
    const deployedTokens = this.currentCycle.filter(t => t.finalVerdict === 'DEPLOYED');
    const rejectedTokens = this.currentCycle.filter(t => t.finalVerdict !== 'DEPLOYED');

    let report = `📊 <b>CYCLE REPORT #${this.cycleId}</b>\n`;
    report += `================================\n`;
    report += `🔍 <b>Total Discan:</b> ${totalScanned} token\n`;
    report += `✅ <b>Lolos Deploy:</b> ${deployedTokens.length} token\n`;
    report += `🚫 <b>Gagal/Reject:</b> ${rejectedTokens.length} token\n`;
    report += `================================\n\n`;

    this.currentCycle.forEach((token, idx) => {
      const status = token.finalVerdict || 'REJECT';
      report += `${idx+1}) ${token.name} — ${status}\n`;

      if (status !== 'DEPLOYED') {
        const failedGate = this.getFirstFailedGate(token);
        report += `Tahap gagal: ${failedGate || 'UNKNOWN'}\n`;
        report += `Alasan: ${token.reason || 'Tidak ada alasan spesifik'}\n`;
      }

      report += `Gate:\n`;
      Object.entries(token.gates).forEach(([g, s]) => {
        let displayState = s;
        if (g === 'SCOUT_AGENT' && s === 'DEFER') {
          const meta = token.details['SCOUT_AGENT'] || '';
          displayState = `DEFER ${meta ? `(${meta})` : ''}`;
        }
        report += `${g}: ${displayState}\n`;
      });
      
      if (token.details.PENDING_RETEST) {
        report += `Supertrend Info: ${token.details.PENDING_RETEST}\n`;
      }
      report += `\n`;
    });

    const cfg = getConfig();
    const nextScreenMin = cfg.intervals?.screeningIntervalMin || cfg.screeningIntervalMin || 15;
    const agentModel = cfg.llm?.agentModel || cfg.agentModel || 'UNKNOWN';
    report += `Next screen in: ${nextScreenMin}m | Model used: ${agentModel}`;

    return report;
  }

  async sendTelegram() {
    const text = this.generateReport();
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    if (!token || !chatId) {
      console.error('TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID tidak ditemukan di environment variables.');
      return;
    }

    try {
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
    } catch (err) {
      console.error(`Gagal mengirim laporan Telegram: ${err.message}`);
    }
  }

  appendToHarvestLog(tokenName, reason, pnl = null) {
    // Di repo ini file harvest.log bisa di append langsung atau pakai util logger
    // Kita gunakan simple console.log karena ini akan ditangkap ke file oleh process manager
    console.log(`[Harvest Log] ${new Date().toISOString()} | ${tokenName} | ${reason} | PnL: ${pnl || 'N/A'}`);
  }
}

export default new ReportManager();
