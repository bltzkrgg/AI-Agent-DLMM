# 🐼 Adaptive Evil Panda: DLMM AI Agent

**Autonomous DLMM Liquidity Specialist untuk Meteora (Solana), dikontrol via Telegram.**

Panda ini ngga cuma sekadar bot grid. Ia adalah agen trading otonom yang bisa "mendengar" narasi (Discord), "belajar" dari kesalahan (Post-Mortem), dan "adaptif" terhadap market yang volatil.

---

## 🚀 Fitur "Evil Panda" Specialist

| Fitur | Deskripsi |
|---|---|
| **Adaptive Momentum** | Fokus pada **M5 Momentum Velocity** dengan fallback **H1 Elastic** (APR > 1000% + Trend Bullish). |
| **Social Awareness** | Integrasi **Discord Aggregator** (Meridian-style). Bot dapet skor boost jika token sedang ramai di komunitas. |
| **Post-Mortem Learning** | Setiap trade ditutup, LLM melakukan analisa kegagalan/keberhasilan dan menyimpan "Instinct" baru. |
| **Adaptive OOR** | Kelola Out-of-Range secara cerdas: **EXTEND** (tunggu recovery jika bullish) atau **PANIC EXIT** (zap-out jika bearish breakdown). |
| **Darwinian Evolution** | Autonomously recalibrate signal weights (Mcap, TVL, Fees, Social) berdasarkan performa trade nyata. |
| **Security Walls** | 10-step filter termasuk **Helius Authority Check** (Mint/Freeze) & **Jupiter Slippage Simulation**. |

---

## 🛠️ Quick Start (VPS Ready)

### 1. Requirements
- **Node.js v20** (wajib pake nvm)
- **Helius API Key** (untuk RPC + On-chain data)
- **Telegram Bot Token** (@BotFather) & User ID (@userinfobot)
- **AI API Key** (OpenRouter sangat disarankan untuk cost-efficiency)

### 2. Install
```bash
git clone https://github.com/bltzkrgg/AI-Agent-DLMM.git
cd AI-Agent-DLMM
npm install
cp .env.example .env # Isi API Keys lo di sini!
cp user-config.example.json user-config.json # Setting awal bot lo
npm start
```

### 3. Recommended VPS PM2 Run
```bash
npm install -g pm2
pm2 start src/index.js --name "evil-panda"
pm2 save
```

---

## ⚙️ Configuration (user-config.json)

Bot ini menggunakan `user-config.json` untuk menyimpan parameter trading lo secara persisten. Gunakan `user-config.example.json` sebagai referensi lengkap.

```json
{
  "deployAmountSol": 0.1,      // Jumlah SOL per posisi
  "maxPositions": 1,           // Maksimal slot posisi terbuka
  "managementIntervalMin": 5,  // Jeda Healer (manajemen posisi)
  "autoScreeningEnabled": true // Status otonom (ON/OFF)
}
```

> [!IMPORTANT]
> - **Full Template**: Gunakan template di `user-config.example.json` untuk melihat semua parameter (Mcap, TVL, WinRate, Darwinian Weights, dll).
> - **Sensitive Keys**: API Keys dan RPC Host tetap disimpan di file **`.env`** demi keamanan.
> - **Lenient Parsing**: Bot tetap toleran terhadap typo angka atau karakter non-numerik saat lo edit manual.

---

## 🐼 Specialist Commands

- `/hunt` — Jalankan Hunter Alpha manual (Social + Momentum screening).
- `/status` — Cek PnL Live, Fees, Pendaftaran Posisi, dan Balance.
- `/heal` — Trigger Healer (Management posisi, Trailing TP, OOR management).
- `/weights` — Lihat bagaimana bot lo "belajar" dan mengubah bobot sinyalnya.
- `/lessons` — Intip "Instinct" yang sudah dipelajari bot dari post-mortem analysis.
- `/autoscreen on` — Lepas Panda lo ke alam liar (Fully Autonomous Mode).

---

## 🛡️ Trust & Safety
- **Non-Custodial**: Bot jalan di infrastruktur lo sendiri (VPS/Laptop).
- **Dry Run Mode**: Bisa testing tanpa pake SOL asli (`dryRun: true` di config).
- **Circuit Breaker**: Auto-stop jika drawdown harian mencapai threshold (default 10%).

---

## 📝 Disclaimer
Trading DLMM (Liquidity Provisioning) memiliki risiko **Impermanent Loss** yang tinggi. Bot ini adalah alat bantu otonom, bukan jaminan cuan. Gunakan dana yang siap lo relakan.

**MIT License | Inspired by Meridian**
