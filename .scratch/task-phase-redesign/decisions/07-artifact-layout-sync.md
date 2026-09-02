# 07 — 产物布局与 per-phase 同步

Type: grilling
Status: resolved
Blocked by: ~~03~~（resolved）

## Question

task home 目录新布局；进 phase 时产物同步入 workspace 的机制；执行中 issues Status 回写位置；多 phase 产物连续性。（含票 06 输入：Bash 写锁缺口）

## Answer

Q7.1 裁决 A（五条全收），见 map D15：

1. **task home 布局 = 镜像 project 惯例的同构目录**：`.scratch/<YYYYMMDD>/<slug-N>/`（matt 相对路径零适配直落）+ 草稿期待归并件 per-project 分组存放（docs/adr、context-notes → 票 08 归并源）+ 现有 spec.json/artifacts.json 协议不动
2. **seed（下行）**：round 开跑时物理拷贝 `{home}/.scratch/<date>/<slug-N>/ → ws/.scratch/<date>/<slug-N>/`（非 symlink——进 worktree 即 git-able，产物随分支/PR 免费进仓库）；task home 是 spec 权威源，覆盖 ws 同名；实现=dispatch 入口内照抄 copyTaskWorkflowsToWs 一步
3. **collect（上行）**：round 终态回收 ws 内执行侧改过的文件（issues Status/报告/e2e）回 task home + emit task_artifacts_update（根治不推送断链）
4. **单向环无 merge 冲突**：spec 只草稿 agent 写（下行）、issues 状态/报告只执行侧写（上行）——每类文件单写者单方向
5. **连续性**：代码=同分支（票 03 零改动）；产物=batch 目录同居 ws `.scratch/<date>/` 下
6. **Bash 写锁缺口**：本版补（重定向检查或 disallowedTools），本票子项
