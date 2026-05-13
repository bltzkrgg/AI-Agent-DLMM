# LP Agent Follow-up Tasks for 5.4 Mini

Scope: helper work only. Do not change core entry or deploy policy without a GPT-5.5 review.

## Locked LP Entry Policy

Entry may proceed only when all are true:

- Pool/token safety passes.
- Supertrend 15m is `BULLISH`.
- M5 momentum is positive.
- Volume confirms the move.
- Entry state is a healthy LP fee-flow state such as `LP_LIVE`, `BREAKOUT`, or `ATH_BREAK`.

Hard outcomes:

- `BEARISH` trend: `DROP` / `REJECT`.
- `NEUTRAL` or `UNKNOWN` trend: `HOLD` / `DEFER`, no deploy.
- Queue is technical execution only: slot, duplicate, pool address, TVL, and final hard safety.

## Tasks for 5.4 Mini

1. Improve logs without changing behavior.
   - Show trend source: live snapshot vs queued meta.
   - Show M5 source: live snapshot vs queued meta.
   - Show decision: `DEPLOY`, `HOLD`, or `DROP`.

2. Add chart-scenario tests.
   - Bullish closed green reclaim should pass queue metadata.
   - Bearish trend should not enter WATCH or QUEUE.
   - Neutral trend should stay pending/hold and never deploy.
   - Missing live snapshot may use queued bullish metadata only when trend is not explicitly neutral/bearish.

3. Review Telegram status copy.
   - Keep messages short.
   - Make `WATCH`, `QUEUE`, `DEPLOY`, `HOLD`, and `DROP` reasons obvious.
   - Avoid trader-style wording when the state is LP fee-flow.

4. Audit duplicated radar/retest flow.
   - Confirm both pending retest paths treat `BEARISH_TREND` as drop.
   - Confirm neutral trend remains watchable but not deployable.

5. Produce a short report.
   - List changed files.
   - List tests added.
   - List remaining risks.

Do not edit:

- Exit policy / TP / SL config.
- Deploy transaction flow.
- Wallet, RPC, or Meteora SDK integration.
- GMGN safety thresholds.
