# DLMM Agent — Codex Sprint Handoff
**Audit date:** 2026-04-19 | **Tests:** 65/65 ✅ | **Lint:** pass ✅

---

## Section 1 — Context

Engine core complete untuk scope saat ini. Regresi hijau: `node --test tests/*.test.js` 65/65, lint lulus.

Fokus handoff ini:
- Mencegah re-implementasi area yang sudah stabil
- Menyamakan canonical codes (ada split naming yang perlu dikoreksi)
- Menutup residual risk sebelum rollout autonomous lebih agresif

**Hard constraint sepanjang sprint:**
Jangan sentuh `src/agents/healerAlpha.js`, `src/agents/hunterAlpha.js`, `src/solana/meteora.js` tanpa human review terlebih dahulu.

---

## Section 2 — Done State (jangan di-reimplementasi)

Semua line reference diverifikasi terhadap kode aktual 2026-04-19.

| Feature | File:Lines | Status |
|---------|-----------|--------|
| Hunter regime gate hard-block (`REGIME_BEAR_DEFENSE`) | `hunterAlpha.js:707-715` | ✅ DONE |
| Hunter fail-safe data/TA reliability (`FAIL_SAFE_UNRELIABLE_DATA`) | `hunterAlpha.js:717-730` | ✅ DONE |
| Hunter circuit breaker persisted-state check + reset | `hunterAlpha.js:956-977` | ✅ DONE |
| Runtime state flush sinkron ke disk | `src/runtime/state.js:68-74` | ✅ DONE |
| Manual close reconciliation + pool/strategy write-back | `healerAlpha.js:1084-1097` | ✅ DONE |
| `MAX_HOLD_EXIT` trigger code — kalkulasi + assignment | `healerAlpha.js:1135-1137`, `1322-1331` | ✅ DONE |
| Exit trigger propagasi konsisten ke close + analytics | `healerAlpha.js:1449`, `1516`, `1525` | ✅ DONE |
| SL cluster persistence untuk circuit breaker | `healerAlpha.js:1454-1471` | ✅ DONE |
| Pool memory + strategy performance write-through | `healerAlpha.js:84-103` | ✅ DONE |
| Rolling performance history max 50 + confidence blend | `strategyLibrary.js:502-527` | ✅ DONE |
| Market regime classifier — 4 regime | `strategyLibrary.js:393-497` | ✅ DONE |
| Baseline `Deep Fishing` strategy | `strategyManager.js:58-82` | ✅ DONE |
| `parseStrategyParameters` — `strategyType` derived mapping | `strategyManager.js:292-311` | ✅ DONE |
| Config profiles 3x tersedia | `user-config.example.json:_profiles` | ✅ DONE |
| Coverage test: breaker persist, max hold, regime | `tests/circuit-breaker-persist.test.js:15-37`, `max-hold-exit.test.js:10-22`, `strategyLibrary.test.js:5-47` | ✅ DONE |

---

## Section 3 — Canonical Codes

> Exact strings yang dipakai di log, DB, Telegram. Jangan buat alias baru.

### 3A — Exit trigger codes

Kolom `exitTrigger` = string yang dikirim ke `recordExitEvent()`.  
Kolom `closeReasonCode` = string di analytics layer (kadang berbeda — lihat catatan).

