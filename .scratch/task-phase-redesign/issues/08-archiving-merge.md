# 08 — archiving 编排：ADR 顺延 / 术语 append / 归档 commit / 可重试

## What to build
末 phase accepted → task 进 archiving → 异步编排：读 home 待归并件（docs/adr/、context-notes.md per-project）→ 目标 project worktree 内 ADR 扫最大编号顺延重写（尾行记 task id 溯源）→ CONTEXT.md 术语 append-only（同名不同义不覆盖，冲突清单入归档报告/PR 描述）→ 每 project 归档 commit（`chore(archive): <task> syncback <date>`）→ push → 并入开放 PR 或开归档 PR → 全部成功 task done（解除 ws retention 豁免）；任一 project git 失败停 archiving，`POST /:id/archive/retry` project 粒度幂等续跑。workspace.delete 前 archive-gate 挂卡口。

## Blocked by
06, 07

## Status
done

## Acceptance Criteria
- [x] AC1: git fixture（project 已有 0003-*.adr）→ 归档后新 ADR 从 0004 编号、slug 保留、尾行含 task id
      （tasks-v4-archiving > AC1：目标 0001..0003 + home 0001/0002 → 0004-pick-db.md/0005-adr-flow.md，
      尾行 `> Synced from task <id> (<date>)`，commit+push 到 bare origin，report.md 落 home）
- [x] AC2: 术语 append 不覆盖既有条目；冲突词条出现在归档报告且原文件未被改动
      （Widget 旧义原样 + Gizmo append；termConflicts 精确断言；report.md 含 Widget）
- [x] AC3: 双 project task → 各自分支有归档 commit、message 正则匹配、push 成功→done
      （末 phase accepted 全链路自动编排：两仓库各 1 个 `chore(archive): … syncback \d{8}$` commit、
      bare 可 log、completed_at 落、task_status SSE done；多 project 平铺无标记 ADR → unattributed 不阻塞）
- [x] AC4: 模拟 project B push 失败 → task 停 archiving；retry 后 A 不重复 commit（幂等）、B 续跑成功→done
      （真实模拟=B 的 bare origin 目录暂时改名；state.json 记 A done、B 无；retry A skippedByState、
      两仓 archive commit 计数恒 1；另覆盖 retry 409/404 前置校验）
- [x] AC5: done 后 retention 扫描可回收该 ws
      （按 WorkflowExecutor.isTaskWorkspaceUnarchived 同谓词 SQL 断言 done 后无未归档绑定行）

## Verification Method
**Verification type**: integration test（本地 bare-repo fixture）

**Verification steps**:
1. `e2e/helpers/make-bare-repo`（或 server 测试 util）造双 project 仓库；`packages/server/src/__tests__/tasks-v4-archiving.test.ts` 跑 AC1-AC5
2. ADR 顺延/append 纯函数单测
3. `pnpm -F @octopus/server test -- tasks-v4-archiving`

**Pass criteria**: 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Exploration

**类比研究对象**：`beginArchiving`/`setArchivingHook`（票 07 预留接线点，tasks-service.ts:1962-1984）+
`dispatchPhaseRound`（同文件 1527，advance 端点复用）+ `tasks-v4-acceptance.test.ts` 夹具
（内存 DB + tmp HOME + registry stub）+ `workspace-git.test.ts` git fixture 写法。

**归并面落位（SKILL v3 现状核对）**：`packages/core-pack/skills/task-author/SKILL.md`（已 v4 化，票 13 产物）
Step 3 约定 = ADR 平铺 `{home}/docs/adr/NNNN-slug.md`（**未按 project 分目录**），术语笔记
`{home}/context-notes.md` **per-project 分节（`## <project>` 标题）**。→ 适配裁决（记录于此）：
- ADR 归属：① `docs/adr/<project>/**` 子目录分组（向前兼容）；② 文件头 15 行内 `Project: <name>` 标记；
  ③ 任务仅 1 project → 全归它；④ 多 project 且无标记 → 归不进，进归档报告 `unattributed`（K11 人工冲突不阻塞状态机）。
- 术语归属：context-notes 按 `## ` 分节，节标题含 project 名（大小写不敏感）即归该 project；无分节且单 project → 整文件归它。
- 目标 = project worktree（`{ws.path}/config.json.repos[]` name→worktree_path/branch，
  缺 config 回退 `{ws}/projects/<name>` + `git rev-parse --abbrev-ref HEAD`），ADR 写 `<wt>/docs/adr/`、
  术语 append `<wt>/CONTEXT.md` 术语表（无文件/无节则按模板新建）。

