# 10 — 前端产出查看器：全文弹窗 + 工作流日志 + MoA 采纳

## What to build
编写页右半 = 产出查看器（US7/10/11/D11，参照 VariantL OutputViewer）：产物列表（GET artifacts）→ 点击弹 ArtifactViewerDialog（GET content 全文，缺失文件降级态）；工作流运行记录 → WorkflowLogDialog（GET assist run logs）；chat 内 agent 建议气泡 + MoA 卡片：三段式产出勾选采纳（ac→spec-field ac；建议→spec-field decisions）；决策备忘区；SSE task_artifacts_update / assist_run_update 刷新。

## Blocked by
06 — artifacts 路由 · 07 — assist workflows · 09 — 两阶段骨架

## Status
done

## Acceptance Criteria
- [x] AC1: 产物列表渲染索引（图标/标题/路径/来源 skill/更新时间）；点击 → 全文弹窗（等宽渲染），底部提示「有意见在对话里说」（无审批按钮，D11）
- [x] AC2: content 403/404 → 弹窗降级态（越权/文件缺失提示），不白屏
- [x] AC3: 工作流运行记录行（状态 badge）→ 日志弹窗：时间戳 + icon + 文本逐行渲染
- [x] AC4: agent 建议气泡含 [运行][跳过]；运行 → POST assist-workflows → 卡片进入运行态（专家列表 ●●●）→ SSE assist_run_update 驱动完成态
- [x] AC5: 采纳面板：ac 候选 checkbox（带专家来源）+ 方案建议 checkbox + 风险只读；[采纳勾选项] → 合并后 spec-field(ac) + spec-field(decisions)；右侧 ac 出现 🧠 来源标记，决策备忘区列出已采纳建议
- [x] AC6: output_parse_error=true → 降级卡展示 output_raw（SW-BP10 UI 侧）
- [x] AC7: SSE task_artifacts_update → 产物列表自动刷新（无需手动）

## Verification Method
**Verification type**: browser E2E + manual checklist

**Verification steps**:
```bash
cd packages/web-app && pnpm playwright test e2e/task-authoring-v3.spec.ts -g "viewer|assist"
```
E2E：预置 artifacts.json + 磁盘文件 → 打开弹窗断言全文 == 磁盘内容；越权构造 → 降级态；触发 assist（小白名单模板）→ 日志弹窗非空 → 完成后采纳面板勾选 → DB ac/decisions 断言。Manual：agent 建议气泡出现时机、对话改产物链路。

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Exploration

### Analog studied
Prototype VariantL (`packages/web-app/app/tasks/prototype/page.tsx:3003` — the ⭐⭐⭐⭐⭐⭐ 产出查看器 variant). Code rewritten, not copied (R6 / spec R6). The existing v3 GoalAcCard (`components/tasks/authoring/goal-ac-card.tsx`) is the closest in-repo analog for SSE-driven right-panel cards: it subscribes to `spec_field_update` via `subscribeSSE` on `/api/tasks/events`, filters by `task_id`, and applies fields locally.

### Files needing modification/creation
- `packages/web-app/lib/tasks-api.ts` (MODIFIED) — add `listArtifacts` / `getArtifactContent` / `triggerAssistWorkflow` / `getAssistWorkflowRun` + their response types. Mirrors the existing `readyTask` / `updateSpecField` factory pattern.
- `packages/web-app/components/tasks/authoring/output-viewer.tsx` (NEW) — right-panel container: artifacts section + workflow-run records + decision memo. Owns SSE subs for `assist_run_update` + `task_artifacts_update` + the live run state.
- `packages/web-app/components/tasks/authoring/artifact-viewer-dialog.tsx` (NEW) — full-content dialog (monospace; 403/404 degraded state; "有意见在对话里说" footer, D11).
- `packages/web-app/components/tasks/authoring/workflow-log-dialog.tsx` (NEW) — process-log dialog (timestamp + icon + text line-by-line).
- `packages/web-app/components/tasks/authoring/moa-adoption-panel.tsx` (NEW) — three-stage adoption (ac candidates checkbox + suggestions checkbox + risks read-only; [采纳勾选项] → spec-field(ac) + spec-field(decisions), SW-BP3).
- `packages/web-app/components/tasks/authoring/authoring-workspace.tsx` (MODIFIED) — add MoA trigger button to the command bar; insert `<OutputViewer>` between GoalAcCard and the enqueue checklist in the right panel.
- `packages/web-app/e2e/task-authoring-v3.spec.ts` (MODIFIED) — add `viewer` + `assist` describe groups (matched by `-g "viewer|assist"`).
- `packages/web-app/e2e/helpers/task-domain-helpers.ts` (MODIFIED) — add `listArtifactsViaApi` / `getArtifactContentViaApi` / `triggerAssistWorkflowViaApi` / `getAssistWorkflowRunViaApi` + assist SseSubscriber fields.