| exitTrigger | closeReasonCode | Source watcher | Catatan |
|-------------|----------------|----------------|---------|
| `TRAILING_TAKE_PROFIT` | `TRAILING_TAKE_PROFIT` | Main healer loop | Via `triggerCode` assignment |
| `TAKE_PROFIT` | `TAKE_PROFIT` | Main healer loop | Via `triggerCode` assignment |
| `MAX_HOLD_EXIT` | `MAX_HOLD_EXIT` | Main healer loop | Via `triggerCode` assignment |
| `OOR_BINS_EXCEEDED` | `OOR_BINS_EXCEEDED` | Main healer loop | Via `triggerCode` assignment |
| `STOP_LOSS` | `STOP_LOSS` | Main healer loop | Via `triggerCode` assignment |
| `GUARDIAN_ANGEL_DUMP` | `GUARDIAN_ANGEL_DUMP_EXIT` | Guardian Angel watchdog | ⚠️ **Split naming** — exitTrigger ≠ closeReasonCode |
| `ZOMBIE_EXIT` | `ZOMBIE_EXIT_${reason}` | Zombie watchdog | ⚠️ **Dynamic suffix** — e.g., `ZOMBIE_EXIT_VOLUME_COLLAPSE` |
| `TRAILING_TP_HIT` | `TAE_WATCHDOG_EXIT_${zone}` | TAE watchdog | ⚠️ **closeReasonCode adalah dynamic zone string** |
| `SUPERTREND_FLIP` | `TAE_WATCHDOG_MOMENTUM_EXIT_${zone}` | TAE watchdog | ⚠️ **Dynamic suffix** |
| `OOR_BAILOUT` | `OOR_HARD_EXIT_WATCHDOG` | OOR watchdog | ⚠️ **exitTrigger ≠ closeReasonCode** |
| `PANIC_EXIT_BEARISH_OOR` | `PANIC_EXIT_BEARISH_OOR` | Panic watchdog | Konsisten |
| `PROFIT_PROTECTION` | `PROFIT_PROTECTION_BEARISH` | Profit protection watchdog | ⚠️ **Split naming** |
| `MANUAL_CLOSE` | `MANUAL_CLOSE` | Manual reconciliation | `healerAlpha.js:1091` |

> **Aturan watcher:** Main healer loop (`healerAlpha.js:1322-1331`) hanya emit 5 kode via `triggerCode`: `TRAILING_TAKE_PROFIT`, `TAKE_PROFIT`, `MAX_HOLD_EXIT`, `OOR_BINS_EXCEEDED`, `STOP_LOSS`. Semua kode lain berasal dari watchdog terpisah di bawah baris 1900.

### 3B — Entry / policy block codes

| Code | Policy field | Source |
|------|-------------|--------|
| `REGIME_BEAR_DEFENSE` | `policy` | `hunterAlpha.js:713` |
| `FAIL_SAFE_UNRELIABLE_DATA` | `policy` | `hunterAlpha.js:729` |
| `CIRCUIT_BREAKER_ACTIVE` | Pause state (tidak di-emit ke exitTrigger) | `hunterAlpha.js:960-969` — baca dari `runtime-state.json` |

### 3C — Schema risk code (analytics only)

| Code | Status | Catatan |
|------|--------|---------|
| `SL_CLUSTER_THRESHOLD_MET` | ⚠️ **Schema-only — NOT emitted in src** | `rg "SL_CLUSTER_THRESHOLD_MET" src` = 0 results. Hanya ada di `AGENT_EXECUTION_SCHEMA.md`. Circuit breaker trip tidak menghasilkan exit code ini di DB. → P0-A risk. |

### 3D — Klarifikasi wajib

- **`SL_COOLDOWN_ACTIVE`**: Healer HOLD-path delay untuk close decision, bukan Hunter entry block. (`AGENT_EXECUTION_SCHEMA.md:72-73`)
- **`CIRCUIT_BREAKER_ACTIVE`**: Hunter pause state dari persisted `runtime-state.json`. Bukan exit code.
- Semua split naming di 3A adalah masalah yang ada di kode saat ini — jangan "fix" di sprint ini tanpa explicit task.

---

## Section 4 — Config Profiles

Source: `user-config.example.json` → field `_profiles`.

| Profile key | deployAmountSol | maxPositions | stopLossPct | maxHoldHours | maxTvl | minVolumeTvlRatio | dailyLossLimitUsd | dryRun |
|-------------|----------------:|-------------:|------------:|-------------:|-------:|------------------:|------------------:|--------|
| `conservative_live` | 0.25 | 1 | 3 | 4 | 100 000 | 30 | 10 | false |
| `balanced` | 0.5 | 3 | 5 | 6 | 500 000 | 20 | 25 | true |
| `aggressive_experimental` | 1.0 | 5 | 8 | 12 | 2 000 000 | 10 | 50 | false |

Active values = flat keys di bawah block `_profiles`. Copy nilai profile yang dipilih ke sana.

---

## Section 5 — Residual Risks P0–P2

### P0 — Blocks live capital deployment

