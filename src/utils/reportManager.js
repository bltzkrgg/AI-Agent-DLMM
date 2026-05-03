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
      details: {},
      // Metrics LP: diisi dari pool data saat evaluasi
      tvl: 0,
      vol: 0,
      mcap: 0,
    };
    this.currentCycle.push(tokenReport);
    return tokenReport;
  }

  /** Set TVL/Vol/MCap metrics untuk ditampilkan di laporan */
  setMetrics(tokenName, { tvl = 0, vol = 0, mcap = 0 } = {}) {
    const token = this.currentCycle.find(t => t.name === tokenName);
    if (!token) return;
    token.tvl  = Number(tvl)  || token.tvl;
    token.vol  = Number(vol)  || token.vol;
    token.mcap = Number(mcap) || token.mcap;
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

    const nowStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'full', timeStyle: 'long' });

    let report = `📊 <b>VISUAL PROGRESS REPORT</b>\n`;
    report += `📅 ${nowStr}\n`;
    report += `================================\n`;
    report += `🔍 <b>Total Discan:</b> ${totalScanned} token\n`;
    report += `✅ <b>Lolos Deploy:</b> ${deployedTokens.length} token\n`;
    report += `🚫 <b>Gagal/Reject:</b> ${rejectedTokens.length} token\n`;
    report += `================================\n\n`;

    // Hanya kirim Top 5 ke Telegram — deployed dulu, lalu sort by gate progress
    const sortedCycle = [...this.currentCycle].sort((a, b) => {
      const aDeployed = a.finalVerdict === 'DEPLOYED' ? 1 : 0;
      const bDeployed = b.finalVerdict === 'DEPLOYED' ? 1 : 0;
      if (aDeployed !== bDeployed) return bDeployed - aDeployed;
      const aPass = Object.values(a.gates).filter(s => s === 'PASS').length;
      const bPass = Object.values(b.gates).filter(s => s === 'PASS').length;
      return bPass - aPass;
    });
    const top5Cycle = sortedCycle.slice(0, 5);
    if (totalScanned > 5) {
      report += `<i>(Menampilkan 5 dari ${totalScanned} token — sisanya hanya di console log)</i>\n\n`;
    }

    const GATES = [
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

    top5Cycle.forEach((token, idx) => {
      const isDeployed = token.finalVerdict === 'DEPLOYED';
      const statusIcon = isDeployed ? '✅' : '❌';
      const statusText = isDeployed ? 'DEPLOYED' : 'REJECTED';
      
      let passedGatesCount = 0;
      let gateTraceStr = '';

      GATES.forEach(g => {
        const s = token.gates[g];
        if (s === 'PASS') {
          passedGatesCount++;
          gateTraceStr += '✅';
        } else if (s === 'FAIL' || s === 'REJECT') {
          gateTraceStr += '❌';
        } else if (s === 'DEFER') {
          gateTraceStr += '⏳';
        } else {
          gateTraceStr += '⚪';
        }
      });

      const percent = passedGatesCount / GATES.length;
      const filledBars = Math.round(percent * 10);
      const emptyBars = Math.max(0, 10 - filledBars);
      const progressBar = `[${'█'.repeat(filledBars)}${'░'.repeat(emptyBars)}] ${Math.round(percent * 100)}%`;

      report += `<b>${idx+1}. ${token.name}</b> — ${statusText} ${statusIcon}\n`;
      report += `Progress: <code>${progressBar}</code>\n`;
      report += `Gate Trace: <code>${gateTraceStr}</code>\n`;

      // Tampilkan metrics efisiensi jika tersedia
      const tvlRaw = Number(token.tvl || 0);
      const volRaw = Number(token.vol || 0);
      const mcap   = Number(token.mcap || 0);
      if (tvlRaw > 0 || volRaw > 0) {
        const effVal = tvlRaw > 0 ? volRaw / tvlRaw : 0;
        const eff    = effVal > 1000 ? '>1000' : effVal.toFixed(2);
        report += `Eff: <code>${eff}x</code>`;
        if (mcap > 0) report += ` | MCap: <code>$${Math.round(mcap).toLocaleString('en-US')}</code>`;
        report += '\n';
      }

      if (!isDeployed) {
        const failedGate = this.getFirstFailedGate(token) || 'UNKNOWN';
        report += `Tahap gagal: <code>${failedGate}</code>\n`;
        report += `Alasan: <i>${token.reason || 'Tidak ada alasan spesifik'}</i>\n`;
      }
      
      if (token.details.PENDING_RETEST) {
        report += `⏳ Supertrend Info: ${token.details.PENDING_RETEST}\n`;
      }
      report += `\n`;
    });

    const cfg = getConfig();
    const nextScreenMin = cfg.intervals?.screeningIntervalMin || cfg.screeningIntervalMin || 15;
    const agentModel = cfg.llm?.agentModel || cfg.llm_settings?.agentModel || cfg.agentModel || 'UNKNOWN';
    report += `================================\n`;
    report += `🤖 Model AI: <code>${agentModel}</code>\n`;
    report += `⏱️ Next Scan: ${nextScreenMin} Menit`;

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
