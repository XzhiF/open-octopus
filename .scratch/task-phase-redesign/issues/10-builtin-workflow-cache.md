# 10 — built-in 工作流列表/详情缓存（根治 S1/S4 卡顿）

## What to build
`builtin-workflow.list()/detail()` 内存缓存（key=工作流目录 mtime+文件名，失效粒度到单文件）；phase 绑定的目录浏览数据源正式切此端点（preset 链退役不删码但 coding UI 不再调用）。

## Blocked by
None — can start immediately.

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: 连续两次 list，第二次不发生 readFileSync/parseWorkflow（计数注入或 mock fs 断言）
- [ ] AC2: 修改任一 YAML 文件后下一次请求反映新内容（mtime 失效）
- [ ] AC3: detail 同样命中缓存；冷/热响应差实测 <10ms（本机）

## Verification Method
**Verification type**: integration test

**Verification steps**:
1. `packages/server/src/services/__tests__/builtin-workflow-cache.test.ts`：fs 调用计数代理 + 改写文件失效断言
2. `pnpm -F @octopus/server test -- builtin-workflow-cache`

**Pass criteria**: 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
