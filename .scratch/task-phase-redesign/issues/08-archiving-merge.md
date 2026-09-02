# 08 — archiving 编排：ADR 顺延 / 术语 append / 归档 commit / 可重试

## What to build
末 phase accepted → task 进 archiving → 异步编排：读 home 待归并件（docs/adr/、context-notes.md per-project）→ 目标 project worktree 内 ADR 扫最大编号顺延重写（尾行记 task id 溯源）→ CONTEXT.md 术语 append-only（同名不同义不覆盖，冲突清单入归档报告/PR 描述）→ 每 project 归档 commit（`chore(archive): <task> syncback <date>`）→ push → 并入开放 PR 或开归档 PR → 全部成功 task done（解除 ws retention 豁免）；任一 project git 失败停 archiving，`POST /:id/archive/retry` project 粒度幂等续跑。workspace.delete 前 archive-gate 挂卡口。

## Blocked by
06, 07

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: git fixture（project 已有 0003-*.adr）→ 归档后新 ADR 从 0004 编号、slug 保留、尾行含 task id
- [ ] AC2: 术语 append 不覆盖既有条目；冲突词条出现在归档报告且原文件未被改动
- [ ] AC3: 双 project task → 各自分支有归档 commit、message 正则匹配、push 成功→done
- [ ] AC4: 模拟 project B push 失败 → task 停 archiving；retry 后 A 不重复 commit（幂等）、B 续跑成功→done
- [ ] AC5: done 后 retention 扫描可回收该 ws

## Verification Method
**Verification type**: integration test（本地 bare-repo fixture）

**Verification steps**:
1. `e2e/helpers/make-bare-repo`（或 server 测试 util）造双 project 仓库；`packages/server/src/__tests__/tasks-v4-archiving.test.ts` 跑 AC1-AC5
2. ADR 顺延/append 纯函数单测
3. `pnpm -F @octopus/server test -- tasks-v4-archiving`

**Pass criteria**: 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
