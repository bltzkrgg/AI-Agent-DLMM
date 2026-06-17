import { getConfig } from '../config.js';

class ReportManager {
  constructor() {
    this.currentCycle = [];
    this.cycleId = 0;
    this.slotSaturatedSummaryOnly = false;
  }

  newCycle() {
    this.currentCycle = [];
    this.cycleId++;
    this.slotSaturatedSummaryOnly = false;
    console.log(`📋 [ReportManager] Memulai siklus baru #${this.cycleId}`);
  }

  setSlotSaturatedSummaryOnly(enabled = false) {
    this.slotSaturatedSummaryOnly = Boolean(enabled);
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
      feeTvlRatio: null,
      binStep: null,
      fees24h: null,
      holders: null,
      gmgn: null,
    };
    this.currentCycle.push(tokenReport);
    return tokenReport;
  }

  /** Set TVL/Vol/MCap metrics untuk ditampilkan di laporan */
  setMetrics(tokenName, {
    tvl = 0,
    vol = 0,
    mcap = 0,
    feeTvlRatio = null,
    binStep = null,
    fees24h = null,
    holders = null,
    gmgn = null,
  } = {}) {
    const token = this.currentCycle.find(t => t.name === tokenName);
    if (!token) return;
    token.tvl  = Number(tvl)  || token.tvl;
    token.vol  = Number(vol)  || token.vol;
    token.mcap = Number(mcap) || token.mcap;
    if (feeTvlRatio != null && Number.isFinite(Number(feeTvlRatio))) {
      token.feeTvlRatio = Number(feeTvlRatio);
    }
    if (binStep != null && binStep !== '') {
      token.binStep = binStep;
    }
    if (fees24h != null && Number.isFinite(Number(fees24h))) {
      token.fees24h = Number(fees24h);
    }
    if (holders != null && Number.isFinite(Number(holders))) {
      token.holders = Number(holders);
    }
    if (gmgn && typeof gmgn === 'object') {
      token.gmgn = { ...(token.gmgn || {}), ...gmgn };
    }
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
    if (verdict === 'DEPLOYED') {
      token.status = 'DEPLOYED';
    } else if (verdict === 'DEFERRED') {
      token.status = 'DEFERRED'; // ⏳ pantauan real-time — bukan reject
    } else {
      token.status = 'REJECTED';
    }
    if (reason) token.reason = reason;
  }

  _formatUsdShort(value = 0) {
    const num = Number(value) || 0;
    if (num >= 1e6) return `$${(num / 1e6).toFixed(1)}M`;
    if (num >= 1e3) return `$${(num / 1e3).toFixed(1)}K`;
    return `$${num.toFixed(0)}`;
  }

  _formatPct(value = null, digits = 1) {
    if (value == null || value === '') return 'N/A';
    const num = Number(value);
    if (!Number.isFinite(num)) return 'N/A';
    return `${num.toFixed(digits)}%`;
  }

  _formatRatioPct(value = null, digits = 1) {
    if (value == null || value === '') return 'N/A';
    const num = Number(value);
    if (!Number.isFinite(num)) return 'N/A';
    const pct = Math.abs(num) <= 1 ? num * 100 : num;
    return `${pct.toFixed(digits)}%`;
  }

  _buildTopPoolBlock(pool = {}, idx = 0) {
    const name = pool.name || pool.symbol || pool.tokenName || 'UNKNOWN';
    const mcap = pool.mcap ?? pool.marketCap ?? 0;
    const tvl = pool.tvl ?? pool.liquidityUsd ?? pool.activeTvl ?? 0;
    const vol24h = pool.vol24h ?? pool.volume24h ?? pool.trade_volume_24h ?? pool.vol ?? 0;
    const fees24h = pool.fees24h ?? pool.fee24h ?? 0;
    const feeTvl = pool.feeTvlRatio ?? pool.feeTVLRatio ?? pool.fee_tvl_ratio ?? pool.feeRatio ?? null;
    const binStep = pool.binStep ?? pool.bin_step ?? 'N/A';
    const holders = pool.holders ?? pool.holderCount ?? 'N/A';
    const gmgn = pool.gmgn || {};
    const gmgnParts = [];
    const vLines = [];
    const fees24hText = Number.isFinite(Number(fees24h)) && Number(fees24h) > 0
      ? `◎${Number(fees24h).toFixed(2)}`
      : 'N/A';

    if (feeTvl == null) {
      console.log(`[ReportManager] pool ${name} missing Meteora Fee/TVL ratio; rendering N/A`);
    }

    vLines.push(`<b>${idx + 1}. ${name}</b>`);
    vLines.push('');
    vLines.push(`<b>Meteora</b>`);
    vLines.push(`  TVL ${this._formatUsdShort(tvl)} | Vol24h ${this._formatUsdShort(vol24h)} | Fees24h ${fees24hText}`);
    vLines.push(`  Fee/TVL 24h ${this._formatRatioPct(feeTvl, 1)} | Bin ${binStep} | MCap ${this._formatUsdShort(mcap)}`);
    vLines.push('');
    vLines.push(`<b>GMGN</b>`);
    vLines.push(`  Holders ${holders}`);
    if (gmgn.top10Pct != null) gmgnParts.push(`Top10 ${this._formatPct(gmgn.top10Pct, 1)}`);
    if (gmgn.devHoldPct != null) gmgnParts.push(`Dev ${this._formatPct(gmgn.devHoldPct, 1)}`);
    if (gmgn.insiderPct != null) gmgnParts.push(`Insider ${this._formatPct(gmgn.insiderPct, 1)}`);
    if (gmgn.bundlerPct != null) gmgnParts.push(`Bundler ${this._formatPct(gmgn.bundlerPct, 1)}`);
    vLines.push(`  Signal ${gmgnParts.length > 0 ? gmgnParts.join(' | ') : 'N/A'}`);
    if (pool.signalScore != null && Number.isFinite(Number(pool.signalScore))) {
      vLines.push(`  LP Score ${Math.max(0, Math.min(100, Math.round(Number(pool.signalScore))))}/100`);
    }
    vLines.push('');
    vLines.push(`  Status: ${pool.rejected ? 'REJECTED' : (pool.status || 'WATCH')}`);
    return vLines.join('\n');
  }

  getFirstFailedGate(token) {
    const entries = Object.entries(token.gates);
    for (const [gate, status] of entries) {
      if (status === 'FAIL') return gate;
    }
    return null;
  }

  getGateDetailsText(token, gateName) {
    if (!token || !gateName) return '';
    const raw = token.details?.[gateName];
    if (!raw) return '';
    return String(raw).trim();
  }

  generateReport() {
    if (this.currentCycle.length === 0) {
      return '🚫 Tidak ada deploy pada siklus ini.';
    }

    const deferredTokens  = this.currentCycle.filter(t => t.status === 'DEFERRED' || Object.values(t.gates).some(s => s === 'DEFER'));
    const rejectedTokens  = this.currentCycle.filter(t => t.finalVerdict !== 'DEPLOYED' && t.status !== 'DEFERRED' && !Object.values(t.gates).some(s => s === 'DEFER'));

    const nowStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'full', timeStyle: 'long' });

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
    const cfg = getConfig();
    const nextScreenMin = cfg.intervals?.screeningIntervalMin || cfg.screeningIntervalMin || 15;
    const slotText = this.slotSaturatedSummaryOnly ? 'FULL 1/1' : `${deferredTokens.length > 0 ? 'WATCH' : 'AVAILABLE'}`;
    let report = `╔══════════════════════════════╗\n`;
    report += `║   AI-Agent Scanner Result    ║\n`;
    report += `╚══════════════════════════════╝\n`;
    report += `📅 ${nowStr}\n\n`;
    report += `[ TOP 5 POOLS ]\n`;
    report += `${top5Cycle.map((pool, idx) => this._buildTopPoolBlock(pool, idx)).join('\n\n')}\n\n`;
    report += `[ REJECTED ]\n`;
    report += `${rejectedTokens.slice(0, 5).map((t) => {
      const reason = this.getGateDetailsText(t, this.getFirstFailedGate(t)) || t.reason || this.getFirstFailedGate(t) || 'Rejected';
      return `- ${t.name} : ${reason}`;
    }).join('\n') || '- N/A'}\n\n`;

    report += `Slot  : ${slotText}\n`;
    report += `Action: HOLD new entries\n`;
    report += `Next  : ${nextScreenMin}m`;

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
