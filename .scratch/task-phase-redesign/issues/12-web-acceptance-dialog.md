# 12 — web：验收三栏 modal + 打回弹窗（影响清单/形态推荐）+ per-phase 绑定卡

## What to build
验收界面：三栏=执行摘要(用时/token/cost，搬 TaskAiUsageCard)|产物核对(slug 文件列表→ArtifactViewerDialog)|动作区(通过/打回[反馈必填]/中止)。打回弹窗：反馈文本→agent 推荐卡（修复流 or round-2 spec，stub API 可测）→影响清单勾选区（批准→调 spec-field phases）→确认开 round+1。WorkflowBindingDialog 重写：数据源 built-in 清单（票 10）、修 S2（依赖引用稳定化/useMemo）与 S5（保存前重取 version）、per-phase 卡片列表替代单卡。`phase_status_update`/`task_artifacts_update` SSE 挂窗实时刷新。

## Blocked by
07, 10

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: 三栏齐现且数据正确（fixture 执行记录）；产物点击展开全文
- [ ] AC2: 反馈为空时「打回确认」disabled；提交后账本行+round+1 卡片反馈生效（SSE 驱动无需刷新）
- [ ] AC3: 影响清单批准后 home spec 内容变化（API 回读断言）且 version bump
- [ ] AC4: 绑定弹窗打开→fetch 计数=1（网络断言）、快速点选 3 个工作流不闪 spinner 清列表（滚动位置保持）、轮询 bump version 后保存不 409
- [ ] AC5: auto_advance 开关可见可切

## Verification Method
**Verification type**: browser E2E + 组件测试

**Verification steps**:
1. `packages/web-app/e2e/task-phase-acceptance.spec.ts`（AC1-4 网络计数用 page.on('request')）
2. 组件测试：BindingDialog 引用稳定回归（react 渲染计数）
3. `npx playwright test e2e/task-phase-acceptance.spec.ts`（web-app 目录）

**Pass criteria**: 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
