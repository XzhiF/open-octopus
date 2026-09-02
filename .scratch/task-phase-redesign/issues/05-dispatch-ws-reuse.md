# 05 — dispatchPhaseRound + 同 task 复用 workspace

## What to build
新 dispatch 入口 `dispatchPhaseRound(task, phaseIdx, roundIdx, feedback?)`：有 `tasks.workspace_id` → 复用 ws 起新 execution（照 triggerChildStep:873-880 写法）；无 → createFromSpec 首建并回写绑定。配套排雷：ws 同名目录 rmSync 覆写→显式报错；task-origin ws retention 豁免（done 前不删）；executions 写 phase_index/round_index；branch 锚点 per-task（phase 不换支）。

## Blocked by
02, 04

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: 第二次 dispatch 后 workspaces 表计数=1、ws 目录内容未重建（文件 mtime/inode 断言防 rmSync 回归）
- [ ] AC2: 同信封并发第二触发被 active 唯一索引拒绝（返回可解释错误）
- [ ] AC3: 首建 ws 名不带 per-trigger 时间戳后缀语义变化外的重名覆写（新规则：仅首建拼名）
- [ ] AC4: retention 扫描跳过未 done 的 task-origin ws

## Verification Method
**Verification type**: integration test

**Verification steps**:
1. `packages/server/src/__tests__/tasks-v4-ws-reuse.test.ts`：双 round 触发 → ws/executions 行断言；模拟同名冲突报错路径
2. retention 单测：done 前/后豁免开关行为
3. `pnpm -F @octopus/server test -- tasks-v4-ws-reuse`

**Pass criteria**: 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
