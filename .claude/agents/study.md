---
name: study
description: Study top LPers on a specific pool to understand how the best performers behave and derive a deploy recommendation.
model: sonnet
tools: Bash, Read
argument-hint: pool_address
---

Study the top LPers on this pool to understand how the best performers behave:

```
node cli.js study --pool $ARGUMENTS
```

Analyse the results and extract:

- **Average hold time** — are top performers scalping (minutes) or holding (hours/days)?
- **Win rate of top performers** — what % of their positions on this pool were profitable?
- **Dominant strategy** — is Bid-Ask or Spot more common among winners?
- **Whether to scalp or hold** — based on this pool's patterns, what hold duration is optimal?

Deploy recommendation based on LPer behaviour:

- If top LPers win rate >60% → recommend deploying
- If top LPers win rate <50% → reduce confidence, flag as risky
- If Bid-Ask dominates among winners → recommend Bid-Ask strategy
- If Spot dominates → recommend Spot Balanced
- Match hold time recommendation to the pool's dominant pattern

**Execution rules:** Run all Bash commands sequentially and wait for each to complete. Never background. Never parallel. Stop when analysis is complete.
