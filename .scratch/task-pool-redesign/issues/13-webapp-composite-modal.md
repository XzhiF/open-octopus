# 13 — web-app 复合 TaskModal（composition DAG + N 子 + 聚合 + 实时）

## What to build
web-app：复合 TaskModal 模式（点 running [复合] 父卡触发，无 drill-down 二次点击）。composition DAG（复用引擎现成流程图组件）+ N 子卡（ws+workflow_ref+status）+ 聚合节点 + 右侧实时 SSE 事件（父+各子 schedule_status）+ 子 ws 跳转执行详情。父卡聚合状态（任一 running→父 running；全 done+聚合→父 done）。

## Blocked by
12, 04

## Status
done

## Acceptance Criteria
- [x] 点 [复合] 父卡 → modal 复合视图（DAG+N子+聚合），一步到位
- [x] SSE 实时刷新父+各子状态
- [x] 子 ws 点击跳转各子执行详情
- [ ] 父卡聚合状态正确

## Verification Method
**Type**: E2E (Playwright)
**Steps**: dispatch composite（3 subunits）→ 点父卡 → 截图 modal DAG+3子+聚合；等子完成 → assert 实时状态变；点子 ws → assert 跳转。
**Pass**: 截图 + assert PASS。**Fail**: max 3 then SKIP。

## Exploration

### Analog studied
1. `components/swarm/organisms/internal-dag-tab.tsx` — existing flow-graph component using ReactFlow (`@xyflow/react`) + dagre (`@dagrejs/dagre`) for DAG layout. This is the closest analog for the composition DAG rendering. Reuse its exact layout pattern (dagre LR graph, custom node type, smoothstep edges).
2. `components/swarm/organisms/swarm-detail-dialog.tsx` — dialog with real-time events via `useSwarmEvents` hook; pattern for SSE-driven modal content.
3. `app/tasks/page.tsx` — already subscribes to `/api/scheduler/events` `schedule_status` via `subscribeSSE` to refresh the kanban. Same SSE channel reused for the modal.

### Files needing modification (web-app ONLY)
1. `lib/scheduler-api.ts` — define `JobDetail`/`JobDetailChild`/`JobDetailDag` types locally (server owns the canonical def but web-app can't import from `@octopus/server`; mirror the shape from `scheduler-service.ts:91-119`). Change `getJob` return type `SchedulerJob → JobDetail` (backward compatible: `JobDetail = SchedulerJob & { children?, dag? }`).
2. `lib/composite-status.ts` (NEW) — pure `computeAggregateStatus(children, parentStatus)` function (the core business rule from the ticket: running while any child running; done when all done + integration complete; failed if any child failed).
3. `components/tasks/composite-dag.tsx` (NEW) — ReactFlow composition DAG (nodes from `dag.nodes`, edges from `dag.edges`, statuses from `children[]`). Reuses internal-dag-tab pattern.
4. `components/tasks/composite-events-panel.tsx` (NEW) — right-side real-time SSE events log.
5. `components/tasks/task-modal.tsx` — replace `CompositeStub` placeholder with `CompositeMode` (fetches JobDetail, subscribes SSE, renders DAG + child cards + integration + events panel + child drill-down).

### Specific functions chosen
- `subscribeSSE(url, eventType, listener)` from `@/lib/sse-manager` — subscribe to `schedule_status` on `/api/scheduler/events`. SSE payload (from `scheduler-engine.ts:742-746`): `{ schedule_id, status }`. Filter: parent id = `job.id`, children ids = `children[].schedule_id`.
- `getJob(id)` from `@/lib/scheduler-api` — fetch `JobDetail` (children[] + dag). Existing client; extend return type.
- ReactFlow + dagre layout — reuse the exact `internal-dag-tab.tsx` layout approach (dagre `rankdir: "LR"`, `smoothstep` edges, custom node component).
- Child drill-down → `useRouter().push('/scheduler/jobs/${child.schedule_id}')` (existing job detail route `app/scheduler/jobs/[id]/page.tsx`).

### Aggregate status rule (from ticket)
```
failed   if any child status === 'failed'
aborted  if any child status === 'aborted'
running  if any child in (queued, claimed, running)
done     if all children done AND parent status === 'done' (integration complete)
else     parent status (composition still in-flight)
```
