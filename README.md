# 🐼 Tactical Panda: Aegis Pro (v75)
**Autonomous DLMM Yield Aggregator & Defensive Trader untuk Meteora (Solana).**

Tactical Panda bukan sekadar bot; ia adalah "Aegis Pro" — agen trading otonom dengan sistem pertahanan berlapis, manajemen profit mandiri, dan kendali penuh via Telegram tanpa perlu menyentuh SSH.

---

## 🚀 Fitur "Aegis Pro" Suite (v75)

| Fitur | Deskripsi |
|---|---|
| **Autonomous Harvest** | Panen profit fee otomatis ke SOL setiap akumulasi > 0.04 SOL tanpa tutup posisi. |
| **Simulation Shield** | *Pre-flight gateway* yang mensimulasikan transaksi RPC dan memblokir eksekusi jika terdeteksi gagal. |
| **Zero-SSH Update** | Perbarui kode bot (`git pull`), install library, & restart otomatis langsung via Telegram. |
| **Toxic IL Watchdog** | Tutup posisi instan jika kerugian *Impermanent Loss* menyentuh ambang batas kritis (-5%). |
| **TVL Velocity Guard** | Keluar otomatis jika likuiditas pool turun drastis (> 20%) dalam waktu singkat. |
| **Hourly Pulse** | Laporan "Detak Jantung" sistem (Wallet, Open Positions, Yield) setiap jam ke Telegram. |
| **Darwinian Instinct** | Belajar dari data post-mortem untuk mengoptimalkan bobot sinyal screening secara adaptif. |

---

## 🛠️ Quick Start (Sultan Edition)

### 1. Requirements
- **Node.js 20 LTS sampai < 25** — Direkomendasikan untuk kompatibilitas `better-sqlite3`.
- **Helius API Key** — Digunakan untuk RPC stabil dan Simulation Shield.
- **DeepSeek-V3 API** — Direkomendasikan via OpenRouter untuk biaya operasional rendah (~$0.20/hari).

### 2. Install & Deploy (Zero-SSH Ready)
Gunakan **PM2** agar bot bisa melakukan self-restart saat di-update via Telegram.

```bash
# Clone & Install
git clone https://github.com/bltzkrgg/AI-Agent-DLMM.git
cd AI-Agent-DLMM
nvm use 20
npm install

# Setup Config
cp env.example .env
cp user-config.example.json user-config.json

# Jalankan dengan PM2 (Wajib untuk fitur /system_update)
npm install -g pm2
pm2 start src/index.js --name "panda-bot"
pm2 save
pm2 startup
```

---

## ⚙️ Configuration (user-config.json)

Default contoh config sekarang sengaja konservatif untuk first run:
- `dryRun: true`
- `autoScreeningEnabled: false`
- `requireConfirmation: true`
- `deployAmountSol: 0.05`

Kalau mau langsung live, ubah dengan sadar setelah wallet, RPC, dan command Telegram sudah tervalidasi.

Contoh baseline aman:
```json
{
  "dryRun": true,
  "autoScreeningEnabled": false,
  "requireConfirmation": true,
  "deployAmountSol": 0.05,
  "allowedBinSteps": [100, 125],
  "minTokenFeesSol": 0,
  "gmgnMinTotalFeesSol": 30,
  "executionRejectNonRefundableFees": true,
  "autoHarvestEnabled": true,      // Auto-tarik profit fee ke SOL
  "autoHarvestThresholdSol": 0.04, // Threshold panen otomatis (SOL)
  "enableSimulationShield": true,  // Aktifkan blokir transaksi gagal
  "hourlyPulseEnabled": true       // Aktifkan laporan performa tiap jam
}
```

### Token-Centric Flow (Updated)
Arsitektur screening terbaru berfokus ke token (bukan pool-first):

1. **Dex Pre-Filter (wajib lolos dulu)**  
   - `minMcap`  
   - `minVolume24h`  
   - narrative/logo basic validation
2. **GMGN Security Gate (utama)**  
   - holder/dev/insider/bundler/phishing/rug/tax/wash/cto/vamped
   - fees token via `gmgnMinTotalFeesSol`
3. **Meteora Execution Readiness (eksekusi)**  
   - pool available & compatible  
   - slippage/impact safety  
   - hard reject non-refundable fees (`executionRejectNonRefundableFees=true`)

Jika token gagal di Gate Dex, GMGN tidak dipanggil (`SKIPPED_DEX_GATE`) untuk hemat latency & API cost.

### GMGN Thresholds (Configurable)
Semua threshold utama GMGN bisa di-tune dari `user-config.json`:

- `gmgnMinTotalFeesSol`
- `gmgnTop10HolderMaxPct`
- `gmgnDevHoldMaxPct`
- `gmgnInsiderMaxPct`
- `gmgnBundlerMaxPct`
- `gmgnPhishingMaxPct`
- `gmgnRugRatioMax`
- `gmgnWashTradeMaxPct`
- `gmgnRequireBurnedLp`
- `gmgnRequireZeroTax`
- `gmgnBlockCto`
- `gmgnBlockVamped`
- `gmgnFailClosedCritical`

Catatan: `minTokenFeesSol` sekarang mode legacy (default `0`) agar gate fee utama tetap token-centric via GMGN.

---

## 🐼 Command Kendali Sultan

- `/system_update` — **Update & Restart** bot otonom (Git Pull + NPM Install + Restart).
- `/pos` — Cek status posisi terbuka, PnL, Fees, dan Range secara *lightweight*.
- `/status` — Laporan on-chain mendalam untuk semua posisi aktif.
- `/zap <addr>` — **Emergency Exit** & Swap semua token ke SOL via Jupiter.
- `/claim <position_address>` — Claim fee manual untuk posisi tertentu.
- `/hunt` — Trigger Hunter Alpha manual untuk mencari koin sniper terbaik.
- `/heal` — Trigger Healer manual untuk manajemen posisi dan trailing TP.
- `/override_range <pct> [strategy]` — Override range entry untuk strategi tertentu.
- `/pause` / `/resume` — Pause/lanjutkan loop otonom (watchdog/healer/hunter auto).
- `/preflight` — Cek readiness gate sebelum entry live.
- `/stage shadow|canary|full` — Progressive deployment stage.
- `/rollback` — Fast safe-mode rollback.

---

## 🚦 Production Hardening Flow
- Mulai dari canary: `/stage canary 1`
- Validasi status: `/preflight` + `/health`
- Baru lanjut ke full stage jika readiness `READY`.
- Saat insiden: `/rollback` untuk freeze otomatis.

Runbook detail: [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md)

---

## 🛡️ Trust & Safety
- **Zero Gas Waste**: Simulation Shield membentengi bot dari pengeluaran gas sia-sia untuk TX gagal.
- **Zero Dust Protocol**: Otomatis tutup akun token kosong untuk mengembalikan SOL rent.
- **Non-Custodial**: Bot berjalan di infrastruktur lo sendiri (VPS/Laptop).
- **Safer First Boot**: Contoh config default jalan di `dryRun`, auto-screen OFF, dan butuh konfirmasi sebelum deploy.

---

## 📝 Disclaimer
Trading DLMM (Liquidity Provisioning) memiliki risiko **Impermanent Loss** yang tinggi. Bot v75 ini dirancang untuk meminimalisir risiko, bukan menghilangkannya. Gunakan dana dingin.

**MIT License | Inspired by Meridian | Aegis Pro Edition v75**