**P0-A: `SL_CLUSTER_THRESHOLD_MET` tidak ter-emit ke `exit_events`**
- Impact: Circuit breaker trip tidak muncul sebagai auditable exit event di analytics layer. Operator tidak bisa query DB untuk melihat kapan breaker dipicu dari history close.
- Evidence: `rg "SL_CLUSTER_THRESHOLD_MET" src` = **Not Found**. Healer hanya set `hunter-circuit-breaker` di runtime state dan tidak emit code ini ke `recordExitEvent`.
- Mitigation: Tambah event record atau note field saat breaker trip, atau explicit mapping di analytics → Sprint 1 Task 1.

**P0-B: Tidak ada integration test full lifecycle**
- Impact: Regressi lintas modul (entry → hold → max hold exit → swap → DB) tidak tertangkap unit test.
- Evidence: `tests/max-hold-exit.test.js:10-22` hanya assertion sumber, bukan simulasi siklus penuh.
- Mitigation: Integration harness dengan fixture DB + mocked chain snapshot → Sprint 1 Task 2.

**P0-C: Zero real performance data**
- Impact: Darwin scoring dan confidence blend (`strategyLibrary.js:523`) belum terkalibrasi market nyata.
- Evidence: `strategy-library.json` semua `performanceHistory: []`.
- Mitigation: Jalankan canary dengan minimum sample threshold sebelum confidence dipakai agresif.

### P1 — Degrades autonomy, non-blocking

**P1-A: Signal accuracy tergantung fallback `Momentum-Proxy`**
- Impact: False positive trend signal saat OHLCV history tidak tersedia.
- Evidence: `src/market/oracle.js:317-327` — `Momentum-Proxy` fallback aktif jika `historySuccess: false`.
- Mitigation: Backtest-lite fixture untuk ukur false-positive rate → Sprint 2 Task 1.

**P1-B: PnL source arbitration prefer provider walau divergence besar**
- Impact: Mispricing decision jika provider drift dari on-chain lebih dari threshold.
- Evidence: `src/app/pnl.js:21` — selalu memilih `lp_agent` meski divergence tinggi; hanya `console.warn`.
- Mitigation: Policy flag `prefer_onchain_when_divergence_high` + dual-path test → Sprint 2 Task 2.

### P2 — Operator UX, non-blocking

**P2-A: `/strategy_report` belum ada**
- Evidence: `rg "strategy_report" src` = **Not Found**.
- Mitigation: → Sprint 3 Task 2.

**P2-B: `/claim_fees` alias belum ada (hanya `/claim`)**
- Evidence: `/claim` ada di `src/index.js:1555-1584`. `/claim_fees` = **Not Found**.
- Mitigation: Tambah alias → Sprint 3 Task 1.

---

## Section 6 — Codex Action List

### Sprint 1 — Verify + Harden

**Task 1.1 — Emit `SL_CLUSTER_THRESHOLD_MET` ke analytics (P0-A)**
```
Files:  src/db/exitTracking.js, AGENT_EXECUTION_SCHEMA.md
Check:  Di healerAlpha.js:1454-1471, saat recentSLEvents.length >= cbCount, breaker di-set
        tapi tidak ada recordExitEvent() call dengan code ini.
Action: Tambah di analytics layer (exitTracking atau note field di runtime-state) agar
        circuit breaker trip tercatat sebagai event auditable dengan timestamp + SL count.
Constraint: JANGAN ubah healerAlpha.js langsung.
        Alternatif bersih: tambah fungsi di exitTracking.js → panggil dari tempat yang
        sudah di-approve atau expose via state API.
        Jika butuh healer change → flag untuk human review.
Test:   Tambah assertion di tests/circuit-breaker-persist.test.js bahwa trip event tercatat.
```

**Task 1.2 — Integration test full lifecycle (P0-B)**
```
File:   tests/integration-lifecycle.test.js (baru)
Scope:  Mock Solana/Meteora IO (tidak perlu real RPC)
Cases:
  - Pool discovered → position opened → DB status = 'active'
  - Healer cycle → STOP_LOSS fires → exitTrigger = 'STOP_LOSS' di exit_events
  - Healer cycle → maxHoldHours elapsed → exitTrigger = 'MAX_HOLD_EXIT'
  - Hunter blocked by REGIME_BEAR_DEFENSE → tidak ada position dibuka
  - Hunter blocked by CIRCUIT_BREAKER_ACTIVE → runtime-state.json punya hunter-circuit-breaker key
Constraint: Mock external IO; test harus deterministik dan offline.
```

