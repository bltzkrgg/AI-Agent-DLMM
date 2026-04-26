# AI-Agent-DLMM: Linear Sniper & Evil Panda LP

> Autonomous Liquidity Provider bot untuk Meteora DLMM — arsitektur stateless, RPC-first, zero database.

---

## Filosofi: Linear Sniper

Bot ini bukan multi-strategy engine. Ini adalah **satu mesin, satu tugas**: temukan pool DLMM terbaik, masuk dengan presisi, keluar di waktu yang tepat.

Alur kerja bersifat sekuensial dan deterministik — tidak ada eksekusi paralel, tidak ada race condition:

```
SCAN ──► SCREEN ──► VETO ──► DEPLOY ──► MONITOR ──► EXIT ──► RELOAD
  ▲                                                              │
  └──────────────────── loop berikutnya ◄───────────────────────┘
```

| Fase | Modul | Deskripsi |
|---|---|---|
| **SCAN** | `meridianVeto.js` | Discover pool high-fee via Meridian API / Meteora Discovery |
| **SCREEN** | `coinfilter.js` | Filter GMGN: holders, wash trade, LP burned, tax, bundler |
| **VETO** | `meridianVeto.js` | 4 gate: Supertrend · ATH Guard · PVP Guard · Dominance |
| **DEPLOY** | `evilPanda.js` | Buka posisi single-side SOL, chunked transactions |
| **MONITOR** | `evilPanda.js` | Poll on-chain + Meridian TA setiap 15 detik |
| **EXIT** | `evilPanda.js` | Withdraw 100% + swap sisa token ke SOL |

---

## Strategi: Evil Panda

**Evil Panda** adalah strategi LP satu sisi (SOL-only deposit) dengan rentang dalam:

```
Rentang posisi: 0% → -90% di bawah harga aktif
Deposit:        100% SOL (token Y), 0% token X
Distribusi:     Spot (merata di seluruh bin)
Chunk TX:       Max 69 bins per transaksi
```

**Target pool:**
- `binStep` prioritas: **200 → 125 → 100** (fee tertinggi diutamakan)
- `fee/active_tvl ratio` ≥ 0.2% per hari
- Pool dominance ≥ 15% total TVL token di jaringan
- Pool usia ≤ 3 hari (fresh momentum)

**Logika:** Bot menaruh SOL di bawah harga, menunggu harga turun ke dalam range, dan mengumpulkan fee. Saat RSI(2) overbought atau harga reversal, bot keluar dan swap ke SOL.

---

## Meridian Intelligence (VETO Gates)

Bot mengintegrasikan API `https://api.agentmeridian.xyz/api` untuk 4 lapisan filter:

### Gate 1 — Supertrend 15m
```
GET /chart-indicators/{mint}?interval=15_MINUTE
VETO jika supertrend.direction === 'bearish'
Fail-open: jika API down → PASS
```

### Gate 2 — ATH Guard `[TA_ATH_DANGER]`
```
GET /price-info/{mint}  (fallback: datapi.jup.ag)
VETO jika harga > (100 - maxAthDistancePct)% dari ATH
Default: maxAthDistancePct=15 → VETO jika > 85% ATH
```

### Gate 3 — PVP Guard
```
Cari token rival (simbol sama, mint berbeda)
VETO jika rival punya pool dominan (TVL > $5k + holders > 500)
```

### Gate 4 — Dominance Check `[LOW_DOMINANCE]`
```
GET dlmm.datapi.meteora.ag/pools?query={mint}
dominancePct = poolTvl / totalNetworkTvl × 100
VETO jika dominancePct < 15%
```

---

## Smart Exit (TAHAP 4)

`monitorPnL()` berjalan setiap 15 detik dengan priority chain:

```
P1: Hard Stop Loss         pnlPct ≤ -10%          → EXIT (tidak butuh API)
P2: Trailing Stop Loss     (HWM - pnlPct) ≥ 5%    → EXIT (High Water Mark)
P3: Meridian TA Exit       RSI(2) ≥ 90 + trigger   → EXIT
    Skenario A: RSI(2) ≥ 90 AND Close ≥ BB_Upper
    Skenario B: RSI(2) ≥ 90 AND MACD_hist > 0
    Fail-open: jika Meridian API down → HOLD
```

Setiap posisi yang ditutup dicatat ke `harvest.log`:
```
2026-04-26T12:05:00Z,So11111,ab3f1234,+14.23,0.5000,TAKE_PROFIT_A
```

---

## Arsitektur: Stateless

Bot ini **tidak menggunakan database lokal**. State disimpan in-memory:

```js
const _activePositions = new Map();
// Key: positionPubkey
// Value: { poolAddress, deploySol, deployedAt, tokenXMint, tokenYMint,
//          rangeMin, rangeMax, hwmPct }
```

Jika bot di-restart, posisi terbuka di-recover langsung dari on-chain via `getPositionsByUserAndLbPair()`.

**Partial Deploy Guard:** Jika chunk TX gagal di tengah-tengah deploy, posisi yang sudah terbuka otomatis di-rollback via `exitPosition('PARTIAL_DEPLOY_ROLLBACK')`.

---

## Konfigurasi

Semua konfigurasi di `user-config.json` (flat, tidak ada nested object).

### Konfigurasi Utama

| Key | Default | Deskripsi |
|---|---|---|
| `deployAmountSol` | `1.0` | SOL per posisi |
| `binStepPriority` | `[200,125,100]` | Urutan prioritas bin step |
| `maxAthDistancePct` | `15` | ATH guard threshold (%) |
| `trailingStopPct` | `5.0` | Trailing SL dari High Water Mark |
| `slippageBps` | `150` | Slippage DLMM (basis points) |
| `dryRun` | `false` | `true` = simulasi tanpa TX |
| `publicApiKey` | `''` | API key Meridian |

### Model LLM — ubah via `.env`

```bash
SCREENING_MODEL=nvidia/nemotron-3-super-120b-a12b:free
MANAGEMENT_MODEL=minimax/minimax-m2.5:free
AGENT_MODEL=deepseek/deepseek-v3.2
```

---

## Telegram Commands

| Command | Deskripsi |
|---|---|
| `/hunt` | Mulai siklus scan → screen → deploy |
| `/status` | Tampilkan posisi aktif dan PnL real-time |
| `/exit` | Tutup semua posisi aktif secara manual |
| `/config` | Tampilkan konfigurasi aktif |
| `/stop` | Hentikan semua loop otonom |

---

## Persyaratan

```bash
# .env wajib:
HELIUS_API_KEY=           # RPC + priority fee
WALLET_PRIVATE_KEY=       # Wallet khusus bot (bukan wallet utama)
TELEGRAM_BOT_TOKEN=
ALLOWED_TELEGRAM_ID=
OPENROUTER_API_KEY=       # Atau provider LLM lain

# Opsional:
OKX_API_KEY=
GMGN_API_KEY=
```

```bash
npm install
npm run dev
```

---

## Stack

| Layer | Teknologi |
|---|---|
| Blockchain | Solana (Helius RPC) |
| LP Protocol | Meteora DLMM SDK |
| Intelligence | Meridian API |
| Screening | GMGN, DexScreener, OKX OnChain |
| Swap | Jupiter Quote API V6 |
| LLM | OpenRouter (configurable via .env) |
| Bot Interface | Telegram Bot API |

---

*Bot ini dirancang untuk operator yang memahami risiko LP di Meteora DLMM. Selalu gunakan wallet terpisah dengan dana yang siap untuk rugi.*