**PR 面**：全仓 grep 无既有 `gh pr`/PR 创建代码（server/engine/cli 均零命中）→ 默认 handler 内建：
origin 非 github.com → `skipped`（fixture 场景，本地 bare origin）；github.com → `gh pr list --head` 命中即
并入开放 PR（push 天然带入），否则 `gh pr create`（body=该 project 归档报告含冲突清单）。handler 可注入（deps.pr）。

**需改文件**（全在 ownership 内）：
- 新 `services/tasks/archiving-service.ts`（纯函数：parseAdrFileName/planAdrMerge/parseContextNotesSections/
  parseTermEntries/planGlossaryAppend + createTaskArchiver 编排）
- `services/tasks/tasks-service.ts`：默认 orchestrator 接线（beginArchiving hook 缺省时走内建 archiver——
  票 07 既有测试全部显式 setArchivingHook 或不经末 phase，已逐用例核对不被惊扰）+ `retryArchive` +
  `endArchiving`（done+completed_at 唯一写方）+ `advancePhase`（票 07 移交裁决）+ `awaitArchiving`（测试/UI 观测 promise）
- `routes/tasks.ts`：`POST /:id/archive/retry`（202）+ `POST /:id/advance`（200/409）
- 新测 `__tests__/tasks-v4-archiving.test.ts`（纯函数单测 + 真 git fixture 集成 AC1-AC5 + advance）
- **不改**：workflow-executor、task-artifact-sync、shared、web、core-pack、workspace.ts

**幂等设计（AC4）**：`{home}/archive/state.json` 记 project 粒度完成 + 稳定 date；双保险 = ADR 目标文件含
`Synced from task <id>` 尾行则跳过顺延（防重试重新编号）、术语同名同义=already、同名异义=conflict 不写；
commit 前 `git diff --cached` 判空 → 无新变更不重复 commit；push 恒幂等（Everything-up-to-date 即成功）。
**票03#8 卡口**：workspace.delete 前置 DB-snapshot archive gate 已在（workspace.ts:431），文件合并 gate
= task 未 done 时 enforceRetention 豁免（票 05 已兑现，本票 done 即解除，AC5 断言谓词行）。

## 实现备注 (2026-09-03)

**落地文件**：新 `packages/server/src/services/tasks/archiving-service.ts`（纯函数
parseAdrFileName/planAdrMerge/parseContextNotesSections/attributeNoteSections/parseTermEntries/
planGlossaryAppend + createTaskArchiver 编排）；`tasks-service.ts`（beginArchiving 缺省 hook 时走内建
archiver + startArchiveRun/awaitArchiving/retryArchive/endArchiving(done 唯一写方)/advancePhase）；
`routes/tasks.ts`（POST /:id/archive/retry → 202、POST /:id/advance → 200）；
新测 `__tests__/tasks-v4-archiving.test.ts` 19/19（纯函数 10 + git fixture 集成 9，真 bare repo、tmp HOME、测毕清理）。
**验证**：scoped `npx vitest run tasks-v4-archiving tasks-v4-acceptance` = 40/40；回归 `tasks-*` 全量 = 220/220。
**归档流时序**：末 accepted → 持久态 archiving → (home ADR/notes 采集+归属) → 每 project：worktree 定位
(ws config.json) → ADR 顺延写 → CONTEXT.md 术语 append(冲突只报) → add/diff 判空/commit → push → PR handler
(非 GitHub remote=skipped；GitHub=并入开放 PR 或 gh pr create，body 含冲突清单) → state.json 落盘 → 全 ok → endArchiving=done+completed_at+SSE。

**契约（供票 11/12 消费）**：
- `POST /api/tasks/:id/advance` — v4 ∧ 派生视图中存在「前序 phase accepted ∧ 该 phase pending」→
  200 `{ task, next_action:"dispatched", dispatch:{schedule_id,execution_id,workspace_id,phase_index,round_index:1} }`；
  其余一律 409（首 phase 未触发请走 /:id/trigger，K6 不变）。US11 autoAdvance=false 的「人工起」按钮接此端点。
- `POST /api/tasks/:id/archive/retry` — 仅持久态 archiving → 202 `{ ok, task_id, status }`（异步续跑，
  完成以 task_status SSE 'done' 为准；在飞时重复调用幂等复用同一 run）。非 archiving → 409，未知 → 404。
