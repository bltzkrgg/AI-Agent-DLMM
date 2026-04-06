# Meteora DLMM AI Agent Bot

**Autonomous AI Agent untuk Meteora DLMM liquidity management di Solana, dikontrol via Telegram.**

> Inspired by [Meridian](https://github.com/yunus-0x/meridian)

---

## Fitur Utama

| Fitur | Deskripsi |
|---|---|
| **Hunter Alpha** | Screen & deploy ke pool terbaik secara otomatis — autonomous dari screen hingga deploy, tanpa persetujuan manual |
| **Healer Alpha** | Monitor & manage semua posisi tiap 10 menit — trailing TP, OOR detection, proactive exit |
| **Auto-Screening** | Hunter jalan otomatis tiap N menit — screen, score, dan deploy kandidat terbaik sendiri tanpa interaksi user |
| **Market Analyst** | Analisa OHLCV, volume, sentiment, on-chain sebelum keputusan — DLMM-LP perspective |
| **Multi-Timeframe** | Alignment score 6 TF (15m/30m/1H/4H/12H/24H) via Supertrend + RSI14 + MACD per TF |
| **Coin Filter (10-step)** | RugCheck (warn+danger → REJECT), mcap via GeckoTerminal, ATH drawdown filter, narrative, OKX honeypot, organic score |
| **TA Indicators** | RSI(14), RSI(2), Supertrend, Bollinger Bands, MACD — real candles dari GeckoTerminal |
| **Strategy Library** | 8 built-in strategies, auto-scored per kondisi market |
| **Darwinian Scoring** | Adaptive signal weights dari closed positions — recalibrate otomatis per N posisi, sliding 60-day window |
| **Pool Memory** | Histori deploy per pool — win rate, streak loss, cooldown otomatis (win: 1h, loss: 6h, streak: 24h, OOR: 12h) |
| **Smart Wallets** | Curated alpha wallet list — deteksi kehadiran mereka di pool via Meteora top LPers |
| **Tiered Lessons** | 3 tier injection ke prompt: PINNED (manual) > CROSS-POOL (conf≥0.6) > RECENT |
| **Auto Swap to SOL** | Token hasil close/claim otomatis di-swap ke SOL via Jupiter |
| **Trailing Take Profit** | Aktif saat profit ≥ threshold (configurable), close kalau turun X% dari peak |
| **OOR Bin Detection** | Tutup posisi kalau out-of-range melebihi N bins (paralel dengan time-based) |
| **Dry Run Mode** | Semua keputusan AI jalan normal, TX tidak dieksekusi — cocok untuk testing |
| **Helius Stack** | RPC + Enhanced API via Helius — holder data, priority fee P75, on-chain signals realtime |
| **Safety System** | Stop-loss, max drawdown harian, proactive exit bearish |
| **Multi AI Provider** | OpenRouter, Anthropic, OpenAI, atau custom API — ganti model live via `/model` |

---

## Yang Perlu Disiapkan Sebelum Install

**Wajib:**
1. **Node.js v20** via nvm (v21+ tidak kompatibel)
2. **Telegram Bot Token** — dari [@BotFather](https://t.me/BotFather)
3. **Telegram User ID** — dari [@userinfobot](https://t.me/userinfobot)
4. **AI API Key** — OpenRouter (recommended) dari [openrouter.ai/keys](https://openrouter.ai/keys)
5. **Helius API Key** — **wajib** untuk RPC + on-chain data, gratis di [helius.dev](https://helius.dev)
6. **Solana Wallet** — wallet BARU khusus bot, bukan wallet utama

**Opsional (meningkatkan kualitas signal):**
- **OKX API Key** — Smart Money signal, token risk scoring (okx.com/web3)

> GMGN sudah **dihapus sepenuhnya** — digantikan RugCheck.xyz (gratis, tanpa key) untuk token security.

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

### Step 4 — Daftar AI Provider

**OpenRouter (recommended):**
1. Daftar di [openrouter.ai](https://openrouter.ai)
2. Top up minimal **$5** di [openrouter.ai/credits](https://openrouter.ai/credits)
3. Buat API Key di [openrouter.ai/keys](https://openrouter.ai/keys) — format: `sk-or-v1-xxx...`

**Atau Anthropic langsung:**
- Daftar di [console.anthropic.com](https://console.anthropic.com) → buat API key

---

### Step 5 — Daftar Helius (Wajib)

1. Daftar di [helius.dev](https://helius.dev)
2. Dashboard → API Keys → buat key baru
3. Salin key (format: UUID)

Helius dipakai sebagai:
- **RPC utama** (`mainnet.helius-rpc.com`) — lebih reliable dari public RPC
- **Enhanced API** — holder data realtime, priority fee P75, on-chain signals

---

### Step 6 — Siapkan Wallet Solana

> **WAJIB gunakan wallet baru khusus bot.** Jangan pakai wallet utama.

Buat wallet baru di Phantom/Solflare, export private key (base58), isi dengan SOL secukupnya (mulai 0.5–1 SOL untuk testing).

---

### Step 7 — Konfigurasi `.env`

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
# ANTHROPIC_API_KEY=sk-ant-xxx...         # alternatif jika pakai Anthropic langsung
AI_MODEL=openai/gpt-4o-mini               # model rekomendasi (ganti via /model kapanpun)

# ── Solana ────────────────────────────────────────────────────────
HELIUS_API_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx   # WAJIB
# HELIUS_RPC_URL=https://your-dedicated-node.helius-rpc.com  # opsional override
WALLET_PRIVATE_KEY=your-base58-private-key

# ── Bot ───────────────────────────────────────────────────────────
ADMIN_PASSWORD=password-kuat-kamu

# ── Opsional — meningkatkan kualitas signal ───────────────────────
OKX_API_KEY=your-okx-key                 # Smart Money signal + token risk check
```

---

### Step 8 — Jalankan Bot

```bash
nvm use 20
npm start
```

Terminal akan tampil:
```
AI Provider: openrouter | Model: openai/gpt-4o-mini
RPC: Helius
Wallet loaded: <address>
Meteora DLMM Bot started! Mode: LIVE
```

Telegram kamu dapat pesan startup dengan balance + status.

Untuk verifikasi dasar workflow engineering:

```bash
npm test
```

CI GitHub sekarang juga menjalankan test otomatis pada push dan pull request.

---

### Step 9 — Verifikasi

Di Telegram ketik:

```
/testmodel    → cek model AI aktif
/status       → cek balance & posisi
```

Kalau `/testmodel` error → cek API key, ganti model di `.env`, atau gunakan `/model <model_id>`.

---

## Pilihan Model AI

Ganti kapanpun tanpa restart — ketik `/model <model_id>` di Telegram:

| Model | Kualitas | Estimasi/bulan | Notes |
|---|---|---|---|
| `openai/gpt-4o-mini` | ⭐⭐⭐⭐ | ~$5 | **Recommended** |
| `google/gemini-2.5-flash` | ⭐⭐⭐⭐ | ~$3 | Cepat & hemat |
| `anthropic/claude-sonnet-4-5` | ⭐⭐⭐⭐⭐ | ~$15 | Terbaik untuk reasoning kompleks |
| `openai/gpt-4o` | ⭐⭐⭐⭐⭐ | ~$30 | Paling pintar |
| `deepseek/deepseek-r1` | ⭐⭐⭐⭐ | ~$4 | Reasoning kuat, hemat |

> **Hindari free models** (`:free`) — sering rate-limited, tidak reliable untuk bot 24/7.

Reset ke default: `/model reset`

---

## Semua Commands Telegram

### Agent & Status
| Command | Fungsi |
|---|---|
| `/start` | Lihat semua commands & status bot |
| `/status` | Balance wallet, posisi terbuka, PnL live |
| `/hunt` | Jalankan Hunter Alpha manual — screen & deploy kandidat terbaik |
| `/heal` | Jalankan Healer Alpha manual |
| `/pools` | Tampilkan kandidat pool terbaik saat ini |
| `/results` | Laporan hasil hari ini per strategi |
| `/testmodel` | Cek status model AI + list model tersedia |

### Deploy & Screening
| Command | Fungsi |
|---|---|
| `/autoscreen on\|off` | Aktifkan/matikan auto-screening — Hunter autonomous screen & deploy tanpa persetujuan manual |
| `/dryrun on\|off` | Toggle dry run — semua TX disimulasikan, tidak dieksekusi |
| `/check <mint>` | Screen token manual — RugCheck + mcap + ATH drawdown + OKX |

### Intelligence & Memory
| Command | Fungsi |
|---|---|
| `/weights` | Lihat & recalibrate Darwinian signal weights |
| `/poolmemory` | Riwayat & performa deploy per pool (top/worst) |
| `/pinlesson <n>` | Pin lesson ke Tier 1 — selalu masuk prompt agent |
| `/unpinlesson <n>` | Unpin lesson |
| `/lessons` | Lihat semua lessons tersimpan beserta tier |
| `/memory` | Lihat trading memory & instincts |
| `/evolve` | Manual trigger evolve instincts |

### Smart Wallets
| Command | Fungsi |
|---|---|
| `/addwallet <addr> <label>` | Tambah alpha wallet ke tracking list |
| `/removewallet <addr>` | Hapus wallet dari list |
| `/listwallet` | Lihat semua tracked wallets + aktivitas |

### Strategy & Learning
| Command | Fungsi |
|---|---|
| `/library` | Lihat Strategy Library & skor per kondisi market |
| `/research` | Tambah strategi dari artikel (paste teks) |
| `/strategies` | Lihat strategi tersimpan |
| `/addstrategy <pw>` | Tambah strategi baru |
| `/learn [pool]` | Pelajari behavior top LPers pool tertentu |

### Config & Safety
| Command | Fungsi |
|---|---|
| `/model <model_id>` | Ganti model AI live tanpa restart |
| `/thresholds` | Lihat semua screening thresholds & performance stats |
| `/safety` | Status safety system & drawdown harian |

### Free-form Chat
Langsung ketik natural language:
- *"Pool mana yang fee APR tertinggi sekarang?"*
- *"Analisa market SOL hari ini"*
- *"Tutup semua posisi yang out of range"*

---

## Konfigurasi Lanjutan (`user-config.json`)

Auto-dibuat di root folder. Edit via Telegram chat atau langsung:

```json
{
  "deployAmountSol": 0.1,
  "maxPositions": 10,
  "minSolToOpen": 0.07,
  "gasReserve": 0.02,

  "managementIntervalMin": 10,
  "screeningIntervalMin": 30,
  "autoScreeningEnabled": false,

  "dryRun": false,

  "minBinStep": 1,
  "minTokenFeesSol": 0,
  "minTvl": 10000,
  "maxTvl": 150000,
  "minMcap": 250000,
  "maxMcap": 0,
  "minVolume24h": 1000000,

  "athFilterPct": -75,
  "athLookbackDays": 30,

  "takeProfitFeePct": 5,
  "trailingTriggerPct": 3.0,
  "trailingDropPct": 1.5,
  "outOfRangeWaitMinutes": 30,
  "outOfRangeBinsToClose": 10,
  "oorCooldownTriggerCount": 3,
  "oorCooldownHours": 12,

  "stopLossPct": 5,
  "maxDailyDrawdownPct": 10,
  "proactiveExitEnabled": true,
  "proactiveExitBearishConfidence": 0.7,

  "darwinWindowDays": 60,
  "darwinRecalcEvery": 5
}
```

Semua field di atas bisa diubah AI agent secara otomatis berdasarkan performa, dengan bounds validation (AI tidak bisa set nilai berbahaya).

---

## Strategi

### 8 Built-in Strategies

| Strategi | Kondisi Ideal |
|---|---|
| **Single-Side SOL** | Default — market apapun, fallback jika tidak ada signal jelas |
| **Evil Panda** | Uptrend + Supertrend 15m fresh cross — high-volume coins |
| **Wave Enjoyer** | Price ≤8% di atas support 24h + RSI14 35–62 + SIDEWAYS/mild down |
| **NPC** | Post-breakout konsolidasi — price range 24h >15% + ATR mengecil |
| **Fee Sniper** | BB squeeze (<8% bandwidth) + ATR <2% + Fee APR pool >200% |
| **Spot Balanced** | Sideways + volatilitas rendah — token stabil |
| **Bid-Ask Wide** | Volatilitas tinggi + volume di atas rata-rata |
| **Curve Concentrated** | Pool stabil + volatilitas sangat rendah |

### Evil Panda

Strategi single-side SOL berbasis TA signal, cocok untuk high-volume coins.

**Entry — semua syarat harus terpenuhi:**
- Pool bin step 80, 100, atau 125
- MC >$250k (via GeckoTerminal), Volume 24h >$1M
- Supertrend 15m `justCrossedAbove = true` (fresh cross — bukan sekadar bullish)
- Trend UPTREND | OKX Smart Money buying = bonus
- RugCheck: tidak ada warn/danger risk

**Exit — confluence ≥2 sinyal:**
- RSI(2) > 90 + price tutup di atas Bollinger Band upper
- RSI(2) > 90 + MACD histogram pertama kali hijau setelah merah

### Darwinian Scoring

Bot auto-recalibrate signal weights dari closed positions — setiap `darwinRecalcEvery` posisi ditutup, dalam sliding window `darwinWindowDays` hari:

| Signal | Default Weight | Arti |
|---|---|---|
| Market Cap proxy (TVL) | 2.5x | Prediktor kuat |
| Fee/TVL ratio | 2.3x | Prediktor kuat |
| Multi-TF alignment score | 1.5x | Bonus alignment 6 TF |
| Volume 24h | 0.36x | Signal lemah |
| Holder count | 0.3x | Signal lemah |

Lihat status dan trigger recalibrate via `/weights`.

---

## Coin Filter — 10-Step Pipeline

Setiap token wajib lolos 10 filter sebelum deploy:

| Step | Filter | Action jika gagal |
|---|---|---|
| 1 | Basic validation — logo + social links (DexScreener) | REJECT |
| 2 | Narrative filter — political/celebrity/justice/CTO patterns | REJECT |
| 3 | Price health — dump >15% dalam 1h, liquidity min, pair age | REJECT |
| 4 | Holder check — top-10 concentration >60%, holder count | REJECT |
| 5 | Txn analysis — heavy sell bias >80%, bot activity proxy | REJECT |
| 6 | Token safety — honeypot (OKX), high risk OKX | REJECT |
| 7 | Organic score — composite <65 | REJECT |
| 8 | **RugCheck** — `warn` atau `danger` risks → keduanya REJECT | REJECT |
| 9 | **Mcap filter** — via GeckoTerminal USD + DexScreener FDV fallback; null = skip | REJECT |
| 10 | **ATH drawdown** — >75% di bawah 30-day high; override jika smart wallet/OKX aktif | REJECT |

> Step 8 sebelumnya menggunakan GMGN — sekarang murni RugCheck.xyz (gratis, tanpa API key).

---

## Auto-Screening Flow

Ketika `autoScreeningEnabled = true`:

1. Cron berjalan tiap `screeningIntervalMin` menit
2. Cek balance cukup (≥ `deployAmountSol` + `gasReserve`) dan slot posisi tersedia (< `maxPositions`)
3. Hunter Alpha dijalankan — screen pool, score kandidat, pilih terbaik, **deploy otomatis**
4. Bot kirim notifikasi hasil deploy ke Telegram
5. Jika tidak ada kandidat yang layak → skip, cron jalan lagi di siklus berikutnya

Aktifkan via `/autoscreen on` atau set `autoScreeningEnabled: true` di config.

> Tidak ada approval dari user — Hunter bekerja sepenuhnya autonomous. Gunakan `/autoscreen off` untuk menghentikan.

---

## Pool Memory & Cooldown

Setiap pool punya histori deploy tersendiri. Setelah posisi ditutup:

| Kondisi | Cooldown |
|---|---|
| Profit (win) | 1 jam |
| Loss | 6 jam |
| 2+ loss berturut-turut | 24 jam |
| N kali OOR close (configurable) | 12 jam (configurable) |

Hunter otomatis skip pool yang sedang cooldown. Lihat histori via `/poolmemory`.

---

## Smart Wallet Tracking

Tambah alpha wallet yang sering jadi top LPer di pool bagus:

```
/addwallet <solana_address> <label>
```

Saat screening, bot cek apakah wallet ini ada di top 20 LPers pool tersebut (via Meteora API). Jika ada → confidence boost + override ATH filter.

---

## Safety System

| Layer | Fungsi |
|---|---|
| **Stop-loss** | Auto close kalau rugi > `stopLossPct` (default 5%) |
| **Trailing Take Profit** | Aktif saat profit ≥ `trailingTriggerPct` (3%), close kalau turun `trailingDropPct` (1.5%) dari peak |
| **OOR Time-based** | Close setelah `outOfRangeWaitMinutes` menit OOR (default 30 menit) |
| **OOR Bin-based** | Close kalau OOR melebihi `outOfRangeBinsToClose` bins (default 10) — lebih cepat dari time-based |
| **Max drawdown harian** | Freeze semua aktivitas kalau rugi > `maxDailyDrawdownPct` (default 10%) |
| **Proactive exit** | Close posisi profit kalau market BEARISH confidence >70% |
| **Dry Run** | TX tidak dieksekusi — screening, analisis, dan notifikasi tetap jalan normal |

---

## Data Sources

| Data | Source | API Key |
|---|---|---|
| RPC Solana | **Helius RPC** (`mainnet.helius-rpc.com`) | **Wajib** |
| OHLCV candles (15m–1D) | GeckoTerminal | Tidak perlu |
| Mcap USD + ATH approx | GeckoTerminal | Tidak perlu |
| Pool metrics (TVL, fee APR) | Meteora DLMM API | Tidak perlu |
| Price, sentiment, FDV | DexScreener | Tidak perlu |
| Token security (warn/danger risks) | **RugCheck.xyz** | Tidak perlu |
| Holder count, on-chain activity | **Helius Enhanced API** | Wajib |
| Priority fee P75 | **Helius getRecentPrioritizationFees** | Wajib |
| Smart Money signal, token risk | OKX OnchainOS | Opsional |
| Swap token → SOL | Jupiter V6 | Tidak perlu |

---

## Data & Backup

Bot auto-save semua data ke root folder:

| File | Isi | Kapan Update |
|---|---|---|
| `memory.json` | Trading history & instincts | Tiap posisi ditutup |
| `lessons.json` | Lessons dari top LPers (tiered) | Tiap `/learn` |
| `strategyPerformance.json` | Performa per strategi | Tiap Healer cycle |
| `strategy-library.json` | Library strategi | Tiap `/research` |
| `pool-memory.json` | Histori & cooldown per pool | Tiap deploy/close |
| `signal-weights.json` | Darwinian signal weights terkini | Tiap recalibration |
| `signals.json` | Snapshot sinyal saat deploy (untuk recalibration) | Tiap deploy |
| `smart-wallets.json` | Daftar alpha wallets | Tiap `/addwallet` |

Backup penting ke GitHub:
```bash
git add memory.json lessons.json strategyPerformance.json strategy-library.json \
        pool-memory.json signal-weights.json smart-wallets.json
git commit -m "backup data"
git push origin main
```

---

## Arsitektur

```
src/
├── index.js                    # Entry point, Telegram bot, cron, auto-screening autonomous
├── config.js                   # Config management + bounds validation + isDryRun()
├── agent/
│   ├── provider.js             # AI provider (OpenRouter/Anthropic/OpenAI/Custom)
│   ├── claude.js               # Free-form chat agent
│   └── modelCheck.js           # Startup model validation
├── agents/
│   ├── hunterAlpha.js          # Pool screening & autonomous deployment agent
│   └── healerAlpha.js          # Position management agent (trailing TP, OOR bins, auto-swap)
├── market/
│   ├── oracle.js               # OHLCV (GeckoTerminal), on-chain (Helius), multi-TF score
│   ├── analyst.js              # AI market analysis (DLMM LP perspective)
│   ├── coinfilter.js           # Token filter 10-step: RugCheck, mcap, ATH, OKX, DexScreener, Helius
│   ├── scamScreener.js         # Scam/rug detection (RugCheck + DexScreener + Jupiter)
│   ├── opportunityScanner.js   # Background scanner: Evil Panda, Wave Enjoyer, NPC, Fee Sniper
│   ├── taIndicators.js         # TA: RSI, Supertrend, Bollinger Bands, MACD, ATR
│   ├── poolMemory.js           # Per-pool deploy history, cooldown system (termasuk OOR)
│   ├── signalWeights.js        # Darwinian adaptive weights — sliding window recalibration
│   ├── smartWallets.js         # Alpha wallet tracking — cek kehadiran di pool
│   ├── memory.js               # Trading memory & instinct evolution
│   ├── researcher.js           # Extract strategi dari artikel
│   ├── strategyLibrary.js      # Strategy Library + scoring engine
│   └── strategyPerformance.js  # Daily results & strategy intelligence
├── safety/safetyManager.js     # Stop-loss, drawdown, trailing TP
├── learn/
│   ├── lessons.js              # Tiered lessons (PINNED > CROSS-POOL > RECENT)
│   └── evolve.js               # Threshold & Darwinian weight evolution
├── db/database.js              # SQLite: positions, history
├── solana/
│   ├── meteora.js              # Meteora DLMM SDK (dengan isDryRun guard)
│   ├── jupiter.js              # Jupiter V6 swap (dengan isDryRun guard + Helius priority fee)
│   └── wallet.js               # Solana wallet — Helius RPC primary
├── utils/
│   ├── helius.js               # Helius client: RPC, holder data, priority fee, on-chain signals
│   ├── safeJson.js             # fetchWithTimeout, safeNum, withRetry
│   ├── table.js                # Telegram formatting helpers
│   └── alerts.js               # Strategy alert formatter
├── strategies/
│   ├── strategyManager.js      # Strategy CRUD
│   └── strategyHandler.js      # Telegram conversation flow
└── monitor/positionMonitor.js  # Out-of-range alerts + periodic position status
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

**Bot tidak bales di Telegram (`401 Unauthorized`)**
- Token expired → generate baru di @BotFather

**`ALLOWED_TELEGRAM_ID` tidak dikenali**
- Harus angka, bukan `@username` → cek via [@userinfobot](https://t.me/userinfobot)

**Model AI error saat startup**
```
/testmodel   → lihat model yang tersedia
/model openai/gpt-4o-mini   → ganti model
```

**RPC error / 401 Unauthorized dari Helius**
- Cek `HELIUS_API_KEY` di `.env` — harus UUID yang valid dari dashboard Helius

**RPC 429 Too Many Requests (tanpa Helius)**
```env
HELIUS_API_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
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
