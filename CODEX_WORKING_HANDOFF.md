# Codex Working Handoff

This file is the working source of truth for future Codex changes in this repo.
Before touching code, read this file first. If anything below conflicts with a new request,
prefer the explicit user request, then update this file after the change lands.

## How to use this file

- Read before editing.
- Update after any meaningful code change.
- Keep it short and concrete.
- Record only what matters for future changes.

## Current active scope

- Focus: surgical fixes only.
- Goal: avoid changing unrelated entry, exit, close, or config behavior.
- Preference: preserve existing behavior unless the user explicitly asks otherwise.

## Final decisions

- New WATCH promotions must pause when deploy slots are saturated.
- Queue hold notifications for slot saturation must stay silent.
- OOR Telegram display should stay compact and cadence-driven, not verbose.
- Supertrend 15m bearish must remain a hard stop for entry unless the user explicitly changes that policy.
- Pool impact exit logic must remain a risk guard, not a generic panic rewrite.
- TA profit exits must respect `takeProfitMinNetPnlPct`; TA defensive exits can still close for risk control.
- DLMM deploy range must stay active-bin-based per Meteora, but anchor provenance and range-adjust reasons should be observable in logs/state.
- Deploy balance checks must fail before any chain-touching deploy step when effective SOL budget is insufficient, including position setup cost and overlapping in-flight deploy reservations.
- Deploy preflight should not use a hardcoded fee buffer; keep checks aligned to actual Meteora setup/rent costs instead.

## Recently completed changes

- Slot-saturated WATCH promotion is paused for new candidates.
- Slot saturation checks now use the normalized deploy slot helper shape (`maxPositions` / `active` / `reserved` / `available`) so WATCH/radar suppression stays aligned with the actual slot guard.
- Slot-saturated queue hold notifications are suppressed.
- OOR Telegram display was simplified to a compact status message.
- Strategy parser now uses global `dlmmLiquidityShape` as the default source-of-truth for `strategyType` (spot=0, bidask=2), with explicit strategy overrides still allowed.
- Deploy preflight now reserves effective SOL budget per in-flight deploy and includes Meteora position setup cost in fail-before-touch wallet checks.
- Removed hardcoded deploy fee buffer from `evilPanda` preflight after confirming Meteora docs do not require it.
- Take-profit exit now uses a dedicated full-swap policy so TP behavior is consistent; manual `claimFees()` remains claim-only and non-TP exits keep their existing swap policy.
- Manual close now reuses the latest tracked position snapshot when available to record Telegram PnL, ledger cashflow, and pool-learning outcome; unresolved cases still stay pending/manual-reconcile instead of inventing on-chain numbers.
- Manual close now preserves the last valid fee snapshot when a position disappears on-chain and restores that snapshot after restart, so Telegram, ledger, and pool-learning keep fee PnL instead of being overwritten by the zero-value missing-position fallback.
- Final Supertrend deploy allow path now requires short-lived canonical 15m confirmation metadata; reliable live bullish snapshots alone no longer auto-pass final deploy.
- Defensive bearish exit hold window now trusts only canonical bullish entry stamps; non-canonical entry trend metadata no longer delays valid bearish risk exits.
- Operator-facing exit labels now use a cleaner `Defensive Exit Trigger` wording for TA scenario C while normal and trailing TP labels stay explicit.

## Behavior contracts to preserve

- Entry logic must keep its existing hard gates unless the user asks for a change.
- Exit logic must keep its current thresholds and watchers unless explicitly scoped.
- Important notifications for active positions, exits, and fatal errors must remain enabled.
- Dedupe behavior for repeat notifications must remain active.

## File boundaries

- `src/agents/hunterAlpha.js`
- `src/utils/pendingDeployQueue.js`
- `src/risk/poolImpactGuard.js`
- `src/config.js`
- `tests/position-workflow.test.js`

Only edit other files when the change explicitly requires it.

## Known sensitive areas

- Entry snapshot freshness and Supertrend 15m gating.
- WATCH promotion versus deploy queue admission.
- OOR notification cadence.
- Pool impact exit behavior.
- Any new config keys or changes to config meaning.
- Deploy wallet balance checks versus chain-touching quote-only init flow.
- Hardcoded deploy fee buffer versus Meteora-required costs.
- Take-profit swap consistency versus manual claim-only fee collection.

## Locked areas