**Task 1.3 — Guard manual edit confidence di strategy library (P0-C adjacent)**
```
Files:  src/market/strategyLibrary.js, strategy-library.json
Check:  Saat ini tidak ada validasi bahwa confidence tidak diedit manual di luar normal range.
Action: Tambah schema validation atau checksum note di saveLibrary():
        - confidence harus antara 0.0–1.0
        - jika performanceHistory kosong, confidence tidak boleh di-blend (biarkan original)
Constraint: Backward-compatible dengan format JSON existing.
Test:   Tambah assertion di tests/strategyLibrary.test.js.
```

---

### Sprint 2 — Signal Validation + PnL Fallback

**Task 2.1 — Backtest-lite `Momentum-Proxy` vs real Supertrend (P1-A)**
```
File:   tests/oracle-signal-accuracy.test.js (baru)
Scope:  Fixture dataset — tidak pakai network live
Check:  Kalkulasi ulang Supertrend(period=10, multiplier=3) dari OHLCV fixture
        vs Momentum-Proxy output untuk sample yang sama.
Metric: False-positive rate = % flip BULLISH dari proxy yang tidak dikonfirmasi oleh
        real Supertrend dalam 4 candle berikutnya.
Output: console.log tabel hasil + gagal test jika false-positive > 40%.
Constraint: JANGAN ubah oracle.js atau hunterAlpha.js.
```

**Task 2.2 — Policy fallback PnL divergence (P1-B)**
```
Files:  src/app/pnl.js, tests/pnl.test.js
Check:  resolvePnlSnapshot() saat ini selalu memilih providerPnlPct (lp_agent) walau
        divergence > divergenceThresholdPct (default 10%). Hanya log warning.
Action: Tambah parameter opsional `policy: 'prefer_onchain_when_divergence_high'`
        Jika policy aktif + divergence > threshold → pilih directPnlPct sebagai kandidat.
        Default behavior TIDAK berubah (backward-compatible).
Constraint: Default path tidak boleh berubah tanpa config flag.
Test:   tests/pnl.test.js — tambah case: policy aktif + divergence > threshold →
        verifikasi selectedSource = 'on_chain'.
```

---

### Sprint 3 — Telegram Operations

**Task 3.1 — `/claim_fees` alias (P2-B)**
```
File:   src/index.js
Check:  /claim sudah ada di index.js:1555-1584, pattern: bot.onText(/\/claim(?:\s+(\S+))?/, ...)
Action: Tambah handler terpisah dengan pattern /\/claim_fees(?:\s+(\S+))?/
        Internal: panggil fungsi yang sama persis dengan /claim handler.
        Response format: sama (sukses/gagal message).
Constraint: ALLOWED_ID check wajib. Jangan ubah logic /claim yang sudah ada.
Test:   Manual smoke test via Telegram.
```

**Task 3.2 — `/strategy_report` read-only (P2-A)**
```
Files:  src/index.js, src/market/strategyLibrary.js
Action: Tambah bot.onText(/\/strategy_report/, ...) dengan output:
  - Regime saat ini (dari classifyMarketRegime() last snapshot atau cached)
  - Per strategy: name, confidence, performanceHistory.length, win rate %
  - Format: HTML tabel ringkas untuk Telegram
Constraint: Read-only — JANGAN trigger trade action apapun dari command ini.
            ALLOWED_ID check wajib.
```

---

## Section 7 — Hard Constraints

```
src/agents/healerAlpha.js  → JANGAN SENTUH tanpa human review
src/agents/hunterAlpha.js  → JANGAN SENTUH tanpa human review
src/solana/meteora.js      → JANGAN SENTUH tanpa human review
```

Exception: patch P0 safety-critical diizinkan hanya setelah explicit approval + documented reason.

---

## Section 8 — Verification Commands

