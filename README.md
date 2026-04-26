# AI-Agent-DLMM: Linear Sniper & Evil Panda LP

> Autonomous Liquidity Provider bot untuk Meteora DLMM — stateless, RPC-first, tanpa database lokal.

---

## Daftar Isi

- [Prasyarat](#prasyarat)
- [Instalasi](#instalasi)
- [Konfigurasi .env](#konfigurasi-env)
- [Konfigurasi Bot (user-config.json)](#konfigurasi-bot)
- [Menjalankan Bot](#menjalankan-bot)
- [Cara Kerja Bot](#cara-kerja-bot)
- [Strategi Evil Panda](#strategi-evil-panda)
- [Meridian Intelligence (VETO Gates)](#meridian-intelligence)
- [Smart Exit](#smart-exit)
- [Telegram Commands](#telegram-commands)
- [Stack Teknikal](#stack-teknikal)

---

## Prasyarat

| Dependensi | Versi | Keterangan |
|---|---|---|
| **Node.js** | **20.x LTS** | Wajib. Download: [nodejs.org](https://nodejs.org) |
| npm | 10.x | Bundled dengan Node.js 20 |
| PM2 | 5.x | Opsional, untuk VPS 24/7 |
| **Helius API Key** | — | **Wajib.** Daftar gratis: [helius.dev](https://helius.dev) |
| OpenRouter API Key | — | Wajib jika pakai LLM. Daftar: [openrouter.ai](https://openrouter.ai) |
| Telegram Bot Token | — | Buat via [@BotFather](https://t.me/BotFather) |

---

## Instalasi

### 1. Clone Repository

```bash
git clone https://github.com/bltzkrgg/AI-Agent-DLMM.git
cd AI-Agent-DLMM
```

### 2. Install Dependensi

```bash
npm install
```

### 3. Setup File .env

```bash
cp env.example .env
```

Buka `.env` dan isi minimal 4 variabel wajib ini:

```bash
HELIUS_API_KEY=isi_helius_api_key_kamu
WALLET_PRIVATE_KEY=isi_private_key_base58_wallet_bot
TELEGRAM_BOT_TOKEN=isi_token_dari_BotFather
ALLOWED_TELEGRAM_ID=isi_user_id_telegram_kamu
```

> ⚠️ **WAJIB gunakan wallet BARU yang terpisah dari wallet utama.**

### 4. Setup Konfigurasi Bot

```bash
# user-config.json sudah tersedia di repo dengan nilai default aman (dryRun: true)
# Edit sesuai kebutuhan:
nano user-config.json
```

Minimal yang perlu dikonfirmasi sebelum live:
```json
{
  "dryRun": false,
  "finance": { "deployAmountSol": 0.5 },
  "meridian": { "publicApiKey": "isi_meridian_api_key" }
}
```

### 5. Verifikasi Koneksi

```bash
node src/index.js --check
```

---

## Konfigurasi .env

```bash
# ─── Telegram ────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=isi_token_dari_BotFather
ALLOWED_TELEGRAM_ID=isi_user_id_telegram_kamu

# ─── Solana ──────────────────────────────────────────────────────
HELIUS_API_KEY=isi_helius_api_key
WALLET_PRIVATE_KEY=isi_private_key_base58

# ─── AI Provider ─────────────────────────────────────────────────
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=isi_openrouter_api_key

# ─── LLM Models (opsional — ada fallback gratis) ─────────────────
SCREENING_MODEL=nvidia/nemotron-3-super-120b-a12b:free
MANAGEMENT_MODEL=minimax/minimax-m2.5:free
AGENT_MODEL=deepseek/deepseek-v3.2

# ─── Opsional ────────────────────────────────────────────────────
OKX_API_KEY=          # Smart money signals
GMGN_API_KEY=         # Security intelligence
```

---

## Konfigurasi Bot

`user-config.json` menggunakan format nested yang bersih:

```json
{
  "dryRun": true,
  "autonomyMode": "active",

  "finance": {
    "deployAmountSol": 0.5,
    "maxPositions": 3,
    "gasReserve": 0.1,
    "dailyLossLimitUsd": 25
  },

  "filters": {
    "minVolume24h": 1000000,
    "maxPoolAgeDays": 3,
    "binStepPriority": [200, 125, 100],
    "gmgnRequireBurnedLp": true
  },

  "strategy": {
    "stopLossPct": 10,
    "trailingStopPct": 5.0,
    "maxHoldHours": 72,
    "slippageBps": 150
  },

  "meridian": {
    "publicApiKey": "isi_disini",
    "maxAthDistancePct": 15
  }
}
```

> Format flat lama tetap kompatibel — bot mendeteksi keduanya otomatis.

---

## Menjalankan Bot

### Mode Development (Lokal)

```bash
node src/index.js
```

### Mode Production dengan PM2 (VPS / 24/7)

**Install PM2:**
```bash
npm install -g pm2
```

**Start bot:**
```bash
pm2 start src/index.js --name "panda-linear" --interpreter node
```

**Perintah PM2 penting:**
```bash
pm2 status                       # Cek status
pm2 logs panda-linear            # Log real-time
pm2 logs panda-linear --lines 50 # 50 baris terakhir
pm2 restart panda-linear         # Restart
pm2 stop panda-linear            # Stop
```

**Auto-start saat server reboot:**
```bash
pm2 startup    # ikuti instruksi yang muncul
pm2 save
```

**Ecosystem file (opsional):** buat `ecosystem.config.cjs`:
```js
module.exports = {
  apps: [{
    name:         'panda-linear',
    script:       'src/index.js',
    interpreter:  'node',
    env_file:     '.env',
    max_restarts:  10,
    restart_delay: 5000,
    watch:         false,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
```
```bash
pm2 start ecosystem.config.cjs && pm2 save
```

---

## Cara Kerja Bot

Bot berjalan dalam siklus sekuensial yang deterministik:

```
┌─────────────────────────────────────────────────────────────┐
│                    LINEAR SNIPER LOOP                       │
│                                                             │
│  SCAN ──► SCREEN ──► VETO ──► DEPLOY ──► MONITOR ──► EXIT  │
│    ▲                                                   │    │
│    └───────────── next cycle ◄────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

| Fase | Modul | Aksi |
|---|---|---|
| **SCAN** | `meridianVeto.js` | Discover pool high-fee (binStep 200→125→100) |
| **SCREEN** | `coinfilter.js` | Filter GMGN: LP burned, zero tax, wash trade, bundler |
| **VETO** | `meridianVeto.js` | 4 gates: Supertrend · ATH · PVP · Dominance |
| **DEPLOY** | `evilPanda.js` | Buka posisi single-side SOL, chunked TX |
| **MONITOR** | `evilPanda.js` | Poll on-chain + Meridian TA setiap 15 detik |
| **EXIT** | `evilPanda.js` | Withdraw 100% → swap token → SOL |

---

## Strategi Evil Panda

LP satu sisi (SOL-only) dengan rentang dalam:

```
Range:      0% → -90% di bawah harga aktif
Deposit:    100% SOL (token Y), 0% token X
Distribusi: Spot (merata di semua bin)
Chunk TX:   Max 69 bins per transaksi
```

**Partial Deploy Guard:** Jika chunk TX gagal di tengah-tengah, posisi yang sudah terbuka otomatis di-rollback via `exitPosition('PARTIAL_DEPLOY_ROLLBACK')`.

**Target pool prioritas:**

| Kriteria | Nilai |
|---|---|
| Bin Step | **200 → 125 → 100** |
| Fee/TVL ratio | ≥ 0.2%/hari |
| Pool dominance | ≥ 15% total TVL token |
| Usia pool | ≤ 3 hari |

---

## Meridian Intelligence

4 lapisan VETO sebelum deploy:

| Gate | Label | Kondisi VETO |
|---|---|---|
| 1 | `SUPERTREND_15M` | Supertrend 15m bearish |
| 2 | `TA_ATH_DANGER` | Harga > 85% dari ATH |
| 3 | `PVP_GUARD` | Rival token punya pool dominan |
| 4 | `LOW_DOMINANCE` | Pool kita < 15% total TVL token |

Semua gate **fail-open** — jika API Meridian down, bot tetap jalan (tidak VETO).

---

## Smart Exit

`monitorPnL()` — priority chain setiap 15 detik:

```
P1  Hard Stop Loss      PnL ≤ -10%                    → EXIT
P2  Trailing Stop       (HWM - PnL) ≥ 5%              → EXIT
P3  Meridian TA
    Skenario A:         RSI(2) ≥ 90 AND Close ≥ BB Upper → EXIT
    Skenario B:         RSI(2) ≥ 90 AND MACD hist > 0   → EXIT
    Fail-open:          API down                         → HOLD
```

Setiap posisi yang ditutup dicatat ke `harvest.log`:
```
2026-04-26T12:05:00Z,TOKEN,ab3f1234,+14.23,0.5000,TAKE_PROFIT_A
```

---

## Telegram Commands

### Daftar Perintah

| Command | Fungsi |
|---|---|
| `/hunt` | Mulai loop sniper (scan → screen → deploy) |
| `/status` | Posisi aktif, PnL, balance, HWM |
| `/stop` | Hentikan loop (posisi tidak otomatis ditutup) |
| `/exit` | Force-close posisi aktif + swap ke SOL |
| `/balance` | Cek saldo wallet SOL |
| `/config` | Tampilkan config per section (Finance/Discovery/Strategy) |
| `/setconfig [key] [value]` | **Edit config secara live** (lihat panduan di bawah) |
| `/setconfig ?` | Tampilkan semua key yang bisa diubah |
| `/dryrun on\|off` | Toggle dry run mode |
| `/screening` | Scan manual top 5 high-fee pool sekarang |
| `/briefing` | Laporan 24 jam: funnel screening, PnL, posisi, blacklist |
| `/evolve` | Analisis harvest.log → saran perbaikan config dari AI |
| `/evolve apply` | Analisis + auto-terapkan rekomendasi AI ke config |
| `/blacklist` | Lihat daftar token yang diblokir (SL/rugpull) |
| `/blacklist rm <mint>` | Hapus token dari blacklist |

---

### Panduan `/setconfig` — Edit Config Live

Gunakan `/setconfig` untuk mengubah parameter **Finance** dan **Discovery** tanpa restart bot. Perubahan efektif di siklus loop berikutnya.

**Format:**
```
/setconfig [key] [value]
/setconfig [section].[key] [value]   ← dot notation
```

#### Section Finance

| Key | Tipe | Keterangan |
|---|---|---|
| `deployAmountSol` | number | Modal SOL per posisi (0.01–50) |
| `maxPositions` | number | Maks posisi bersamaan (1–20) |
| `minSolToOpen` | number | Saldo minimum sebelum buka posisi |
| `gasReserve` | number | Cadangan SOL untuk gas fee |
| `dailyLossLimitUsd` | number | Batas rugi harian dalam USD |
| `slippageBps` | number | Slippage tolerance (bps, 10–1000) |

#### Section Discovery

| Key | Tipe | Keterangan |
|---|---|---|
| `meteoraDiscoveryLimit` | number | Jumlah pool discan per siklus |
| `discoveryTimeframe` | string | Timeframe chart: `1m` / `5m` / `15m` / `1h` |
| `discoveryCategory` | string | Kategori pool: `trending`, `new`, dll |
| `minTvl` | number | TVL minimum pool (USD) |
| `maxTvl` | number | TVL maksimum pool (USD) |
| `minVolume24h` | number | Volume 24h minimum (USD) |
| `minHolders` | number | Holder minimum token |
| `minOrganic` | number | Organic score minimum (0–100) |
| `maxPoolAgeDays` | number | Usia pool maksimum (hari) |

#### Contoh Penggunaan

```
/setconfig deployAmountSol 1.5         → Modal per posisi menjadi 1.5 SOL
/setconfig finance.deployAmountSol 0.5 → Sama, pakai dot notation
/setconfig minTvl 50000                → TVL minimum $50,000
/setconfig discovery.timeframe 1h      → Ganti timeframe ke 1h
/setconfig discoveryCategory trending  → Filter hanya pool trending
/setconfig minOrganic 70               → Naikkan threshold organic
/setconfig slippageBps 200             → Naikkan slippage ke 2%
```

> ⚠️ Kunci di luar `finance` dan `discovery` (seperti LLM model, GMGN secret, wallet) **tidak dapat diubah** via Telegram untuk keamanan sistem inti.

---

## Stack Teknikal

| Layer | Teknologi |
|---|---|
| Blockchain RPC | Solana — Helius |
| LP Protocol | Meteora DLMM SDK |
| Intelligence | Meridian API |
| Token Screening | GMGN, DexScreener, OKX |
| Swap | Jupiter Quote API V6 |
| LLM | OpenRouter (via `.env`) |
| Bot Interface | Telegram Bot API |
| Process Manager | PM2 |

---

## Keamanan

- ✅ Wallet **terpisah** khusus bot (bukan wallet utama)
- ✅ Mulai dengan `"dryRun": true` untuk testing
- ✅ Pakai `"deploymentStage": "canary"` (max 1 posisi) untuk warm-up
- ✅ Private key hanya ada di `.env`, tidak pernah di-commit
- ⚠️ LP di Solana mengandung risiko nyata — deploy hanya dana yang siap hilang

---

*Built for operators who understand DLMM liquidity provision risk.*
