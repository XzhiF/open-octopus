# 06 · 作业优先级聚焦（C8）

> 作业 = 任务/工作流/助理直接派发的临时任务（统一抽象 cabin_jobs.kind）。可提优先、专注先解决。

## 统一作业抽象
cabin_jobs.kind ∈ task/workflow/subagent；ref_id 引用底层实体；status/进度派生（K3）。priority 数字（Octopus 现无此列）。

## 提优先
- 设 cabin_jobs.priority++。
- task：复用 `POST /api/tasks/:id/trigger` 写 next_fire_at=now（bump 立即跑）。
- claim 排序：扩展 ExecutionDAO.listClaimableTaskLaunches 在并发 gate 内 priority DESC 优先（现 oldest-first）。
- workflow：execution 重排；subagent：orchestrator 立即派发。

## focus 聚焦态
- `cabins.focused_job_id`；`POST /:id/focus` / `DELETE /:id/focus`。
- UI：顶栏高亮聚焦作业 + chat 聚焦该作业 + CabinJobs 聚焦标记。
- orchestrator 优先驱动聚焦作业 attention 到完成；其余排队不打断。

## human-wake 抢占（仿 superagent 额外 slot）
- 聚焦/human-wake 的作业可在 maxWorkers 外占一个额外 slot，抢占新启动。
- **上限防饥饿**：额外 slot 仅 1 个（仿 superagent by==='person' 额外 slot）；priority DESC 不长期独占 gate，低优先仍有保底份额。

## 与并发 gate 交互
task-lifecycle-service LAUNCH claim 在 MAX_PARALLEL_WORKSPACES gate 内排序；priority 影响 claim 顺序，focus/human-wake 影响 slot 预留。具体改法 P0 细化（listClaimableTaskLaunches + concurrency）。

## UI（CabinJobs）
统一作业列表（kind 分色徽章）+ priority 提优先按钮 + focus 按钮 + 查 trace。复用 TASK_STATUS_META 徽章。