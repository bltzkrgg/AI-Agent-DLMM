# 🦞 Meteora DLMM Bot

**Autonomous AI Agent untuk Meteora DLMM liquidity management di Solana, diakses via Telegram.**

Inspired by [Meridian](https://github.com/yunus-0x/meridian) — dibangun ulang dengan arsitektur modular, multi-provider AI, dan sistem safety yang lebih robust.

---

## ✨ Fitur

| Fitur | Deskripsi |
|---|---|
| 🦅 **Hunter Alpha** | Auto screen & deploy ke pool terbaik tiap 30 menit |
| 🩺 **Healer Alpha** | Monitor & manage semua posisi tiap 10 menit |
| 🧠 **Market Analyst** | Analisa chart (OHLCV, volume, sentiment, on-chain) sebelum keputusan |
| 📚 **Learn** | Pelajari behavior top LPers, simpan lessons |
| 🧬 **Evolve** | Auto-adjust strategi dari trading history |
| 🔬 **Research** | Paste artikel → agent extract & simpan strategi otomatis |
| 🚫 **Scam Screener** | Deteksi rug/scam via RugCheck + GMGN + pattern analysis |
| 🛡️ **Safety System** | Stop-loss, max drawdown harian, konfirmasi sebelum deploy |
| 🔔 **Notifikasi** | Alert out-of-range, laporan setiap siklus Hunter/Healer |
| 🧪 **Dry Run Mode** | Simulasi penuh tanpa transaksi nyata |

---

## 💻 Spesifikasi Sistem

### Minimum (bisa jalan, mepet)
| Komponen | Requirement |
|---|---|
| **OS** | Linux, macOS, atau Windows (dengan WSL) |
| **Node.js** | v18.x – v20.x (**v20 LTS recommended**) |
| **RAM** | 512 MB |
| **CPU** | 1 core |
| **Storage** | 1 GB free (untuk node_modules ~400MB + data) |
| **Internet** | Koneksi stabil (bukan kecepatan, tapi uptime) |

### Recommended (untuk stable production)
| Komponen | Requirement |
|---|---|
| **Node.js** | v20.x LTS |
| **RAM** | 1 GB+ |
| **CPU** | 1-2 core |
| **Storage** | 2 GB free |
| **Internet** | Uptime > 99% |

> ⚠️ **Penting:** Gunakan Node.js **v20**, bukan v22/v24. Package `@meteora-ag/dlmm` memiliki ESM compatibility issue di Node v22+.

### Ukuran Instalasi
| Komponen | Ukuran |
|---|---|
| Source code | ~200 KB |
| `node_modules/` | ~400 MB |
| Database + logs | Kecil, tumbuh seiring waktu |
| **Total** | **~500 MB** |

### Memory saat runtime
- **~100–200 MB RAM** — tidak butuh GPU, semua AI computation di-offload ke cloud API

### Rekomendasi Hosting (untuk running 24/7)
| Platform | Harga | Cocok untuk |
|---|---|---|
| **VPS Contabo** | ~$5/bulan | 1–3 agent, paling hemat |
| **Railway.app** | ~$5/bulan | Deploy mudah, auto-restart |
| **DigitalOcean Droplet** | $6/bulan | Stabil, dokumentasi lengkap |
| **MacBook lokal** | Gratis | Testing/dev — mati kalau laptop mati |

---

## 🔧 Setup

### 1. Install Node.js v20

```bash
# Pakai nvm (recommended)
nvm install 20
nvm use 20
node --version  # harus v20.x.x
```

### 2. Clone & install dependencies

```bash
git clone https://github.com/bltzkrgg/Meteora-DLMM-Bot.git
cd Meteor-DLMM-Bot
npm install
```

### 3. Setup environment

```bash
cp .env.example .env
```

Edit `.env` dan isi semua value:

```env
# Telegram
TELEGRAM_BOT_TOKEN=        # dari @BotFather
ALLOWED_TELEGRAM_ID=       # dari @userinfobot (angka, bukan @username)

# AI Provider
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=        # dari openrouter.ai
AI_MODEL=anthropic/claude-sonnet-4   # atau model lain (lihat daftar di bawah)

# Solana
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
WALLET_PRIVATE_KEY=        # base58 — WALLET KHUSUS BOT, bukan wallet utama!

# Bot
ADMIN_PASSWORD=            # password untuk fitur admin
DRY_RUN=true               # SELALU true dulu saat pertama kali!
```

### 4. Jalankan (DRY RUN dulu!)

```bash
npm run dry
```

Kalau berhasil, bot Telegram akan kirim pesan:
```
🚀 Bot Started!
💰 X.XXXX SOL | Mode: DRY RUN
```

### 5. Switch ke LIVE (setelah yakin semua OK)

```
/dryrun off PASSWORD_KAMU
```

---

## 🤖 Supported AI Models (via OpenRouter)

| Model | Kecepatan | Kualitas | Biaya/hari* |
|---|---|---|---|
| `anthropic/claude-sonnet-4` | Sedang | ⭐⭐⭐⭐⭐ | ~$0.85 |
| `deepseek/deepseek-r1` | Sedang | ⭐⭐⭐⭐ | ~$0.10 |
| `google/gemini-2.0-flash` | Cepat | ⭐⭐⭐⭐ | ~$0.07 |
| `anthropic/claude-haiku-4-5` | Sangat cepat | ⭐⭐⭐ | ~$0.30 |
| `nvidia/llama-3.1-nemotron-ultra-253b-v1:free` | Lambat | ⭐⭐⭐ | Gratis** |

*estimasi untuk 1 agent, interval default  
**free tier memiliki rate limit ketat

Ganti model di `.env`:
```env
AI_MODEL=deepseek/deepseek-r1
```

---

## 📱 Telegram Commands

### Agent Control
| Command | Deskripsi |
|---|---|
| `/start` | Lihat semua commands |
| `/status` | Balance wallet & posisi terbuka |
| `/hunt` | Jalankan Hunter Alpha manual |
| `/heal` | Jalankan Healer Alpha manual |
| `/pools` | Screen kandidat pool terbaik sekarang |

### Scam & Token
| Command | Deskripsi |
|---|---|
| `/check <mint>` | Screen token scam/rug manual |

### Strategy & Learning
| Command | Deskripsi |
|---|---|
| `/library` | Lihat Strategy Library |
| `/research` | Tambah strategi dari artikel (paste teks) |
| `/strategies` | Lihat strategi tersedia |
| `/addstrategy <pw>` | Tambah strategi baru step-by-step |
| `/learn [pool]` | Pelajari top LPers di pool |
| `/lessons` | Lihat lessons tersimpan |
| `/memory` | Lihat trading memory & instincts |
| `/evolve` | Auto-evolve instincts dari trading history |

### Config & Safety
| Command | Deskripsi |
|---|---|
| `/thresholds` | Lihat screening thresholds & performance |
| `/safety` | Status safety, drawdown harian |
| `/dryrun <on\|off> <pw>` | Toggle DRY RUN / LIVE mode |

### Free-form Chat
Langsung ketik ke bot:
- *"Buka posisi di pool SOL-USDC"*
- *"Tutup semua posisi yang out of range"*
- *"Pool mana yang fee APR tertinggi hari ini?"*

---

## 🛡️ Safety System

Bot dilengkapi 4 layer safety:

1. **Stop-loss** — auto close posisi kalau rugi > `stopLossPct` (default 5%)
2. **Max drawdown harian** — freeze semua aktivitas kalau rugi > `maxDailyDrawdownPct` (default 10%)
3. **Validasi strategi** — cek kesesuaian strategi vs kondisi market sebelum deploy
4. **Konfirmasi Telegram** — minta approval kamu sebelum buka posisi baru

Semua bisa dikonfigurasi di `user-config.json`.

---

## ⚙️ Konfigurasi (`user-config.json`)

Auto-dibuat saat pertama run. Edit sesuai kebutuhan:

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

## 🌐 Arsitektur

```
src/
├── index.js                  # Entry point, Telegram bot, cron
├── config.js                 # Config management + bounds validation
├── utils/safeJson.js         # Safe JSON parse, fetchWithTimeout, retry
│
├── agent/
│   ├── claude.js             # Free-form AI chat agent
│   └── provider.js           # AI provider abstraction (OpenRouter/Anthropic/OpenAI)
│
├── agents/
│   ├── hunterAlpha.js        # Autonomous pool screening & deployment
│   └── healerAlpha.js        # Autonomous position management
│
├── market/
│   ├── oracle.js             # Data: OHLCV, liquidity, on-chain, sentiment
│   ├── analyst.js            # AI market analysis & thesis
│   ├── memory.js             # Trading memory & instinct evolution
│   ├── researcher.js         # Extract strategi dari artikel
│   ├── strategyLibrary.js    # Strategy Library + market matching
│   └── scamScreener.js       # Scam/rug detection
│
├── safety/
│   └── safetyManager.js      # Stop-loss, drawdown, confirmation
│
├── learn/
│   ├── lessons.js            # Learn dari top LPers
│   └── evolve.js             # Threshold evolution
│
├── db/database.js            # SQLite: positions, notifications, history
├── solana/
│   ├── meteora.js            # Meteora DLMM SDK integration
│   └── wallet.js             # Solana wallet & RPC
│
├── strategies/
│   ├── strategyManager.js    # Strategy CRUD (SQLite)
│   └── strategyHandler.js    # Telegram conversation flow
│
└── monitor/positionMonitor.js # Out-of-range alerts (30min cooldown)
```

---

## 🔒 Security

1. **Gunakan wallet KHUSUS bot** — jangan wallet utama, isi secukupnya saja
2. **`DRY_RUN=true` dulu** — verifikasi behavior sebelum live
3. **Jangan commit `.env`** — sudah ada di `.gitignore`
4. **Password admin yang kuat** — dipakai untuk `/addstrategy`, `/dryrun`, dll
5. **Gunakan Helius RPC** untuk production — public RPC sering rate-limited

---

## 🔧 Troubleshooting

**`ERR_UNSUPPORTED_DIR_IMPORT` saat start**
```bash
# Downgrade ke Node.js v20
nvm install 20 && nvm use 20
rm -rf node_modules && npm install
```

**`Cannot find module 'better-sqlite3'`**
```bash
npm install better-sqlite3 --build-from-source
```

**RPC 429 Too Many Requests**
```bash
# Ganti ke Helius (gratis di helius.dev)
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

**Bot tidak bales di Telegram**
Pastikan `ALLOWED_TELEGRAM_ID` berisi angka (bukan `@username`). Cek via [@userinfobot](https://t.me/userinfobot).

**xcode-select error di Mac**
```bash
xcode-select --install && npm install
```

---

## ⚠️ Disclaimer

Software ini disediakan apa adanya tanpa jaminan. Menjalankan autonomous trading agent membawa risiko finansial nyata — kamu bisa kehilangan dana. Selalu mulai dengan DRY RUN sebelum live. Jangan deploy modal yang tidak siap kamu kehilangkan. Ini bukan financial advice.

---

## License

MIT
