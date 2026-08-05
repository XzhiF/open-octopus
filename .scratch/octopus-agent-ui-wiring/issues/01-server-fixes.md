# 01 — Server-Side Fixes: ObservabilityService + API + Executor Type

## What to build
Fix three server-side issues that block octopus_agent UI functionality:

1. **ObservabilityService.filterEvent()**: Remove the filter that drops `heartbeat`, `harness_directive`, and `heartbeat_stall` events from persistence. These events must reach the `agent_events` table.

2. **agent-events API**: Extend the `GET /api/workspaces/:id/executions/:execId/agent-events` response to include a top-level `heartbeat?: AgentHeartbeat` field, extracted from the most recent heartbeat event in the result set.

3. **getExecutorType()**: In `workflow-detail-panel.tsx`, add an `octopus_agent` case BEFORE the `step.model` check so octopus_agent nodes are not misclassified as generic `agent` type.

## Blocked by
None — can start immediately.

## Status
done

## Acceptance Criteria
- [x] AC-1: heartbeat 事件持久化到 agent_events 表
- [x] AC-2: agent-events API 返回 heartbeat 字段
- [x] AC-5: getExecutorType 返回 octopus_agent
- [x] AC-16: filterEvent 不再过滤 heartbeat

## Verification Method
**Verification type**: Unit test + Integration test

**Verification steps**:
1. Unit test: `filterEvent()` returns non-null for `{ type: 'heartbeat' }`, `{ type: 'harness_directive' }`, `{ type: 'heartbeat_stall' }`
2. Unit test: `getExecutorType()` returns `'octopus_agent'` when `nodeType === 'octopus_agent'`
3. Integration test: Execute a workflow with octopus_agent node → query `agent_events` table → confirm `event_type='heartbeat'` rows exist
4. Integration test: `curl GET /api/workspaces/:id/executions/:execId/agent-events` → response includes `heartbeat` field with step/tokens data

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
