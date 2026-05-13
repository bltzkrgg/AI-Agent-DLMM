# LP Agent Follow-up Tasks for 5.4 Mini

Scope: implementation helper work only. Do not change core LP entry policy without a GPT-5.5 review.

## GPT-5.5 Locked Architecture

Queue flow is now `metadata-first`, `cache-first`, and `live-check-final`.

- Screening/watch/manual CA must carry entry metadata into queue.
- Queue first evaluates queued metadata: trend, M5, timing, readiness, breakout quality, TVL, and expiry.
- `BEARISH` metadata remains hard `DROP` / no queue.
- `NEUTRAL` or missing metadata remains `HOLD` / no deploy.
- Live snapshot is final confirmation, not the first gate for every queue tick.
- Live snapshot is cached per mint/pool for a short TTL.
- Momentum proxy / fallback snapshots are not trusted as live rejection data.
- Reliable live `BEARISH` still overrides queued metadata and drops.
- Reliable live `NEUTRAL` or non-positive M5 holds.

## Tasks for 5.4 Mini

1. Add focused tests around queue architecture.
   - LP bullish metadata can proceed when live snapshot is missing.
   - Momentum proxy live snapshot does not override bullish metadata.
   - Reliable live bearish still drops.
   - Reliable live neutral still holds.

2. Improve logging without changing behavior.
   - Show when queue used `queue` metadata vs `live` snapshot.
   - Show when live snapshot was ignored because it was unreliable fallback.
   - Keep Telegram copy short and operational.

3. Audit metadata propagation.
   - Manual CA must include `taTrend`, `priceChangeM5`, `entryTimingState`, snapshot price, and pool address.
   - Auto screening must include the same fields.
   - WATCH to QUEUE must preserve the same fields.

4. Add lightweight observability.
   - Count snapshot cache hit/miss in local logs.
   - Do not add external telemetry.
   - Do not increase network calls.

5. Prepare memory-layer implementation plan.
   - Pool decision memory.
   - Cooldown.
   - Priority scoring.
   - Outcome learning.
   - Keep this as a plan unless GPT-5.5 approves the core policy.

## Do Not Edit

- Exit policy / TP / SL config.
- Deploy transaction flow.
- Wallet, RPC, or Meteora SDK integration.
- GMGN safety thresholds.
- Core hard-gate policy: reliable bearish is always reject/drop.
