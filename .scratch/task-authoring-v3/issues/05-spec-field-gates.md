# 05 — spec-field source 判别 + 确认持久化 + ready 门禁

## What to build
打通用户直编闭环（US5）与入队门禁（US6）：POST spec-field 增 `source?: "user"|"agent"`，user 源触发 setSpecNotice（@@spec_updated 下轮送达 agent），agent 源不触发；goal_confirmed/ac_confirmed 成为可绑定字段；readyTask 服务端校验确认完整性。

## Blocked by
01 — shared 类型（goal_confirmed/ac_confirmed/decisions 字段身份）

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: POST /api/tasks/:id/spec-field body 增 `source`（缺省 "agent"）；`source==="user"` → setSpecNotice 记录变更字段；agent 源不设置（SW-BP4）
- [ ] AC2: field=goal_confirmed（boolean）/ ac_confirmed（string[]）/ decisions（string[]）可绑定，持久化进 task_spec（经 01 扩展的 schema），SSE spec_field_update 照常广播
- [ ] AC3: POST /api/tasks/:id/ready 门禁（D18）：goal 为空 ∨ ac<1 ∨ goal_confirmed!==true ∨ 存在未列入 ac_confirmed 的 ac 项 → **409 + 缺失项清单 JSON**；全满足 → draft→ready
- [ ] AC4: 确认态跨弹窗持久：确认 → 重新 GET task → 确认字段仍在（非 UI 临时态）
- [ ] AC5: 既有 spec-field 调用方（agent curl 配方、E2E helpers）不传 source 时行为不变

## Verification Method
**Verification type**: integration test（真 DB）

**Verification steps**:
```bash
cd packages/server && pnpm vitest run src/__tests__/tasks-v3-gates.test.ts
```
断言序列：spec-field(goal, source=user) → DB version+1 ∧ spec notice pending → 下一轮 clone chat 的 systemPrompt append 含 @@spec_updated（复用 clone-spec-notice.test.ts 模式）；spec-field(goal, source=agent) → notice 不设置；ready 未确认→409 含 missing[]；补齐确认→200 ∧ status=ready。

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