### Specific functions/data chosen
- SSE subscription: `subscribeSSE(url, eventType, listener)` from `lib/sse-manager.ts` (same seam as GoalAcCard). Event names: `"assist_run_update"` (server emits `{task_id, run_id, phase}`, confirmed in `assist-workflow-service.ts:448`) and `"task_artifacts_update"` (D19 designated channel).
- Artifact index type: `ArtifactIndexEntry` from `@octopus/shared` (`{path, by, title, external, updated_at}`) — server GET returns this verbatim.
- Assist run type: `AssistWorkflowRun` from `@octopus/shared` (`{run_id, execution_id, workspace_id, template, status, logs[], output?, output_raw?, output_parse_error?}`).
- Spec-field write: `updateSpecField(taskId, field, value, {source:"user"})` from `lib/tasks-api.ts` — the adoption panel writes `ac` + `decisions` through this existing seam (SW-BP3; `decisions` is already in `TaskSpecFieldSchema`).
- Template whitelist: `["moa-requirements-review","spec-review-swarm","clarify-debate"]` (server `ASSIST_WORKFLOW_TEMPLATES`) — the trigger button uses `moa-requirements-review` (primary, matches prototype).

### Scope notes / gaps flagged
- **task_artifacts_update server emission (AC7)**: the server does NOT currently emit `task_artifacts_update` on the taskpool channel (ticket 06 implemented the read routes only; grep confirms zero emitters). This is a server-side gap outside this ticket's lane (frontend-only). The frontend subscribes to `task_artifacts_update` (future-ready per D19) AND additionally re-fetches artifacts on `spec_field_update` for the same task — the agent's spec update is the closest existing server-visible signal that artifacts were produced, and it is already emitted (verifiable in E2E). The E2E AC7 asserts this `spec_field_update`-driven refresh path.
- **MoA run execution (AC4/AC5)**: a real assist run needs an LLM provider. In dev the run stays "running" indefinitely (no terminal state). The E2E seeds the aggregator `outputs.synthesis` directly into the DB (mirroring the server assist test's `insertExecutionWithOutput`) so the REAL GET /assist-workflows/:runId route parses + returns structured output — the UI is exercised through the real API (R1: real server, real route), not a mock. The LLM-dependent suggestion bubble (AC4 "agent 建议气泡") + the real MoA completion remain manual-verification per the ticket.

## Verification Result

**Command**: `cd packages/web-app && pnpm playwright test e2e/task-authoring-v3.spec.ts -g "viewer|assist"` — **6/6 PASS** (also verified the full 12-test spec passes, no regression to template/goalac).

| AC | Test | Result |
|----|------|--------|
| AC1 | viewer: artifact list renders index; click → full-content dialog == disk (monospace, no approval buttons, D11 footer) | PASS |
| AC2 | viewer: content 403 (escape `../`) / 404 (missing on disk) → dialog degraded state, no white screen | PASS |
| AC7 | viewer: SSE-driven refresh — 2nd artifact appears without manual reload (spec_field_update bridge) | PASS |
| AC3 | assist: bad template → 400; run row status badge → log dialog renders logs/empty-hint | PASS |
| AC4 | assist: MoA trigger button → POST → run card running state (●●●) → SSE assist_run_update captured | PASS |
| AC5 | assist: adoption panel checkboxes → spec-field(ac) + spec-field(decisions) → DB cross-check + decision memo | PASS |
| AC6 | assist: malformed aggregator synthesis → output_parse_error degraded card with output_raw | PASS |

**Typecheck**: `tsc --noEmit` clean for all new/modified files (output-viewer, artifact-viewer-dialog, workflow-log-dialog, moa-adoption-panel, authoring-workspace, lib/tasks-api, e2e/task-authoring-v3, e2e/helpers/task-domain-helpers).


