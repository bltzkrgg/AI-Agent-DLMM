# 🦞 Meteora DLMM AI Agent Bot

**Autonomous AI Agent untuk Meteora DLMM liquidity management di Solana, dikontrol via Telegram.**

> Repo: [github.com/bltzkrgg/AI-Agent-DLMM](https://github.com/bltzkrgg/AI-Agent-DLMM)  
> Inspired by [Meridian](https://github.com/yunus-0x/meridian)

---

## ✨ Fitur Utama

| Fitur | Deskripsi |
|---|---|
| 🦅 **Hunter Alpha** | Auto screen & deploy ke pool terbaik tiap 30 menit |
| 🩺 **Healer Alpha** | Monitor & manage semua posisi tiap 10 menit |
| 🧠 **Market Analyst** | Analisa OHLCV, volume, sentiment, on-chain sebelum keputusan |
| 📊 **Daily Results** | Laporan harian fees + performa per strategi, auto-inject ke AI |
| 🧬 **Auto-Evolve** | Tiap 5 posisi ditutup, bot otomatis improve instincts-nya |
| 📚 **Learn** | Pelajari behavior top LPers, simpan lessons |
| 🔬 **Research** | Paste artikel → agent extract & simpan strategi otomatis |
| 🚫 **Scam Screener** | Deteksi rug/scam via RugCheck + GMGN + pattern analysis |
| 🛡️ **Safety System** | Stop-loss, max drawdown, trailing take profit, konfirmasi deploy |
| 🤖 **Multi AI Provider** | OpenRouter, Anthropic, OpenAI, atau custom API |
| 💾 **Auto Backup** | Semua data auto-save ke root folder, siap di-push ke GitHub |

---

## 📋 Yang Perlu Disiapkan Sebelum Install

1. **Node.js v20** via nvm (v21+ tidak kompatibel)
2. **Telegram Bot Token** — dari [@BotFather](https://t.me/BotFather)
3. **Telegram User ID** — dari [@userinfobot](https://t.me/userinfobot)
4. **OpenRouter API Key** — dari [openrouter.ai/keys](https://openrouter.ai/keys), top up min $5
5. **Solana Wallet** — wallet BARU khusus bot, bukan wallet utama
6. **Solana RPC URL** — public atau Helius gratis di [helius.dev](https://helius.dev)

---

## 🚀 Tutorial Install Lengkap

### Step 1 — Install nvm & Node.js v20

```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# Tutup dan buka ulang terminal, lalu:
nvm install 20
nvm use 20

# Verifikasi
node --version   # harus v20.x.x
npm --version    # harus 10.x.x
```

> ⚠️ Jangan pakai Node dari Homebrew atau system default — harus lewat nvm.

---

### Step 2 — Clone Repo & Install

```bash
git clone https://github.com/bltzkrgg/AI-Agent-DLMM.git
cd AI-Agent-DLMM
npm install
```

Proses install ±2–5 menit karena ada native addon (`better-sqlite3`).

---

### Step 3 — Buat Telegram Bot

1. Buka Telegram → cari **@BotFather**
2. Ketik `/newbot` → ikuti instruksi
3. Dapat **Bot Token** (format: `123456789:AAGxxx...`)
4. Buka **@userinfobot** → dapat **User ID** kamu (angka, bukan @username)

---

### Step 4 — Daftar & Top Up OpenRouter

1. Daftar di [openrouter.ai](https://openrouter.ai)
2. Top up minimal **$5** di [openrouter.ai/credits](https://openrouter.ai/credits)
3. Buat API Key di [openrouter.ai/keys](https://openrouter.ai/keys)
4. Salin key — format: `sk-or-v1-xxx...`

---

### Step 5 — Siapkan Wallet Solana

> ⚠️ **WAJIB gunakan wallet baru khusus bot.** Jangan pakai wallet utama.

Buat wallet baru di Phantom/Solflare, export private key (base58), isi dengan SOL secukupnya (mulai 0.5–1 SOL untuk testing).

---

### Step 6 — Konfigurasi `.env`

```bash
cp .env.example .env
```

Edit `.env`:

```env
# ── Telegram ──────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=123456789:AAGxxx...    # dari BotFather
ALLOWED_TELEGRAM_ID=123456789             # dari @userinfobot (angka!)

# ── AI Provider ───────────────────────────────────────────────────
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-xxx...        # dari openrouter.ai/keys
AI_MODEL=openai/gpt-4o-mini               # model rekomendasi

# ── Solana ────────────────────────────────────────────────────────
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
WALLET_PRIVATE_KEY=your-base58-private-key

# ── Bot ───────────────────────────────────────────────────────────
ADMIN_PASSWORD=password-kuat-kamu
DRY_RUN=true                              # SELALU true dulu!
```

---

### Step 7 — Jalankan Bot (Dry Run)

```bash
nvm use 20
npm run dry
```

Terminal akan tampil:
```
🤖 AI Provider: openrouter | Model: openai/gpt-4o-mini
🦞 Meteora DLMM Bot started! Mode: DRY RUN
```

Telegram kamu dapat pesan:
```
🚀 Bot Started!
💰 X.XXXX SOL | Mode: DRY RUN
🦅 Hunter: 30min | 🩺 Healer: 10min
```

---

### Step 8 — Verifikasi Model AI

Di Telegram ketik:

```
/testmodel
```

Harusnya muncul:
```
🤖 Model Status
Provider: openrouter
Model: openai/gpt-4o-mini
Status: ✅ OK
```

Kalau ❌ Error → cek API key, ganti model di `.env`, restart bot.

---

### Step 9 — Test Fitur Utama

```
/status    → cek balance & posisi
/hunt      → test Hunter Alpha manual
/heal      → test Healer Alpha manual
/results   → laporan hari ini
/memory    → lihat instincts bot
```

---

### Step 10 — Go Live

Setelah DRY RUN berjalan normal minimal 1 hari, ketik di Telegram:

```
/dryrun off PASSWORD_KAMU
```

Bot sekarang live — Hunter otomatis cari pool & deploy, Healer monitor posisi tiap 10 menit.

---

## 🤖 Pilihan Model AI

Ganti kapanpun di `.env`:

```env
AI_MODEL=nama-model
```

| Model | Kualitas | Estimasi/bulan | Notes |
|---|---|---|---|
| `openai/gpt-4o-mini` | ⭐⭐⭐⭐ | ~$5 | **Recommended** |
| `google/gemini-flash-1.5` | ⭐⭐⭐ | ~$3 | Paling hemat |
| `anthropic/claude-3-haiku` | ⭐⭐⭐⭐⭐ | ~$8 | Terbaik untuk reasoning |
| `openai/gpt-4o` | ⭐⭐⭐⭐⭐ | ~$30 | Paling pintar |

> ❌ **Hindari free models** (`:free`) — sering rate-limited, tidak reliable untuk bot 24/7.

Setelah ganti model → `/testmodel` untuk konfirmasi.

---

## 📱 Semua Commands Telegram

### Agent & Status
| Command | Fungsi |
|---|---|
| `/start` | Lihat semua commands |
| `/status` | Balance wallet & posisi terbuka |
| `/hunt` | Jalankan Hunter Alpha manual |
| `/heal` | Jalankan Healer Alpha manual |
| `/pools` | Tampilkan kandidat pool terbaik |
| `/testmodel` | Cek status model AI + list model tersedia |
| `/results` | Laporan hasil hari ini per strategi |

### Token & Scam Check
| Command | Fungsi |
|---|---|
| `/check <mint>` | Screen token scam/rug manual |

### Strategy & Learning
| Command | Fungsi |
|---|---|
| `/library` | Lihat Strategy Library |
| `/research` | Tambah strategi dari artikel (paste teks) |
| `/strategies` | Lihat strategi tersimpan |
| `/addstrategy <pw>` | Tambah strategi baru |
| `/learn [pool]` | Pelajari behavior top LPers |
| `/lessons` | Lihat lessons tersimpan |
| `/memory` | Lihat trading memory & instincts |
| `/evolve` | Manual trigger evolve instincts |

### Config & Safety
| Command | Fungsi |
|---|---|
| `/thresholds` | Lihat screening thresholds & performance |
| `/safety` | Status safety & drawdown harian |
| `/dryrun <on\|off> <pw>` | Toggle DRY RUN / LIVE mode |

### Free-form Chat
Langsung ketik natural language:
- *"Pool mana yang fee APR tertinggi sekarang?"*
- *"Analisa market SOL hari ini"*
- *"Tutup semua posisi yang out of range"*

---

## ⚙️ Konfigurasi Lanjutan (`user-config.json`)

Auto-dibuat di root folder saat pertama run:

```json
{
  "dryRun": true,
  "deployAmountSol": 0.5,
  "maxPositions": 3,
  "managementIntervalMin": 10,
  "screeningIntervalMin": 30,
  "takeProfitFeePct": 5,
  "stopLossPct": 5,
  "maxDailyDrawdownPct": 10,
  "requireConfirmation": true,
  "proactiveExitEnabled": true,
  "proactiveExitBearishConfidence": 0.7,
  "minTvl": 10000,
  "maxTvl": 150000
}
```

---

## 💾 Data & Backup

Bot auto-save semua data ke root folder. Untuk backup ke GitHub:

```bash
git add memory.json lessons.json strategyPerformance.json strategy-library.json
git commit -m "backup data"
git push origin main
```

| File | Isi | Kapan Update |
|---|---|---|
| `memory.json` | Trading history & instincts | Tiap posisi ditutup |
| `lessons.json` | Lessons dari top LPers | Tiap `/learn` |
| `strategyPerformance.json` | Performa per strategi | Tiap Healer cycle |
| `strategy-library.json` | Library strategi | Tiap `/research` |

Backup harian otomatis jam 02:00.

---

## 🛡️ Safety System

| Layer | Fungsi |
|---|---|
| **Stop-loss** | Auto close kalau rugi > `stopLossPct` (default 5%) |
| **Trailing Take Profit** | Aktif saat profit ≥ 3%, close kalau turun 1.5% dari peak |
| **Max drawdown harian** | Freeze semua aktivitas kalau rugi > `maxDailyDrawdownPct` (default 10%) |
| **Konfirmasi Telegram** | Minta approval sebelum buka posisi baru |

---

## 🔧 Troubleshooting

**`SyntaxError: Unexpected reserved word`**
```bash
nvm install 20 && nvm use 20
npm run dry
```

**`Cannot find module 'better-sqlite3'`**
```bash
npm rebuild better-sqlite3
```

**`ERR_UNSUPPORTED_DIR_IMPORT`**
```bash
nvm use 20
rm -rf node_modules && npm install
```

**Bot tidak bales di Telegram (`401 Unauthorized`)**
- Token expired → generate baru di @BotFather

**`ALLOWED_TELEGRAM_ID` tidak dikenali**
- Harus angka, bukan `@username` → cek via [@userinfobot](https://t.me/userinfobot)

**`⚠️ Model tidak bisa dipakai` saat startup**
```
/testmodel   → lihat model yang tersedia
```
Ganti `AI_MODEL` di `.env`, restart bot.

**RPC 429 Too Many Requests**
```env
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```
Daftar gratis di [helius.dev](https://helius.dev).

**`xcode-select` error di Mac**
```bash
xcode-select --install && npm install
```

---

## 🌐 Arsitektur

```
src/
├── index.js                    # Entry point, Telegram bot, cron
├── config.js                   # Config management
├── agent/
│   ├── provider.js             # AI provider (OpenRouter/Anthropic/OpenAI/Custom)
│   ├── claude.js               # Free-form chat agent
│   └── modelCheck.js           # Startup model validation
├── agents/
│   ├── hunterAlpha.js          # Pool screening & deployment agent
│   └── healerAlpha.js          # Position management agent
├── market/
│   ├── oracle.js               # Data: OHLCV, on-chain, sentiment
│   ├── analyst.js              # AI market analysis
│   ├── memory.js               # Trading memory & instinct evolution
│   ├── researcher.js           # Extract strategi dari artikel
│   ├── strategyLibrary.js      # Strategy Library
│   ├── strategyPerformance.js  # Daily results & strategy intelligence
│   └── scamScreener.js         # Scam/rug detection
├── safety/safetyManager.js     # Stop-loss, drawdown, confirmation
├── learn/
│   ├── lessons.js              # Learn dari top LPers
│   └── evolve.js               # Threshold evolution
├── db/database.js              # SQLite: positions, history
├── solana/
│   ├── meteora.js              # Meteora DLMM SDK
│   └── wallet.js               # Solana wallet
├── strategies/
│   ├── strategyManager.js      # Strategy CRUD
│   └── strategyHandler.js      # Telegram conversation flow
└── monitor/positionMonitor.js  # Out-of-range alerts
```

---

## 🔒 Security

1. **Wallet khusus bot** — isi secukupnya, jangan wallet utama
2. **`DRY_RUN=true` dulu** — minimal 1 hari sebelum live
3. **Jangan commit `.env`** — sudah ada di `.gitignore`
4. **Password admin yang kuat** — dipakai untuk `/dryrun`, `/addstrategy`
5. **Helius RPC untuk production** — public RPC sering rate-limited

---

## ⚠️ Disclaimer

Software ini disediakan apa adanya tanpa jaminan. Autonomous trading bot membawa risiko finansial nyata — kamu bisa kehilangan sebagian atau seluruh dana. Selalu mulai dengan DRY RUN. Jangan deploy modal yang tidak siap kamu kehilangkan. Ini bukan financial advice.

---

## License

MIT
