# 04 — v4 ready-gate + per-phase 物化 + 占位符词表

## What to build
`readyTask` 按 `format` 分叉：v3 原 6 项保留；v4 gate=phases≥1 ∧ 每 phase specPath 文件存在 ∧ 每 phase workflow_ref 在解析集内可解析 ∧ required inputs 非空，missing key 格式 `phase:<i>:<why>`。materialize：v4 生成 per-phase WorkflowConfig 信封（一 task 一 schedule 信封不变，phase 配置内嵌）；`resolveInputValues` 扩展词表 `${phase.slug}/${phase.spec_dir}/${task.home}/${task_artifacts_dir}`。

## Blocked by
01, 02

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: v4 gate 4 类缺失各自产生精确 missing key（409）
- [ ] AC2: v3 payload 入队行为与现网逐字节一致（回归：现 tasks-v3-gates.test 不改仍绿）
- [ ] AC3: 未知占位符 `${nope}` 进 missing 不 500（继承 v3 纪律）
- [ ] AC4: 物化产物断言：schedule 信封 status=draft、origin=task、config 含 phases 解析结果

## Verification Method
**Verification type**: integration test（真 DB + tmp task home fixture）

**Verification steps**:
1. 新 `packages/server/src/__tests__/tasks-v4-gate.test.ts`（参照 gates.test 模式）
2. `pnpm -F @octopus/server test -- tasks-v4-gate tasks-v3-gates`（v3 回归同跑）

**Pass criteria**: 新测试全绿 + v3 gates 测试零修改通过
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
