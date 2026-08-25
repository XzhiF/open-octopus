# 05 — spec-field source 判别 + 确认持久化 + ready 门禁

## What to build
打通用户直编闭环（US5）与入队门禁（US6）：POST spec-field 增 `source?: "user"|"agent"`，user 源触发 setSpecNotice（@@spec_updated 下轮送达 agent），agent 源不触发；goal_confirmed/ac_confirmed 成为可绑定字段；readyTask 服务端校验确认完整性。

## Blocked by
01 — shared 类型（goal_confirmed/ac_confirmed/decisions 字段身份）

## Status
done

## Acceptance Criteria
- [x] AC1: POST /api/tasks/:id/spec-field body 增 `source`（缺省 "agent"）；`source==="user"` → setSpecNotice 记录变更字段；agent 源不设置（SW-BP4）
- [x] AC2: field=goal_confirmed（boolean）/ ac_confirmed（string[]）/ decisions（string[]）可绑定，持久化进 task_spec（经 01 扩展的 schema），SSE spec_field_update 照常广播
- [x] AC3: POST /api/tasks/:id/ready 门禁（D18）：goal 为空 ∨ ac<1 ∨ goal_confirmed!==true ∨ 存在未列入 ac_confirmed 的 ac 项 → **409 + 缺失项清单 JSON**；全满足 → draft→ready
- [x] AC4: 确认态跨弹窗持久：确认 → 重新 GET task → 确认字段仍在（非 UI 临时态）
- [x] AC5: 既有 spec-field 调用方（agent curl 配方、E2E helpers）不传 source 时行为不变

## Verification Method
**Verification type**: integration test（真 DB）

**Verification steps**:
```bash
cd packages/server && pnpm vitest run src/__tests__/tasks-v3-gates.test.ts
```
断言序列：spec-field(goal, source=user) → DB version+1 ∧ spec notice pending → 下一轮 clone chat 的 systemPrompt append 含 @@spec_updated（复用 clone-spec-notice.test.ts 模式）；spec-field(goal, source=agent) → notice 不设置；ready 未确认→409 含 missing[]；补齐确认→200 ∧ status=ready。

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Exploration

### Analog studied
The closest existing feature is the **[保存草稿] reverse-notice path** (SPIKE S1, v2-D7): `TasksService.updateTask` → `setSpecNotice(taskId, '@@spec_updated: <fields>')` → clone send path (`routes/clone/index.ts:310-316,429-430`) reads `getSpecNotice` → passes to `CloneRuntime.chat` as `specUpdateNotice` → system-prompt append → cleared after stream. The spec-field endpoint (`POST /:id/spec-field` → `TasksService.updateSpecField`) is the analog for the field-merge + SSE path; it does NOT currently call setSpecNotice. Ticket 05 wires `source` into spec-field so the *user-direct-edit* path (not [保存草稿]) triggers the same notice, and adds the confirmation gate to `readyTask`.

### Files needing modification (all in ticket 05's lane)
- `packages/server/src/services/tasks/tasks-service.ts` — `updateSpecField` (add `source`, validate+merge `decisions`/`goal_confirmed`/`ac_confirmed`, call `setSpecNotice` when source=user); `readyTask` (add D18 gate); replace local `validateSpecFieldValue` copy with shared canonical (SW-BP3) + add server-side validation for the two confirmation fields not in the shared enum; re-export shared `TaskSpecFieldError`; add `TaskReadyGateError`.
- `packages/server/src/routes/tasks.ts` — spec-field route parse `source` (default `"agent"`); ready route return `{error, missing[]}` on gate failure.

### Functions chosen
- `setSpecNotice` (services/tasks/spec-notice-store.ts) — REUSE for source=user. Do NOT call it for source=agent (SW-BP4: agent source must not set notice, or the agent would see its own edits echoed back).
- `validateSpecFieldValue` (@octopus/shared, ticket 01) — REUSE canonical copy for the 9 shared fields incl. `decisions`. Do NOT use the server's local copy (stale — missing `decisions` branch); it is removed.
- `goal_confirmed`/`ac_confirmed` validation — SERVER-SIDE only (not in shared `TaskSpecFieldSchema` enum per spec line 94, which only adds `decisions`; the shared comment defers these to "ticket 05's lane"). value shapes: boolean / string[].
- `materializeTaskSpecToConfig` — unchanged in readyTask (gate runs BEFORE materialize).

### Gate scope decision
The D18 confirmation gate applies to **v3 tasks only** (`taskSpec.task_type !== undefined` — set by the two-phase flow, ticket 04/09). Legacy/v2 tasks (no `task_type`) predate the confirmation flow and keep the existing no-gate behavior. This avoids regressing the 22 currently-passing `tasks-routes.test.ts` tests (whose ready cases set goal+ac but no `goal_confirmed`). Verified baseline: `tasks-routes.test.ts` = 22/22 pass pre-change.
