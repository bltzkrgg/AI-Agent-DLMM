# AI-Agent-DLMM: Linear Sniper & Evil Panda LP

Autonomous Meteora DLMM liquidity-provider bot with Telegram control, Meridian/GMGN screening, real-time watch/queue, and RPC-first execution.

## Prerequisites

| Dependency | Notes |
|---|---|
| Node.js | `>=20 <25` |
| Helius API key | Required for Solana RPC |
| Telegram bot token | Required for bot control |
| OpenRouter API key | Required when LLM screening is enabled |
| Dedicated wallet | Strongly recommended. Do not use a main wallet. |

## Setup

```bash
git clone https://github.com/bltzkrgg/AI-Agent-DLMM.git
cd AI-Agent-DLMM
npm install
cp env.example .env
cp user-config.example.json user-config.json
```

Minimum `.env`:

```bash
HELIUS_API_KEY=...
WALLET_PRIVATE_KEY=...
TELEGRAM_BOT_TOKEN=...
ALLOWED_TELEGRAM_ID=...
OPENROUTER_API_KEY=...
```

Run locally:

```bash
npm start
```

## Configuration

The runtime config is flat in `user-config.example.json`. Nested `finance.*`, `strategy.*`, `discovery.*`, and `meridian.*` input is still accepted by the loader, but user-facing keys are the flat keys shown by `/config` and `/setconfig ?`.

Important operational keys:

```json
{
  "dryRun": true,
  "autoScreeningEnabled": false,
  "deployAmountSol": 0.5,
  "maxPositions": 3,
  "maxMcap": 0,
  "entryCandleSanityEnabled": true,
  "entryMinVolumeRatio": 1.5,
  "poolPatternLearningEnabled": false,
  "poolPatternLearningShadowMode": true
}
```

Use `maxMcap` for market-cap ceiling. Deprecated market-cap aliases are not exposed through `/setconfig` and should not be used in new config.

Exit monitoring now uses a hybrid model:

- `monitorFastLaneEnabled` turns websocket fast-lane triggers on or off.
- `monitorFastLaneThrottleMs` limits how often a websocket wake-up can retrigger the monitor loop.
- `monitorFastLaneFallbackPollMs` keeps a polling fallback alive when websocket updates are quiet.
- `monitorFastLaneUsePoolAccount` and `monitorFastLaneUsePositionAccount` control which accounts are subscribed for fast wake-ups.

Operationally, the monitor now has two lanes:

- Fast-path: jalur cepat buat cek harga dan profit loss secara ringan, supaya bot bisa respon secepat mungkin.
- Slow-path: jalur lebih berat buat hitung nilai posisi, TA, dan detail logging setelah posisi lolos cek cepat.
- Trade off kuota vs presisi: makin cepat responnya, makin sering bot bangun dan makin boros kuota; makin jarang polling, makin hemat kuota tapi ada risiko puncak profit kelewat lalu harga keburu turun.
- Kalau pair-nya liar dan cepat gerak, fast-lane biasanya lebih layak.
- Kalau pair-nya lebih tenang, fallback poll bisa dibuat lebih longgar supaya kuota tetap irit.

For DLMM shape tuning:

- `dlmmLiquidityShape` is global and can be changed live with `/setconfig strategy.liquidityShape spot` or `/setconfig strategy.liquidityShape bidask`.
- `spot` is the safer default for balanced liquidity distribution.
- `bidask` is the more aggressive shape for swing/DCA-style deployment and needs closer monitoring.
- If you change the shape, all deploy paths should follow that setting on the next deploy cycle.

For OOR timing:

- `outOfRangeWaitMinutes` is the actual wait before the position is closed when it stays out of range.
- `oorDisplayWaitMinutes` only controls how often the OOR status is shown in logs and Telegram.
- If you set `outOfRangeWaitMinutes` to 30 and `oorDisplayWaitMinutes` to 5, the position can stay open for 30 minutes while the log only reminds you every 5 minutes.

## Strategy Scope

