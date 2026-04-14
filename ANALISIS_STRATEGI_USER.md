# ANALISIS STRATEGI: -86% to -94% Deep Fishing SOL Spot LP

**Status:** ANALISIS SAJA - Belum ada perubahan kode  
**Tanggal:** 2026-04-14

---

## 🎯 STRATEGI USER (SPESIFIKASI EXACT)

### Signal Entry
```
TRIGGER: 15-minute Supertrend Bullish FLIP
KONDISI: Harga > garis Supertrend (trend berubah dari BEARISH ke BULLISH)
TUNGGU: Candle close di ATAS Supertrend (bukan hanya wick menyentuh)
```

### Tipe Posisi
```
MODE: One-Sided SOL (Spot DLMM)
SISI TOKEN X: 0 (tidak beli token lain)
SISI TOKEN Y: Full amount SOL (bid-side liquidity only)
PAIR EXAMPLES: WETH/SOL, USDC/SOL, dsb.
```

### Range Likuiditas (OFFSET EXACT)
```
HARGA SEKARANG: 100%
MIN OFFSET: -94%  ← Batas bawah (paling dalam)
MAX OFFSET: -86%  ← Batas atas (lebih shallow)
LEBAR RANGE: -94% sampai -86% (8 poin persen SAJA)
STRATEGI: "Deep Fishing" — Hanya bid di zona crash
```

### Prioritas Pool Selection
```
PRIORITAS 1: BinStep = 80  (presisi terbaik, 0.008% per bin)
PRIORITAS 2: BinStep = 100 (standard, 0.01% per bin)
PRIORITAS 3: BinStep = 125 (balanced, 0.0125% per bin)
HINDARI: > 125 (terlalu kasar)
```

### Logika Eksekusi
```
STEP 1: Tunggu candle 15m CLOSE di ATAS garis Supertrend
STEP 2: Hitung range likuiditas pakai offset -86% ke -94%
STEP 3: Deploy SOL ke pool dalam range itu
STEP 4: Kalau harga BERGERAK saat deploy, RECALCULATE offset
        untuk maintain gap -86% ke -94% relatif HARGA BARU
STEP 5: Monitor terus - adjust range kalau diperlukan
```

---

## 🔴 PERBANDINGAN: CURRENT CODE vs USER REQUIREMENT

### Problem 1: OFFSET TIDAK SESUAI

**Current Code (Evil Panda):**
```javascript
// src/strategies/strategyManager.js
deploy: {
  entryPriceOffsetMin: 0,    // Harga current (TOP)
  entryPriceOffsetMax: 94,   // 94% di bawah current (BOTTOM)
}
```

**Current Range:** 0% → -94% (spektrum penuh dari sekarang sampai -94% drop)  
**User Requirement:** -86% → -94% (narrow deep zone SAJA)

❌ **MISMATCH:** User hanya ingin -86% sampai -94% (8 poin persen window)  
Current deploy dari 0% sampai -94% (full spectrum)

---

### Problem 2: SUPERTREND FLIP BELUM IMPLEMENTED

**Current Code:**
```javascript
// hunterAlpha.js
entry: {
  requireSupertrendBullish: true,  // Cek bullish OK
  // TAPI TIDAK CEK: apakah ada FLIP?
  // TAPI TIDAK CEK: tunggu 15m candle close?
}
```

**User Requirement:**
```
Detect trend FLIP (previous candle ≠ current candle)
Wait for 15m candle CLOSE above Supertrend (bukan high touch doang)
Then deploy
```

❌ **MISSING:** Flip detection dan candle close confirmation

---

### Problem 3: LIVE PRICE TRACKING TIDAK ADA

**Current Behavior:**
- Offset dihitung SAAT deploy time
- Kalau harga gerak SELAMA execution, offset TIDAK recalc
- Range tetap dengan offset yang OLD

**User Requirement:**
```
Kalau harga gerak sebelum TX settle, RECALCULATE:
- New price = harga sekarang (mungkin sudah berubah)
- offsetMin = new price - (0.86 * new price)
- offsetMax = new price - (0.94 * new price)
- Deploy ke range yang updated (maintain -86% to -94% gap)
```

❌ **MISSING:** Live price tracking dan dynamic offset recalculation

---

### Problem 4: BINSTEP 80 TIDAK SUPPORTED

**Current Code:**
```javascript
allowedBinSteps: [100, 125],  // Only 100 dan 125
```

**User Priority:**
```
1. BinStep 80 (finest precision)
2. BinStep 100
3. BinStep 125
```

❌ **MISSING:** BinStep 80 support

---

### Problem 5: RANGE WIDTH CALCULATIONS

**Current:** ~1000 bins (clamped hardcoded)  
**User Requirement:** ~4-6 bins (untuk -86% to -94% window)

```
Dengan binStep = 100:
  -86% to -94% = 8 poin persen range
  8% / (100/10000) = 8% / 0.01% = 800 teoritis
  
TAPI dengan logarithmic calculation:
  offsetMinBins(86) ≈ 62 bins
  offsetMaxBins(94) ≈ 66 bins
  Range width = 4 bins SAJA ✅ (sangat sempit!)
```

⚠️ **ISSUE:** 4 bins sangat sempit, risky untuk liquidity depth

---

## 📊 TABEL PERBANDINGAN LENGKAP

