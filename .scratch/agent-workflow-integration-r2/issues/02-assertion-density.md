# 02 — Server Test Assertion Density Enhancement

## What to build
Enhance assertion density in 3 server test files by adding payload value assertions.

## Blocked by
None

## Status
done

## Acceptance Criteria
- [ ] AC1: heartbeat-sse.test.ts density ≥ 0.15 — add assertions for event data fields (execution_id, node_id, agent_name, version, heartbeat.step, heartbeat.tokens_used)
- [ ] AC2: harness-intervene.test.ts density ≥ 0.15 — add response body assertions and state change verification
- [ ] AC3: heartbeat.test.ts density ≥ 0.10 — add specific payload value assertions beyond event count
- [ ] AC4: All enhanced tests still pass
- [ ] AC5: No implementation code changes (test-only)

## Verification Method
**Verification type**: unit test
**Verification steps**: `pnpm vitest run packages/server/src/__tests__/heartbeat-sse.test.ts packages/server/src/__tests__/harness-intervene.test.ts packages/engine/src/__tests__/octopus-agent/heartbeat.test.ts`
**Pass criteria**: All tests pass, density thresholds met
**Failure handling**: Max 3 fix attempts