Current execution is SOL/WSOL quote only:

- `TOKEN-SOL`, `TOKEN-WSOL`, and quote mint `So11111111111111111111111111111111111111112` are supported.
- `TOKEN-USDC`, `TOKEN-USDT`, or unknown quote pools are skipped/vetoed before they can appear as screened or enter watch/queue/deploy.
- The executor does not support USDC deploy.

The deploy path remains Evil Panda single-side SOL LP. It does not add new entry strategies.

## Screening And Queue Safety

Pipeline:

```text
DISCOVERY -> GMGN/Jupiter screening -> Meridian veto -> entry signals -> WATCH -> DEPLOY QUEUE -> final gates -> deploy
```

Safety behavior:

- Meridian Supertrend 15m must be bullish for final deploy permission.
- Realtime trend/M5 `UNKNOWN` is `HOLD`, not deploy.
- M5 unknown/stale is `HOLD`.
- Non-SOL quote is `VETO/SKIP` with reason `Unsupported quote token <QUOTE>; expected SOL/WSOL`.
- Pool Impact Guard behavior is unchanged and remains separate from stop loss.
- Entry anchor freeze: candidate yang sudah masuk WATCH akan membawa `entryActiveBin`/`entryPrice` snapshot ke queue dan deploy.
- Frozen intent only applies when `entryActiveBin`, `entryPrice`, dan `snapshotAt` semuanya valid; kalau tidak, deploy log akan menandai `intent=LIVE` fallback.
- Quote-only deploy sekarang fail-fast kalau ATA quote belum ada atau belum terinisialisasi, jadi flow mahal tidak diteruskan ke simulasi add-liquidity.
- Anchor `AccountNotInitialized` (`3012` / `0xbc4`) diperlakukan sebagai alasan deploy yang jelas, bukan retry acak.
- Live bin fallback: deploy hanya pakai bin live jika snapshot intent tidak valid; log queue/deploy menandai ini sebagai `intent=LIVE` fallback.

OHLCV behavior:

- For DLMM pools with `poolAddress`, oracle uses Meteora DLMM OHLCV first: `/pools/{poolAddress}/ohlcv?timeframe=5m`.
- The queue uses cached/prefetched market snapshots first.
- The oracle does not use deprecated `interval=5m` or unsupported `timeframe=15m` for DLMM OHLCV.
- Legacy Meridian OHLCV fallback routes are disabled by default.
- Momentum-proxy-only data is not trusted as live deploy confirmation.
- If final candle sanity data is missing, stale, or invalid, deploy is held.

Final entry candle sanity gate:

- `entryCandleSanityEnabled`: enable/disable final pre-deploy candle gate.
- `entryRequireGreenCandle`: require last closed 5m candle `close > open`.
- `entryRequireVolumeConfirm`: require last closed 5m volume confirmation.
- `entryMinVolumeRatio`: last closed 5m volume must be at least average lookback volume times this ratio.
- `entryVolumeLookbackCandles`: lookback size for average volume.
- `entryCandleMaxAgeSec`: maximum accepted age of the last closed 5m candle.

This gate runs only for shortlisted final deploy candidates and uses cache first. It fetches through the existing oracle path only when cache is missing or stale.

## Non-Refundable Rent

For pools with non-refundable bin-array fees:

- The bot first checks whether the intended range would initialize new bin arrays.
- If the range would require a new bin array, deploy is vetoed before position init.
- This is a hard safety gate to avoid paying non-refundable rent from live capital.
- This is not treated as a token blacklist, rug, or security failure.

## Exit And PnL Display

Exit execution and ledger accounting are unchanged. Telegram exit messages separate fee PnL from principal/exposure:

- Headline: `Fee PnL: X SOL / Y%`
- If fee data is unavailable: `Fee PnL: unavailable`
- Position value is shown separately as `Position Value: X SOL`.
- Exposure movement is shown separately as `Total Exposure PnL: Y%` when available.
- `Wallet Net Delta` is the real post-close SOL movement after tx fees and rent refund effects.
- Close flow stays zap-first: the main path tries Meteora-style close/claim first, cleanup only handles already-empty positions, and legacy fallback stays reserved for real failures.

