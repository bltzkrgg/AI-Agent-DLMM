# LP Agent Memory Layer Plan

Goal: add lightweight decision memory without changing the current LP entry policy.

## What the memory should remember

- Per-pool outcome history.
- Recent hold/drop reasons.
- Successful entry windows.
- Cooldown state after repeated misses.
- Priority score based on live follow-through.

## Proposed shape

- `poolDecisionMemory[mint]`
  - `lastSeenAt`
  - `lastDecision`
  - `lastReason`
  - `cooldownUntil`
  - `successCount`
  - `failureCount`
  - `recentTrend`
  - `recentM5`

## Behavior

1. When WATCH or queue evaluates a pool, read memory first.
2. If the pool repeatedly fails for the same reason, apply a short cooldown.
3. If the pool keeps returning with healthy follow-through, raise priority.
4. After close, write the realized outcome back into memory.
5. Keep memory advisory at first, not a hard reject unless GPT-5.5 approves it.

## Guardrails

- Do not change TP/SL logic.
- Do not change deploy transaction flow.
- Do not add external telemetry.
- Do not let memory override hard bearish vetoes.
- Keep the first version local and cheap.

## Follow-up Tasks

- Define a compact JSON schema for the memory blob.
- Add read/write helpers in the runtime state layer.
- Connect close outcome to memory updates.
- Add tests for cooldown and priority boosts.
- Review whether memory should gate WATCH or only queue prioritization.
