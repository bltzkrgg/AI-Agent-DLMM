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

## Recently completed changes

- Slot-saturated WATCH promotion is paused for new candidates.
- Slot-saturated queue hold notifications are suppressed.
- OOR Telegram display was simplified to a compact status message.
- Strategy parser now uses global `dlmmLiquidityShape` as the default source-of-truth for `strategyType` (spot=0, bidask=2), with explicit strategy overrides still allowed.

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