| **Aspek** | **Current Code** | **User Requirement** | **Status** |
|---|---|---|---|
| **Offset Min** | 0% | -86% | ❌ SALAH |
| **Offset Max** | -94% | -94% | ✅ OK |
| **Range Type** | Spektrum penuh (0 → -94%) | Deep zone only (-86 → -94%) | ❌ SALAH |
| **Supertrend Signal** | Bullish OK | Bullish FLIP di 15m close | ⚠️ PARTIAL |
| **Candle Confirmation** | Tidak ada | Tunggu close di atas ST | ❌ MISSING |
| **Price Recalc** | TIDAK | YA (live tracking) | ❌ MISSING |
| **BinStep Priority** | [100, 125] | [80, 100, 125] | ❌ MISSING 80 |
| **Range Width (bins)** | ~1000 clamped | ~4-6 bins | ❌ SALAH |

---

## 📈 CONTOH SCENARIO

### Situasi
```
Pool: WETH/SOL
BinStep: 100
Harga Sekarang: $2000
Active Bin: 10000
Supertrend: $1980 (garis bullish)
Baru saja CLOSE di atas Supertrend
```

### Perilaku Current Code
```
offsetMin: 0 → rangeMax di bin 10000 (harga current)
offsetMax: 94 → rangeMin di bin 9000 (kira-kira 94% bawah)
Range deploy: bin 9000-10000 (lebar 1000 bin)
HASIL: Likuiditas full dari harga sekarang sampai -94%
```

### Yang Seharusnya User Lakukan
```
offsetMin: -86% → rangeMax di bin 9862 (86% bawah = $280)
offsetMax: -94% → rangeMin di bin 9660 (94% bawah = $120)
Range deploy: bin 9660-9862 (deep zone SAJA, ~4 bin)
HASIL: Likuiditas concentrated HANYA di -86% sampai -94% zone
       (membeli crash masif, BUKAN menangkap upside)
```

---

## ⚠️ IMPLIKASI STRATEGI

### Apa Yang User Lakukan
1. **Tunggu signal bullish** (Supertrend flip) = konfirmasi reversal downtrend
2. **Tempat deep bid** hanya di crash zone (-86% sampai -94%) = extreme value hunting
3. **Doakan terjadi crash** = kalau harga drop 86-94%, fee generation MASIF
4. **Kalau tidak crash** = capital idle, tidak earning

### Risk Profile
```
UPSIDE:     Kalau crash terjadi → FEE APR LUAR BIASA BESAR
DOWNSIDE:   Kalau price tidak crash → capital trapped deep
KEGUNAAN:   Capital sangat tidak efisien (full 0.5 SOL idle)
TIME VALUE: Posisi valuable HANYA kalau crash dalam N jam
```

### Ini BUKAN "Wide Range" Standard
- **Wide Range** = tangkap upside DAN downside = dual-purpose
- **Strategi User** = ultra-deep one-sided bid = crash-only play
- **Best case** = crash terjadi, fees print BESAR
- **Worst case** = market rally, posisi dead weight

---

## 💡 FEE COMPARISON

### Skenario: 1 SOL volume terjadi di level -90% price

**Current (1000 bins):**
```
1 SOL / 1000 bins = 0.001 SOL per bin
Fee APR: RENDAH (tersebar)
```

**User Strategy (4 bins):**
```
1 SOL / 4 bins = 0.25 SOL per bin
Fee APR: MASSIVE 🔥 (concentrated)
```

**25x lebih besar FEE per bin jika crash terjadi!**

---

## 🎯 KONDISI SUKSES vs GAGAL

### Skenario 1: Harga Crash -90%
```
Current:  ✅ Tangkap semua downside, fee scattered across range
User:     ✅✅ PERFECT — capital semua di crash zone, MAX fees 🚀
```

### Skenario 2: Harga Pump +5%
```
Current:  ❌ ALL capital di atas price = MAJOR impermanent loss 😱
User:     ✅ ALL capital deep below price = safe, untouched ✨
```

### Skenario 3: Harga Sideways (flat)
```
Current:  ⚠️ Moderate fees, scattered across range
User:     ❌ Zero fees (volume tidak di -86% to -94% zone) 😤
```

### Skenario 4: Harga Small movements -5% to +5%
```
Current:  ⚠️ OK fees dari range activity
User:     ❌ Zero fees (range miss sideways movement) 😞
```

---

## 🔧 IMPLEMENTATION CHECKLIST (When Ready)

- [ ] Buat strategy baru: `"Deep Fishing"` atau `"Crash Buyer"`
- [ ] Set offsets: min=-86, max=-94
- [ ] Add Supertrend flip detection (compare previous vs current trend)
- [ ] Add 15m candle close wait (confirm di atas line)
- [ ] Add live price tracking before deploy
- [ ] Recalc offsets jika price moved (maintain -86% to -94% window)
- [ ] Add BinStep 80 support ke allowedBinSteps
- [ ] Validate bin width calculation (4 bins sangat sempit)
- [ ] Test dengan pool yang ada minimum liquidity di deep zone

---

## 📌 KEY INSIGHTS

1. **Strategi user INVERTED dari current Evil Panda**
   - Current: 0% sampai -94% (full spectrum)
   - User: -86% sampai -94% (deep zone only)

2. **Range SANGAT SEMPIT** (4-6 bins untuk 8% window)
   - Pros: Likuiditas concentrated, APR massive kalau crash
   - Cons: Capital idle kalau no crash, risky kalau range terlalu sempit

3. **Supertrend sebagai ENTRY TIMER** (bukan exit)
   - Bullish flip = signal untuk place deep bid
   - 15m close confirmation = reduce false triggers

4. **Live price tracking CRITICAL**
   - Harga bisa gerak selama deployment
   - Harus recalc untuk maintain intended window

5. **Ini TACTICAL trade**, bukan strategic wide range
   - Specific entry signal (ST flip)
   - Specific range (-86 to -94)
   - High risk/high reward
   - "Crash bet" bukan "passive LP"

---

**Status:** ✅ Analisis selesai, tunggu konfirmasi sebelum implementasi