```bash
# 1. Canonical code coverage — cek konsistensi lintas docs dan src
rg -n "SL_CLUSTER_THRESHOLD_MET|MAX_HOLD_EXIT|REGIME_BEAR_DEFENSE|SL_COOLDOWN_ACTIVE|CIRCUIT_BREAKER_ACTIVE" \
  AGENT_EXECUTION_SCHEMA.md src user-config.example.json

# 2. Pastikan label lama 'CIRCUIT_BREAKER' tidak ter-emit sebagai exitTrigger
rg -n "exitTrigger\s*:\s*['\"]CIRCUIT_BREAKER['\"]" src

# 3. Cek /strategy_report command sudah ada (harus Not Found sebelum Sprint 3)
rg -n "strategy_report|/strategy_report" src/index.js src/agents

# 4. Cek /claim dan claim_fees
rg -n "onText.*\/claim|claim_fees" src/index.js

# 5. Full unit regression (harus 65/65 sebelum dan sesudah tiap sprint)
node --test tests/*.test.js

# 6. Lint
npm run lint
```

---

## Section 9 — Reference Map

| Pertanyaan | File:Lines |
|------------|-----------|
| Entry block regime BEAR_DEFENSE | `hunterAlpha.js:707-715` |
| Entry block FAIL_SAFE_UNRELIABLE_DATA | `hunterAlpha.js:717-730` |
| Hunter circuit breaker pause / resume | `hunterAlpha.js:956-977` |
| Max hold kalkulasi + trigger assignment | `healerAlpha.js:1135-1137`, `1322-1331` |
| exitTrigger wired ke exit tracking | `healerAlpha.js:1516` |
| closeReasonCode wired ke analytics | `healerAlpha.js:1525` |
| SL cluster → circuit breaker persist | `healerAlpha.js:1454-1471` |
| Strategy performance write-back | `healerAlpha.js:84-103` |
| Confidence blend logic | `strategyLibrary.js:518-527` |
| Regime classifier | `strategyLibrary.js:393-497` |
| Baseline Deep Fishing | `strategyManager.js:58-82` |
| strategyType derived mapping | `strategyManager.js:292-311` |
| Profile config | `user-config.example.json:_profiles` |
| PnL divergence behavior | `src/app/pnl.js:17-44` |
| Momentum-Proxy fallback | `src/market/oracle.js:317-327` |
| Manual /claim command | `src/index.js:1555-1584` |
| Schema canonical codes | `AGENT_EXECUTION_SCHEMA.md:43-73`, `192-204` |

---

## Audit Notes (2026-04-19)

Mismatch yang ditemukan antara source-of-truth sebelumnya dan kode aktual:

| # | Claim Asal | Kenyataan di Src | Aksi |
|---|-----------|-----------------|------|
| 1 | `GUARDIAN_ANGEL_DUMP` (canonical exit code) | `exitTrigger='GUARDIAN_ANGEL_DUMP'` ✅, tapi `closeReasonCode='GUARDIAN_ANGEL_DUMP_EXIT'` — split naming | Dicatat di Section 3A. Jangan "fix" tanpa P1 task eksplisit. |
| 2 | `ZOMBIE_EXIT` (static code) | `exitTrigger='ZOMBIE_EXIT'` ✅, tapi `closeReasonCode=ZOMBIE_EXIT_${reason}` — dynamic suffix | Dicatat di Section 3A. |
| 3 | `PROFIT_PROTECTION` (canonical) | `exitTrigger='PROFIT_PROTECTION'` ✅, tapi `closeReasonCode='PROFIT_PROTECTION_BEARISH'` — split naming | Dicatat di Section 3A. |
| 4 | `OOR_BAILOUT` → dianggap konsisten | `exitTrigger='OOR_BAILOUT'` tapi `closeReasonCode='OOR_HARD_EXIT_WATCHDOG'` — split naming | Dicatat di Section 3A. |
| 5 | `SL_CLUSTER_THRESHOLD_MET` di canonical exit list | **Not Found in src/** — schema-only code | P0-A risk, sudah benar di-flag. |
| 6 | healerAlpha manual close: Section 2 menyebut "pool/strategy write-back" di 1084-1097 | ✅ Line range akurat — `closePositionWithPnl` di 1090, `recordPoolCloseOutcome` di 1094 | Tidak ada masalah. |
| 7 | Semua line numbers lain (Section 2, 9) | ✅ Verified akurat terhadap kode 2026-04-19 | Tidak ada masalah. |
