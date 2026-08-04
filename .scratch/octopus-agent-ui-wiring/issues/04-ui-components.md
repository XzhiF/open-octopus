# 04 — UI Components: Detail Panel + Log Rendering + Status Overlay Wiring

## What to build
Complete the octopus_agent UI across four touchpoints:

### 4.1 OctopusAgentDetailTabs (new component)
**File**: `packages/web-app/components/node-detail/octopus-agent-detail-tabs.tsx`

Three tabs:
- **追踪**: Reuse `AgentTimeline` component with executionId + nodeId props
- **成本**: Reuse `CostLine` + per-model breakdown (same as AgentDetailTabs cost tab)
- **信息**: Display agent name, version, task brief. Data source: pass via props from NodeInfoDialog (which receives StepExecution + node data)

### 4.2 NodeInfoDialog octopus_agent case
**File**: `packages/web-app/components/node-detail/node-info-dialog.tsx`

Add `executorType === "octopus_agent"` branch rendering `<OctopusAgentDetailTabs>`.

### 4.3 ExecutionLogViewer event rendering
**File**: `packages/web-app/components/workspace/execution-log-viewer.tsx`

Add cases for 3 event types:

| Event | Icon | Color | Label |
|-------|------|-------|-------|
| `heartbeat` | `Activity` (lucide-react) | rose-500 | `心跳: Step {n} · {tokens} tokens · {activity}` |
| `harness_directive` | `AlertTriangle` (lucide-react) | red-500 (abort) / amber-500 (pause) | `指令: {type} — {reason}` |
| `heartbeat_stall` | `AlertTriangle` (lucide-react) | orange-500 | `停滞检测: 超过 {timeout}s 无心跳` |

Add to: `EventIcon` switch, `EventLabel` switch, `ExpandableRow` expandable content.
Import `Activity`, `AlertTriangle` from lucide-react.

### 4.4 workflow-flow-viewer-with-status heartbeat injection
**File**: `packages/web-app/components/workspace/workflow-flow-viewer-with-status.tsx`

When building `statusOverlay` for octopus_agent nodes, extract the latest heartbeat from the polled agent-events data and set `statusOverlay.heartbeat`.

## Blocked by
Ticket 03 (types and hooks must be in place first)

## Status
done

## Acceptance Criteria
- [ ] AC-6: 点击节点打开 OctopusAgentDetailTabs
- [ ] AC-7: 追踪 tab 展示 per-turn 事件
- [ ] AC-8: 信息 tab 展示 agent/version/task
- [ ] AC-9: heartbeat 事件有 Activity 图标
- [ ] AC-10: directive 事件有 AlertTriangle 图标
- [ ] AC-11: stall 事件有橙色警告样式
- [ ] AC-3: 节点执行时 heartbeat 信息可见 (statusOverlay wired)
- [ ] AC-4: step/token 数值正确展示

## Verification Method
**Verification type**: Unit test + Browser E2E

**Verification steps**:
1. Unit test: OctopusAgentDetailTabs renders 3 tabs, switches correctly
2. Unit test: EventIcon returns Activity for heartbeat, AlertTriangle for directive/stall
3. Browser E2E: Open workflow viewer → execute octopus_agent workflow → screenshot heartbeat display on node
4. Browser E2E: Click octopus_agent node → screenshot detail panel with 3 tabs
5. Browser E2E: Open log viewer → screenshot event rendering with correct icons

**Pass criteria**: All unit tests PASS + E2E screenshots match expected layout
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
