# Meteora DLMM AI Agent Bot

**Autonomous AI Agent untuk Meteora DLMM liquidity management di Solana, dikontrol via Telegram.**

> Inspired by [Meridian](https://github.com/yunus-0x/meridian)

---

## Fitur Utama

| Fitur | Deskripsi |
|---|---|
| **Hunter Alpha** | Auto screen & deploy ke pool terbaik tiap 30 menit |
| **Healer Alpha** | Monitor & manage semua posisi tiap 10 menit |
| **Market Analyst** | Analisa OHLCV, volume, sentiment, on-chain sebelum keputusan |
| **Evil Panda Strategy** | Entry saat Supertrend 15m fresh cross, exit confluence RSI(2)+BB/MACD |
| **TA Indicators** | RSI(14), RSI(2), Supertrend, Bollinger Bands, MACD — real candles dari GeckoTerminal |
| **Strategy Library** | 6 built-in strategies, auto-scored per kondisi market |
| **Darwinian Scoring** | Bot auto-evolve bobot signal dari closed positions — weak signals diabaikan |
| **Daily Results** | Laporan harian fees + performa per strategi, auto-inject ke AI |
| **Auto-Evolve** | Tiap 5 posisi ditutup, bot otomatis improve instincts-nya |
| **Learn** | Pelajari behavior top LPers, simpan lessons |
| **Research** | Paste artikel → agent extract & simpan strategi otomatis |
| **Scam Screener** | Deteksi rug/scam via RugCheck + OKX + on-chain analysis |
| **Safety System** | Stop-loss, max drawdown, trailing take profit |
| **Multi AI Provider** | OpenRouter, Anthropic, OpenAI, atau custom API |

---

## Yang Perlu Disiapkan Sebelum Install

**Wajib:**
1. **Node.js v20** via nvm (v21+ tidak kompatibel)
2. **Telegram Bot Token** — dari [@BotFather](https://t.me/BotFather)
3. **Telegram User ID** — dari [@userinfobot](https://t.me/userinfobot)
4. **OpenRouter API Key** — dari [openrouter.ai/keys](https://openrouter.ai/keys), top up min $5
5. **Solana Wallet** — wallet BARU khusus bot, bukan wallet utama
6. **Solana RPC URL** — public atau Helius gratis di [helius.dev](https://helius.dev)

**Opsional (meningkatkan kualitas signal):**
- **Helius API Key** — holder count akurat, on-chain data lebih lengkap
- **OKX API Key** — Smart Money signal, token risk check

---

## Tutorial Install Lengkap

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

> Jangan pakai Node dari Homebrew atau system default — harus lewat nvm.

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

> **WAJIB gunakan wallet baru khusus bot.** Jangan pakai wallet utama.

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

# ── Opsional — meningkatkan kualitas signal ───────────────────────
HELIUS_API_KEY=your-helius-key            # holder count akurat + on-chain data
OKX_API_KEY=your-okx-key                 # Smart Money signal + token risk
OKX_SECRET_KEY=your-okx-secret
OKX_PASSPHRASE=your-okx-passphrase
```

---

### Step 7 — Jalankan Bot

```bash
nvm use 20
npm start
```

Terminal akan tampil:
```
AI Provider: openrouter | Model: openai/gpt-4o-mini
Meteora DLMM Bot started! Mode: LIVE
```

Telegram kamu dapat pesan:
```
Bot Started!
X.XXXX SOL
Hunter: 30min | Healer: 10min
```

---

### Step 8 — Verifikasi Model AI

Di Telegram ketik:

```
/testmodel
```

Harusnya muncul:
```
Model Status
Provider: openrouter
Model: openai/gpt-4o-mini
Status: OK
```

Kalau Error → cek API key, ganti model di `.env`, restart bot.

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

## Pilihan Model AI

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

> **Hindari free models** (`:free`) — sering rate-limited, tidak reliable untuk bot 24/7.

Setelah ganti model → `/testmodel` untuk konfirmasi.

---

## Semua Commands Telegram

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
| `/check <mint>` | Screen token manual — RugCheck + OKX + on-chain |

### Strategy & Learning
| Command | Fungsi |
|---|---|
| `/library` | Lihat Strategy Library & skor per kondisi market |
| `/research` | Tambah strategi dari artikel (paste teks) |
| `/strategies` | Lihat strategi tersimpan |
| `/addstrategy <pw>` | Tambah strategi baru |
| `/learn [pool]` | Pelajari behavior top LPers |
| `/lessons` | Lihat lessons tersimpan |
| `/memory` | Lihat trading memory & instincts |
| `/evolve` | Manual trigger evolve instincts + recalibrate Darwinian weights |

### Config & Safety
| Command | Fungsi |
|---|---|
| `/thresholds` | Lihat screening thresholds & performance |
| `/safety` | Status safety & drawdown harian |

### Free-form Chat
Langsung ketik natural language:
- *"Pool mana yang fee APR tertinggi sekarang?"*
- *"Analisa market SOL hari ini"*
- *"Tutup semua posisi yang out of range"*

---

## Konfigurasi Lanjutan (`user-config.json`)

Auto-dibuat di root folder saat pertama run. Edit langsung atau via Telegram chat:

```json
{
  "deployAmountSol": 0.1,
  "maxPositions": 10,
  "managementIntervalMin": 10,
  "screeningIntervalMin": 30,
  "takeProfitFeePct": 5,
  "stopLossPct": 5,
  "maxDailyDrawdownPct": 10,
  "proactiveExitEnabled": true,
  "proactiveExitBearishConfidence": 0.7,
  "minTvl": 10000,
  "maxTvl": 150000,
  "minMcap": 250000,
  "minVolume24h": 1000000
}
```

---

## Strategi

### 6 Built-in Strategies

| Strategi | Kondisi Ideal |
|---|---|
| **Single-Side SOL** | Default — market apapun |
| **Spot Balanced** | Sideways + volatilitas rendah |
| **Bid-Ask Wide** | Volatilitas tinggi + volume di atas rata-rata |
| **Single-Side Token X** | Uptrend kuat + SM buying + buy pressure >65% |
| **Curve Concentrated** | Pool stabil + volatilitas sangat rendah |
| **Evil Panda** | Uptrend + Supertrend 15m fresh cross — lihat di bawah |

### Evil Panda

Strategi single-side SOL berbasis TA signal, cocok untuk high-volume coins.

**Entry — semua syarat harus terpenuhi:**
- Pool bin step 80, 100, atau 125
- MC/FDV >$250k, Volume 24h >$1M
- Supertrend 15m `justCrossedAbove = true` (fresh cross — bukan sekadar bullish)
- Trend UPTREND berdasarkan price action
- Token PASS screening RugCheck (phishing <30%, bundling <60%, insiders <10%)

**Exit — confluence ≥2 sinyal:**
- RSI(2) > 90 + price tutup di atas Bollinger Band upper
- RSI(2) > 90 + MACD histogram pertama kali hijau setelah merah

Jika hanya 1 sinyal → HOLD. Dump/koreksi sementara = normal, biarkan fee terakumulasi.

### Darwinian Scoring

Bot auto-recalibrate signal weights dari closed positions via `/evolve`:

| Signal | Weight saat ini | Arti |
|---|---|---|
| Market Cap proxy (TVL) | 2.5x | Prediktor kuat |
| Fee/TVL ratio | 2.3x | Prediktor kuat |
| Volume 24h | 0.36x | Signal lemah |
| Holder count | 0.3x | Signal lemah |

---

## Safety System

| Layer | Fungsi |
|---|---|
| **Stop-loss** | Auto close kalau rugi > `stopLossPct` (default 5%) |
| **Trailing Take Profit** | Aktif saat profit ≥ 3%, close kalau turun 1.5% dari peak |
| **Max drawdown harian** | Freeze semua aktivitas kalau rugi > `maxDailyDrawdownPct` (default 10%) |
| **Proactive exit** | Close posisi profit kalau market BEARISH confidence >70% |

---

## Data Sources

| Data | Source | API Key |
|---|---|---|
| OHLCV candles (15m) | GeckoTerminal | Tidak perlu |
| Pool metrics (TVL, fee APR) | Meteora API | Tidak perlu |
| Price & sentiment | DexScreener | Tidak perlu |
| Holder count | Solscan public API | Tidak perlu |
| Token security | RugCheck.xyz | Tidak perlu |
| Top-10 holder % | Helius | Opsional |
| Smart Money signal | OKX | Opsional |

---

## Data & Backup

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

---

## Arsitektur

```
src/
├── index.js                    # Entry point, Telegram bot, cron
├── config.js                   # Config management + bounds validation
├── agent/
│   ├── provider.js             # AI provider (OpenRouter/Anthropic/OpenAI/Custom)
│   ├── claude.js               # Free-form chat agent
│   └── modelCheck.js           # Startup model validation
├── agents/
│   ├── hunterAlpha.js          # Pool screening & deployment agent
│   └── healerAlpha.js          # Position management agent
├── market/
│   ├── oracle.js               # Data: OHLCV (GeckoTerminal), on-chain, sentiment
│   ├── analyst.js              # AI market analysis (DLMM LP perspective)
│   ├── coinfilter.js           # Token screening — RugCheck, OKX, Helius, DexScreener
│   ├── taIndicators.js         # TA: RSI, Supertrend, Bollinger Bands, MACD
│   ├── memory.js               # Trading memory & instinct evolution
│   ├── researcher.js           # Extract strategi dari artikel
│   ├── strategyLibrary.js      # Strategy Library + scoring engine
│   ├── strategyPerformance.js  # Daily results & strategy intelligence
│   └── scamScreener.js         # Scam/rug detection
├── safety/safetyManager.js     # Stop-loss, drawdown, trailing TP
├── learn/
│   ├── lessons.js              # Learn dari top LPers
│   └── evolve.js               # Threshold & Darwinian weight evolution
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

## Troubleshooting

**`SyntaxError: Unexpected reserved word`**
```bash
nvm install 20 && nvm use 20
npm start
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

**`Model tidak bisa dipakai` saat startup**
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

## Security

1. **Wallet khusus bot** — isi secukupnya, jangan wallet utama
2. **Jangan commit `.env`** — sudah ada di `.gitignore`
3. **Password admin yang kuat** — dipakai untuk `/addstrategy`
4. **Helius RPC untuk production** — public RPC sering rate-limited

---

## Disclaimer

Software ini disediakan apa adanya tanpa jaminan. Autonomous trading bot membawa risiko finansial nyata — kamu bisa kehilangan sebagian atau seluruh dana. Jangan deploy modal yang tidak siap kamu kehilangkan. Ini bukan financial advice.

---

## License

MIT
