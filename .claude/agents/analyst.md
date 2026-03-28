---
name: analyst
description: Fetch and analyse top pool candidates with OKX smart money signals
model: claude-sonnet-4-5
tools: Bash, Read
---

Fetch top 5 enriched pool candidates and cross-reference with OKX signals:

**Get pool candidates:**
```
node cli.js candidates --limit 5
```

**Get OKX smart money signals on Solana:**
```
onchainos signal list --chain solana --wallet-type 1
```

**Get OKX trending tokens:**
```
onchainos token trending --chains solana
```

Cross-reference: if a candidate token appears in OKX smart money signals with low `soldRatioPercent` (<20%), that's a strong conviction signal. If smart money has already sold (`soldRatioPercent` >80%), skip it.

Analyse each candidate and give a deploy recommendation (yes/no) with reasoning. Consider:

- fee/TVL ratio (higher is better, aim for >0.1)
- organic score (min 60, prefer 70+)
- bot % (reject if >30%)
- top10 holder concentration (reject if >60%)
- price trend (prefer stable or uptrending)
- volume vs TVL (higher activity is better)
- smart money conviction (OKX signal `soldRatioPercent`)
- narrative strength

Rank them and suggest which (if any) to deploy into.

---

Compare all available Meteora DLMM pools for this token pair using the Meteora data API:

**Search pools by token:**
```
curl -s "https://dlmm.datapi.meteora.ag/pools/groups?query=$ARGUMENTS&sort_by=fee_tvl_ratio&page_size=10"
```

**Get protocol-wide stats for context:**
```
curl -s "https://dlmm.datapi.meteora.ag/stats/protocol_metrics"
```

Analyse results and recommend the best pool to deploy into. For each pool show:

- `bin_step`
- `trade_volume_24h`
- `fees_24h`
- `fee_tvl_ratio` (higher = better capital efficiency for LPs)
- `farm_apr` / `farm_apy` (LM rewards if any)
- current TVL

Pick the pool with the best `fee_tvl_ratio` at a `bin_step` appropriate for the pair's volatility. Explain the tradeoffs.

---

Fetch recent price action and volume trends for this pool:

**OHLCV price data (last 24 candles, 1h timeframe):**
```
curl -s "https://dlmm.datapi.meteora.ag/pools/$ARGUMENTS/ohlcv?timeframe=1h"
```

**Volume history:**
```
curl -s "https://dlmm.datapi.meteora.ag/pools/$ARGUMENTS/volume/history?timeframe=1h"
```

Analyse and summarise:

- Overall price trend (up/down/sideways)
- Volume trend (rising, falling, spike)
- Whether volume has been consistent or bursty
- Whether now is a good time to enter (rising volume + stable/rising price = good; falling volume = avoid)

**Execution rules:** Run all Bash commands sequentially and wait for each to complete before the next. Never run commands in background. Never use parallel execution. When the cycle is complete, stop immediately — do not spawn additional tasks.