- `src/agents/healerAlpha.js`
- `src/solana/meteora.js`
- `src/strategies/strategyManager.js`
- `src/market/oracle.js`
- `src/market/meridianVeto.js`

Do not edit these unless the user explicitly scopes the change there.

## Verification pattern

- Run the narrowest relevant tests first.
- If the behavior change is user-visible, verify the exact message/output text.
- If the change touches gating, verify that blocked paths still block and allowed paths still pass.

## Current reminders

- Do not assume UI chart state and agent snapshot state are identical.
- Do not broaden a fix into a redesign.
- If a future request touches multiple systems, read this file first and update only the minimal set of files.

## Change log

- 2026-05-31: Added repo-wide working handoff.
- 2026-05-31: Simplified OOR Telegram display.
- 2026-05-31: Paused WATCH promotion when deploy slots are saturated.
- 2026-05-31: Suppressed slot-saturation queue hold notifications.
- 2026-05-31: Persisted final Supertrend 15m decision stamps in deploy queue path to keep bearish veto and bullish freshness state consistent across retries.
- 2026-05-31: Completed 5.3 wiring hardening for shape consistency: strategy parser now defaults to config `dlmmLiquidityShape` so `/setconfig strategy.liquidityShape` flows consistently into strategyType defaults.
- 2026-06-01: Completed 5.3 Supertrend hard-stop hardening: final deploy ST gate now treats explicit live BEARISH as VETO even when snapshot reliability is degraded, preventing stale bullish cache override.
- 2026-06-01: Completed 5.4 mini Supertrend wiring hardening: queue final ST gate now reuses latest queue live snapshot/current price for final deploy check, avoiding split-decision between freshness evaluation and final ST gate.
- 2026-06-01: Hardened LP queue admission fail-closed for trusted watch path: non-bullish trusted metadata now requires a fresh bullish final ST stamp, and unreliable live snapshots with non-bullish trend now hold instead of progressing.
- 2026-06-01: Completed close-once exit hardening in evilPanda: removed normal close cleanup retry loop so exit can close once, then continue fee swap policy without extra cleanup TXs.
- 2026-06-01: Extended 5.4 mini coverage with a trusted WATCH LP test that confirms non-bullish trusted entries still depend on a fresh bullish final ST cache.
- 2026-06-01: Scoped `src/solana/meteora.js` close flow to one-shot verification only; removed default cleanup retry chain so close no longer replays removeLiquidity/closePosition helpers as a default path.
- 2026-06-01: Removed legacy exit fallback TX paths and quote-only partial cleanup TX emitters from `src/sniper/evilPanda.js`; recovery/exit close flows now stop after one-shot verification instead of sending additional close TXs.
- 2026-06-01: Tightened `src/solana/meteora.js` empty-close edge case to fail closed instead of falling back to `closePositionIfEmpty`, keeping close behavior strictly one-shot.
- 2026-06-01: Removed remaining exit CU retry fallback in `src/sniper/evilPanda.js` and removed claim fee fallback to `claimAllRewardsByPosition`; exit/claim paths now stay one-shot and fail fast per Meteora docs alignment.
- 2026-06-01: Hardened deploy slot admission race in `src/utils/deploySlotGuard.js` by adding in-process reservation lock and fresh reservation re-check before write, reducing simultaneous double-reservation risk across hunter/queue callers.
- 2026-06-02: Wired active monitor exit policy so take profit is triggered by TA (`evaluateExitSignal`) while stop loss and max hold remain hard config guards (`stopLossPct`, `maxHoldHours`); trailing config no longer emits `TAKE_PROFIT` from `monitorPnL`.
- 2026-06-03: Removed remaining operator-facing TP wording that still said "Trail"; status, briefing, strategy report, and deploy toast now describe TP as TA exit so UI text matches the TA-driven exit policy.
- 2026-06-03: Completed 5.5 Supertrend fallback hardening in `pendingDeployQueue`: final ST gate now HOLDS when a live snapshot exists but is not reliable bullish, and LP queue summary no longer uses fresh bullish cache to pass unknown/unreliable live trend.
- 2026-06-03: Added TA profit guard wiring: `takeProfitMinNetPnlPct` is configurable via `/setconfig`, TA profit scenarios A/B hold until net exposure PnL meets the threshold, and operator-facing TP labels now show the required net PnL.
- 2026-06-04: Completed 5.5 DLMM anchor provenance wiring in `evilPanda`: deploy logs and position lifecycle now record whether range came from frozen intent or live fallback, plus drift/range-adjust reasons, without adding deploy gates or extra TXs.
- 2026-06-06: Hardened `evilPanda` deploy wallet preflight to account for Meteora position setup cost and concurrent in-flight deploy reservations, so insufficient SOL fails before quote-only position init or other chain-touching deploy steps.
- 2026-06-06: Removed the hardcoded `DEPLOY_PREFLIGHT_FEE_BUFFER_SOL` from deploy preflight after confirming it was a local safety margin, not a Meteora requirement; deploy checks now use only actual deploy, reserve, and setup costs.
- 2026-06-09: Added a dedicated take-profit full-swap policy in `evilPanda` so TP exit consistently swaps fee/residual tokenX to SOL, while `claimFees()` stays claim-only and non-TP exit policy remains unchanged.
- 2026-06-09: Hardened final Supertrend live snapshot handling so conflicting `quality.taTrend` vs `ta.supertrend.trend` now HOLD for canonical confirmation instead of making a deploy decision on mixed live trend data.
- 2026-06-09: Split operator-facing TP messaging so TA scenario C is shown as `DEFENSIVE EXIT` / `Supertrend Bearish Exit`, while real profit exits keep `TAKE PROFIT` and trailing keeps `Trailing Profit Trigger`.
- 2026-06-09: Hardened slot-saturated WATCH suppression to use normalized deploy-slot usage fields so new radar candidates stay quiet whenever deploy capacity is full.
- 2026-06-09: Manual close accounting now records snapshot-based PnL when the bot has a fresh tracked position snapshot, includes that PnL in Telegram and briefing stats, and only leaves manual close pending when no trustworthy snapshot exists.
- 2026-06-10: Suppressed deploy queue hold/drop noise for new candidates while deploy slots are saturated; queue watcher now stays quiet for slot-full candidates and only resumes normal hold/drop messages when capacity is available again.
- 2026-06-10: Manual close snapshot accounting is now fee-only: reconciled manual-close ledger/briefing/learning use fee PnL as canonical realized PnL, while liquidity withdrawal value remains metadata and manual-close Telegram no longer shows misleading exposure PnL.
- 2026-06-10: Tightened manual-close snapshot trust so fee-only reconciliation only happens when a real fee snapshot exists; `currentValueSol` alone no longer qualifies, and missing fee snapshot now stays pending reconcile instead of showing misleading `0.000000 SOL`.
- 2026-06-10: Manual-close pending cases no longer write harvest/pool outcome records; only reconciled manual-close snapshots are allowed to feed harvest logging and pool-memory outcomes.
- 2026-06-10: Defensive Supertrend exit in `evilPanda` now requires a short position-age plus bearish confirmation window before triggering scenario `C`, reducing immediate deploy-then-close churn from unsynced entry/exit trend snapshots without changing deploy gates or other exit thresholds.
- 2026-06-10: Final deploy Supertrend stamp is now passed from queue/hunter into `evilPanda`, persisted on the active position, restored after restart, and used to hold early defensive bearish exits until the bullish entry confirmation is no longer fresh.
- 2026-06-11: Hardened final deploy Supertrend gate so reliable live bullish snapshots must be confirmed by canonical 15m Meridian before `ALLOW`; short-lived canonical source metadata is now cached/stamped and reused on quick retries to keep deploy timing tight while preventing live-bullish vs Meridian-bearish split decisions.
- 2026-06-11: Tightened `evilPanda` defensive exit synchronization so the early bearish hold window only trusts canonical bullish entry stamps (`fresh_fetch` / `cache:fresh_fetch`), preventing weak/non-canonical entry trend metadata from blocking valid bearish exits while preserving the anti-churn hold for real canonical entry confirmations.
- 2026-06-11: Cleaned operator-facing exit wording in `hunterAlpha` so scenario `C` now reads `Defensive Exit Trigger` while normal and trailing profit exits remain `Take Profit Trigger` and `Trailing Profit Trigger`.
- 2026-06-11: Hardened manual-close fee snapshot persistence so `hunterAlpha` preserves the last valid fee snapshot when `MANUAL_CLOSED` returns zeroed status, and `evilPanda` restores those fee fields from persisted active-position state after restart to keep manual-close Telegram, ledger, and pool-pattern learning accurate.
