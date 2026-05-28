# LP Agent Follow-up Tasks for 5.4 Mini

Scope: implementation helper work only. Do not change core LP entry policy without a GPT-5.5 review.

## GPT-5.5 Locked Architecture

Queue flow is now `WATCH-trusted`, `metadata-first`, `cache-first`, and `bearish-veto-final`.

- Screening/watch/manual CA must carry entry metadata into queue.
- WATCH-ready candidates with `Entry=HIGH`, `Breakout=VALID/STRONG`, and `Timing=LP_LIVE` are trusted for queue admission.
- Queue first evaluates queued metadata: timing, readiness, breakout quality, WATCH trust, TVL, and expiry.
- `BEARISH` metadata remains hard `DROP` / no queue, even when WATCH-trusted.
- `NEUTRAL` or missing trend no longer blocks a trusted WATCH candidate.
- Live snapshot is final confirmation, not the first gate for every queue tick.
- Live snapshot is cached per mint/pool for a short TTL.
- Momentum proxy / fallback snapshots are not trusted as live rejection data.
- Reliable live `BEARISH` still overrides queued metadata and drops.
- Reliable live `NEUTRAL` or non-positive M5 does not override trusted WATCH metadata.

## Tasks for 5.4 Mini

1. Add focused tests around queue architecture.
   - LP bullish metadata can proceed when live snapshot is missing.
   - Momentum proxy live snapshot does not override bullish metadata.
   - Reliable live bearish still drops.
   - Trusted WATCH metadata deploys through neutral/missing live freshness.

2. Improve logging without changing behavior.
   - Show when queue used `queue` metadata vs `live` snapshot.
   - Show `TrustedWatch=YES/NO`, trend, M5, and ST distance whenever queue admission is denied.
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
   - Keep frozen anchor freshness logs visible so operators can tell when a queue deploy is using the frozen path versus a live fallback.

5. Prepare memory-layer implementation plan.
   - Pool decision memory.
   - Cooldown.
   - Priority scoring.
   - Outcome learning.
   - Keep this as a plan unless GPT-5.5 approves the core policy.
   - Canonical draft: `docs/LP_AGENT_MEMORY_LAYER_PLAN.md`.
   - GPT-5.5 handles the runtime memory core; 5.4 Mini handles tests, logs, and validation only.
   - Keep the entry-anchor freeze behavior documented as part of the queue hardening path, not as a policy rewrite.

## Do Not Edit

- Exit policy / TP / SL config.
- Deploy transaction flow.
- Wallet, RPC, or Meteora SDK integration.
- GMGN safety thresholds.
- Core hard-gate policy: reliable bearish is always reject/drop.
