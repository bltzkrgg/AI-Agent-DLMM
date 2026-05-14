# LP Agent Memory Layer Plan

Goal: add per-pool learning and cooldown memory without slowing the LP entry path.

## Final Shape

The bot should behave like this:

1. Read fast signals first.
2. Decide WATCH / QUEUE / DEPLOY without any LLM or network call on the hot path.
3. Let memory influence only priority, cooldown, and advisory selection.
4. Write memory back after close, not during entry evaluation.
5. Keep hard bearish vetoes unchanged.

## What Memory Must Track

- Per-pool outcome history.
- Entry snapshot at decision time.
- Close outcome and reason.
- Recent hold/drop patterns.
- Cooldown windows for repeated failures.
- Priority boosts for pools that repeatedly perform well.

## Proposed Memory Schema

```json
{
  "pools": {
    "mint-or-pool-id": {
      "lastSeenAt": 0,
      "lastDecision": "WATCH|QUEUE|DEPLOY|HOLD|DROP",
      "lastReason": "string",
      "cooldownUntil": 0,
      "successCount": 0,
      "failureCount": 0,
      "recentTrend": "BULLISH|NEUTRAL|BEARISH|UNKNOWN",
      "recentM5": 0,
      "lastPnLPct": 0,
      "lastOutcome": "PROFIT|LOSS|BREAKEVEN",
      "priorityScore": 0
    }
  }
}
```

## Fast Path Rules

- No LLM call on entry.
- No extra remote API call on entry.
- Memory read must be local and cheap.
- If memory is unavailable, entry must still proceed on the existing LP policy.
- Memory must never override a hard bearish veto.

## Lifecycle

### 1. On WATCH

- Store pool identity and snapshot.
- Record why the pool was admitted.
- Attach a lightweight decision snapshot.

### 2. On QUEUE

- Read memory for cooldown and priority only.
- If the pool is repeatedly weak, lower priority or hold it briefly.
- If the pool has strong recent outcomes, raise priority.

### 3. On DEPLOY

- Freeze the entry snapshot.
- Mark the pool as active.
- Do not block deploy on memory churn.

### 4. On CLOSE

- Write realized PnL and close reason.
- Increment success/failure counts.
- Update the recent trend/momentum snapshot.

### 5. On Next Scan

- Read the stored outcome.
- Apply cooldown if the same pool keeps failing.
- Prefer pools with healthy follow-through.

## What This Must Not Do

- Do not add LLM to the entry path.
- Do not add network round trips to WATCH or QUEUE.
- Do not change TP / SL logic.
- Do not alter deploy transaction flow.
- Do not weaken the bearish veto.

## Division of Work

### GPT-5.5 owns the core memory runtime

- Define the memory schema in code.
- Add read/write helpers in the runtime state layer.
- Wire write-back on close.
- Wire read-path on WATCH / QUEUE for priority and cooldown.
- Keep reads synchronous and tiny.
- Keep writes deferred or batched if needed.
- Ensure memory failures are non-fatal.
- Preserve the hot path speed guarantee.

### GPT-5.4 Mini owns the helper layer

- Add tests for read/write/cooldown/priority behavior.
- Add logs that show why memory affected a decision.
- Update docs and report text.
- Audit propagation of entry snapshot fields.
- Verify no additional network calls happen on entry.
- Keep the implementation honest on latency and observability.

## Runtime Status

GPT-5.5 runtime core is implemented:

- `src/market/poolMemory.js` owns the local per-pool memory schema and helpers.
- WATCH reads memory for cooldown and priority scoring.
- Deploy queue reads memory cooldown before deploy.
- Evil Panda writes deploy and close outcomes back into memory.
- Tests cover profit boosts, repeated-loss cooldown, and WATCH/DEPLOY decision writes.

Remaining helper work belongs to 5.4 Mini:

- Operator-facing memory logs are implemented.
- Lookup latency observability is implemented.
- Hot-path audit coverage verifies no LLM/network calls in pool memory.

## Suggested Implementation Order

1. Add memory schema and local state helpers.
2. Write close outcome back into memory.
3. Read memory on WATCH and QUEUE as advisory data.
4. Apply cooldown and priority scoring.
5. Add tests and logs.
6. Verify entry latency stays flat.

## Latency Budget

- Entry decision: local only, no remote fetch beyond existing market snapshot flow.
- Memory read: in-process or small local file, should be effectively instantaneous.
- Memory write: after close, async or batched if necessary.
- Queue should remain as fast as current trusted-WATCH fast lane.

## Acceptance Criteria

- A healthy trusted WATCH candidate still reaches queue fast.
- A bad repeated pool gets cooled down.
- A profitable pool gets prioritized next time.
- Entry speed does not regress in practice.
- Bearish veto still wins over everything else.