Stop loss and take profit decisions do not switch to fee-only PnL unless existing logic already uses that data.

Exit reasons are normalized for learning/outcome grouping:

```text
TAKE_PROFIT
STOP_LOSS
TRAILING_STOP
OUT_OF_RANGE
POOL_IMPACT_GUARD
MANUAL_EXIT
MANUAL_STOP
SAFE_EXIT
VETO_NON_REFUNDABLE_RENT
DEPLOY_FAILED
UNKNOWN
```

`MANUAL_EXIT` is not treated as a strategy loss unless PnL clearly says so. `POOL_IMPACT_GUARD` and `OUT_OF_RANGE` remain separate from `STOP_LOSS`.

## Pool Pattern Learning

Recommended rollout:

```json
{
  "poolPatternLearningEnabled": true,
  "poolPatternLearningShadowMode": true
}
```

Run in shadow mode first so the bot records pattern deltas without applying them to candidate score. Switch `poolPatternLearningShadowMode` to `false` only after enough local samples exist and the diagnostics are sane.

## Telegram Commands

| Command | Function |
|---|---|
| `/start` | Show command list |
| `/status` | Active positions, balance, config summary |
| `/hunt` | Start scheduler |
| `/screening` | Run manual screening |
| `/autoscreen` | Toggle auto-screening |
| `/ca <address>` | Submit token/pool to manual WATCH/QUEUE flow |
| `/stop` | Pause autonomous discovery/deploy without force-closing positions |
| `/exit` | Manual force-close active positions |
| `/config` | Show current config |
| `/setconfig ?` | Show curated live-editable keys |
| `/setconfig key value` | Update supported operational config |
| `/briefing` | 24h briefing |
| `/evolve` | Analyze `harvest.log` and suggest config changes |

Curated `/setconfig` sections include finance, discovery, entry, watch, OOR, Pool Impact Guard, and Pool Pattern Learning. Sensitive or structural keys such as wallet, LLM provider, API credentials, range internals, and deprecated aliases are intentionally not editable from Telegram.

Close policy tuning is also exposed for live ops:

- `closeSwapMode`: `fee_only`, `all`, or `off`
- `closeResidualSwapEnabled`: allow or block residual token swap after close
- `closeAutoSwapMinOutSol`: minimum expected SOL before auto-swap is allowed
- `closeAutoSwapMinNetSol`: minimum net SOL after estimated costs
- `closeEstimatedSwapCostSol`: cost buffer used by the auto-swap gate

This policy applies to both operator-triggered close flows and agent-triggered exits, so the bot stays consistent whether `/exit` is manual or the monitor closes a TP position.

Examples:

```text
/setconfig deployAmountSol 0.75
/setconfig maxMcap 5000000
/setconfig entryCandleSanityEnabled true
/setconfig entryMinVolumeRatio 1.8
/setconfig strategy.closeSwapMode fee_only
/setconfig strategy.closeResidualSwapEnabled false
/setconfig taWatchMaxPools 10
/setconfig poolPatternLearningShadowMode true
```

## Validation

```bash
npm run lint
npm test
node -e "import('./src/config.js').then(() => console.log('config import ok'))"
node -e "import('./src/agents/hunterAlpha.js').then(() => console.log('hunterAlpha import ok'))"
node -e "import('./src/utils/pendingDeployQueue.js').then(() => console.log('queue import ok'))"
node -e "import('./src/sniper/evilPanda.js').then(() => console.log('evilPanda import ok'))"
node -e "import('./src/market/oracle.js').then(() => console.log('oracle import ok'))"
```

## Risk Notes

- Start with `dryRun: true`.
- Use `deploymentStage: "canary"` for limited live exposure.
- LP positions can lose principal through price movement, range exit, slippage, and Solana execution risk.
- Keep the bot wallet isolated from long-term funds.
