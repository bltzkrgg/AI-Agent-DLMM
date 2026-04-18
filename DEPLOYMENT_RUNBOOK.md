# DLMM LPer Deployment Runbook

Runbook ini untuk memastikan deploy aman saat modal sudah live.

## 1. Pre-Deploy (Wajib)
1. Jalankan `/preflight`
2. Pastikan status `READY` dan score minimal `85/100`
3. Untuk naik ke `full`, pastikan sample TAE cukup dan win rate memenuhi threshold config.
4. Jalankan `/health` dan pastikan:
   - `circuitBreaker = CLOSED`
   - `pendingReconcile = 0`
   - `manualReviewOpen = 0`
5. Pastikan stage bukan `shadow` jika target entry live.

## 2. Progressive Rollout
1. Set stage awal: `/stage canary 1`
2. Aktifkan entry otomatis: `/autoscreen on 15`
3. Monitoring 30-60 menit lewat:
   - `/status`
   - `/health`
   - `/providers`
4. Jika stabil, naik bertahap:
   - `/stage canary 2`
   - `/stage full`

## 3. Fast Rollback (Insiden)
1. Jalankan `/rollback`
2. Verifikasi mode aman:
   - `dryRun = true`
   - `autoScreeningEnabled = false`
   - `deploymentStage = shadow`
3. Triage akar masalah via `/health` + log.
4. Jika perlu freeze sementara tanpa ubah stage, pakai `/pause` lalu `/resume` setelah stabil.

## 4. Go/No-Go Rule
- **GO**: preflight READY, tidak ada blocker, error spike tidak ada.
- **NO-GO**: preflight BLOCKED atau circuit breaker tidak CLOSED.

## 5. Post-Deploy Checklist
1. Snapshot status awal setelah deploy (`/health`)
2. Pantau 6 jam pertama:
   - failed ops
   - manual_review growth
   - reconcile queue
3. Jika anomaly naik, turunkan ke canary/shadow sebelum lanjut.
