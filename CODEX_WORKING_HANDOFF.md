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
- Defensive TA exit scenario C must stay blocked while the position is still in range, and only becomes eligible on confirmed out-of-range-low conditions; in-range or out-of-range-high positions should keep waiting for bounce/TP or other normal exits.
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
- TP auto-swap now waits briefly for post-close token settlement and surfaces explicit swap skip/error reasons, so a failed or skipped SOL sweep is distinguishable from a true zero-delta close.
- TP-family exits now force full auto-swap by raw exit reason prefix (`TAKE_PROFIT*`), so trailing-profit exits do not fall back to conservative non-TP swap policy just because normalization maps them to `TRAILING_STOP`.
- Manual close now reuses the latest tracked position snapshot when available to record Telegram PnL, ledger cashflow, and pool-learning outcome; unresolved cases still stay pending/manual-reconcile instead of inventing on-chain numbers.
- Manual close now preserves the last valid fee snapshot when a position disappears on-chain and restores that snapshot after restart, so Telegram, ledger, and pool-learning keep fee PnL instead of being overwritten by the zero-value missing-position fallback.
- Final Supertrend deploy allow path now requires short-lived canonical 15m confirmation metadata; reliable live bullish snapshots alone no longer auto-pass final deploy.
- Final Supertrend deploy allow path must also keep live price cleanly above the live Supertrend 15m line when that line is available, so stale bullish labels cannot pass if price has already slipped back under the line.
- Defensive bearish exit hold window now trusts only canonical bullish entry stamps; non-canonical entry trend metadata no longer delays valid bearish risk exits.
- Operator-facing exit labels now use a cleaner `Defensive Exit Trigger` wording for TA scenario C while normal and trailing TP labels stay explicit.
- Bin-step candidate selection in `hunterAlpha` must treat `binStepPriority` as an allowed-candidate list, then choose the candidate pool with the strongest Meteora fee generation snapshot; it must not reintroduce fixed numeric bin-step ranking or add extra fetch latency on the hot path.
- GMGN-inspired signal layer now acts as a scoring-only overlay inside pool-pattern/watch prioritization: it shifts candidate score using existing GMGN metrics and fingerprints those metrics for learning, but does not introduce a new hard gate or config key.
- Operator-facing scanner text now uses `Signal` + `LP Score` wording instead of raw GMGN label noise, so report output stays LP-centric while still exposing the signal overlay.
- Scanner report `Fee/TVL` must use Meteora 24h ratio as the source of truth; missing ratio now renders `N/A` instead of a fake `0.0%`.
- Entry/watch/queue/deploy must preserve one canonical entry snapshot payload so active-position monitor/exit can read the same entry context that was used at deploy time.
- Queue, monitor, defensive exit, and manual-close accounting must prefer `entryCanonicalSnapshot` before scattered legacy entry fields.
- On successful deploy, `evilPanda` must upgrade `entryCanonicalSnapshot` with the final runtime entry truth actually used on-chain (`entryActiveBin`, `entryPrice`, final ST stamp, anchor/range-adjust metadata) so monitor/exit do not keep reading stale queue-era intent fields.

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
- Post-close TP sweep timing and swap-failure observability.
- Scanner report LP metrics consistency, especially Meteora `fee_tvl_ratio['24h']` versus derived/fallback values.
- Entry metadata drift across WATCH, queue, direct deploy, and restored active positions.
- Bin-step candidate selection versus fixed bin-step ranking.
- Mixed canonical-vs-legacy entry field reads inside queue, monitor, and manual-close consumers.

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
- 2026-06-14: Hardened defensive Supertrend exit in `evilPanda` so scenario `C` is blocked while the position is still in range and only allowed on confirmed out-of-range-low conditions; out-of-range-high no longer counts as a defensive-exit trigger.
- 2026-06-10: Final deploy Supertrend stamp is now passed from queue/hunter into `evilPanda`, persisted on the active position, restored after restart, and used to hold early defensive bearish exits until the bullish entry confirmation is no longer fresh.
- 2026-06-11: Hardened final deploy Supertrend gate so reliable live bullish snapshots must be confirmed by canonical 15m Meridian before `ALLOW`; short-lived canonical source metadata is now cached/stamped and reused on quick retries to keep deploy timing tight while preventing live-bullish vs Meridian-bearish split decisions.
- 2026-06-14: Completed 5.4 final deploy hardening in `pendingDeployQueue`: cached/canonical bullish confirmation no longer auto-allows if the latest live snapshot price has already slipped back to or below the live Supertrend 15m line; those gray-zone snapshots now HOLD and wait for a clean reclaim instead of deploying into dump-prone structure.
- 2026-06-11: Tightened `evilPanda` defensive exit synchronization so the early bearish hold window only trusts canonical bullish entry stamps (`fresh_fetch` / `cache:fresh_fetch`), preventing weak/non-canonical entry trend metadata from blocking valid bearish exits while preserving the anti-churn hold for real canonical entry confirmations.
- 2026-06-11: Cleaned operator-facing exit wording in `hunterAlpha` so scenario `C` now reads `Defensive Exit Trigger` while normal and trailing profit exits remain `Take Profit Trigger` and `Trailing Profit Trigger`.
- 2026-06-11: Hardened manual-close fee snapshot persistence so `hunterAlpha` preserves the last valid fee snapshot when `MANUAL_CLOSED` returns zeroed status, and `evilPanda` restores those fee fields from persisted active-position state after restart to keep manual-close Telegram, ledger, and pool-pattern learning accurate.
- 2026-06-11: Standardized scanner Telegram output to the compact `SCANNER REPORT` layout with `Top 5`, slot state, action, and next scan cadence while keeping slot-saturated summary behavior intact.
- 2026-06-11: Hardened TP auto-swap in `evilPanda` by waiting for post-close token balance settlement before sweep decisions and propagating structured Jupiter execution errors into explicit fee/residual swap skip logs, without changing claim-only or non-TP policy semantics.
- 2026-06-12: Hardened TP-family auto-swap routing in `evilPanda` so `TAKE_PROFIT_TRAILING` and other `TAKE_PROFIT*` exit reasons now force the same full-swap policy as plain take profit, while global exit-reason normalization for analytics remains unchanged.
- 2026-06-12: Added GMGN-inspired scoring overlay to `poolPatternLearning` and watch priority scoring in `hunterAlpha`; existing GMGN metrics now influence candidate ranking and learning fingerprints without changing stage pass/fail gates.
- 2026-06-12: Refined GMGN signal overlay report text to `Signal` / `LP Score` wording in scanner output so the UI stays concise and operator-friendly without changing scoring semantics.
- 2026-06-12: Hardened scanner report Fee/TVL rendering so it now prefers Meteora canonical 24h ratio, falls back to `fees24h / tvl` only when needed, and shows `N/A` instead of fake `0.0%` when ratio data is absent.
- 2026-06-15: Completed 5.4 canonical entry snapshot wiring: `hunterAlpha` now builds a single `entryCanonicalSnapshot` payload for manual queue, WATCH promotion, and direct deploy; `pendingDeployQueue` forwards that payload into deploy calls; `evilPanda` persists/restores it on active positions so later monitor/exit logic can read the same entry context instead of reconstructing mixed snapshots.
- 2026-06-15: Unified exit display metadata for close notifications: `hunterAlpha` now reads shared exit label metadata so TAKE_PROFIT, trailing, defensive, stop-loss, and manual close messages use a consistent title/reason pair without changing normalized analytics reasons.
- 2026-06-15: Completed 5.4 exit notification orchestration hardening: `hunterAlpha` now routes TP, stop-loss, max-hold, pool-impact, and close-success Telegram output through shared exit notification helpers, while `evilPanda` manual-close Telegram also reuses shared exit display metadata so operator-facing exit wording stays aligned across the lifecycle without changing exit policy.
- 2026-06-15: Completed 5.4 bin-step selector hardening in `hunterAlpha`: per-token pool selection and manual CA resolution now treat `binStepPriority` as the candidate bin-step list and choose the candidate with the strongest Meteora fee generation snapshot (`fees24h`, `fee_tvl_ratio`, `volume24h`, `tvl`) instead of fixed numeric bin-step ranking, without adding new fetches or touching entry/exit gates.
- 2026-06-15: Completed 5.4 canonical snapshot consumer hardening: `pendingDeployQueue` now resolves frozen intent/drift checks from `entryCanonicalSnapshot` first, and `evilPanda` monitor, defensive-exit confirmation, and manual-close accounting now read entry context through one canonical snapshot reader before falling back to legacy fields.
- 2026-06-15: Completed 5.4 runtime canonical snapshot hardening: `evilPanda` now rewrites the persisted `entryCanonicalSnapshot` at deploy/open time with the final runtime truth actually used for the position, including active bin, entry price, final Supertrend stamp, and anchor/range-adjust metadata, so later queue/monitor/exit consumers stop reading stale pre-deploy intent context.
- 2026-06-15: Hardened OOR monitor recovery in `hunterAlpha`: OOR recovered/hold decisions now trust canonical active-bin-vs-range truth when available, so stale `status.inRange` flags no longer replay false OOR recovery behavior for positions that are already back inside range.
- 2026-06-15: Renamed scanner report header to `AI-Agent Scanner Result` while keeping the compact top-pools/rejected layout intact.
- 2026-06-15: Unified TP operator-facing wording with a shared helper so activation/status/briefing and exit-close banners all render the same TP threshold label, while TP exit labels keep using the shared reason metadata.
- 2026-06-15: Normalized internal TP/trailing monitor logs in `evilPanda` to use consistent TP phrasing for gating, fallback, and hold messages without changing exit behavior.
- 2026-06-15: Hardened TP close banner token fallback so close notifications prefer tracked symbol/metadata before falling back to position pubkey, preventing `Token` from mirroring the position id when registry label is unavailable.
- 2026-06-15: Compact TP close banners now render the requested minimal format (`Posisi Di Tutup`, `Token :`, `Reason`, `Total Exposure PnL`, `Balance`) for TP families only, while non-TP exit families keep the richer close layout.
