# 02 — DB：acceptances 表 + executions/tasks 加列

## What to build
migration：`task_phase_acceptances(id, task_id, phase_index, round_index, decision, feedback, decided_at)`（append-only，索引 task_id+phase_index）；`executions` 加 `phase_index/round_index INTEGER NULL`；`tasks` 加 `workspace_id TEXT NULL`。对应 DAO：acceptance-dao（仅 insert/list，无 update/delete）、execution-dao/task-dao 扩列。

## Blocked by
None — can start immediately（与 01 并行）。

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: 三方言无关 migration 可重入（已存在列/表时 no-op）
- [ ] AC2: acceptance-dao 无 UPDATE 路径（代码审查 + 测试断 append-only）
- [ ] AC3: tasks.workspace_id 读写贯通（task-dao 测试）

## Verification Method
**Verification type**: integration test（真 tmp SQLite）

**Verification steps**:
1. `packages/server/src/db/dao/__tests__/acceptance-dao.test.ts`：insert accepted/rejected、decision CHECK 违例被拒、list 按 (task,phase,round)
2. migration 双跑：同一 DB 执行两次 migrate 不报错
3. `pnpm -F @octopus/server test -- acceptance`

**Pass criteria**: 全部绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
