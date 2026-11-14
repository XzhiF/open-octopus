# 04 · 通信机制 + trace（C6/C9）

> orchestrator↔doer 通信 = 统一语义层 + 复用异构传输。所有 doer 回报唤醒舱主会话（单线程收件箱）。trace 复用子代理形式。

## 消息分类（统一语义层）
- orchestrator→doer：`dispatch`(建+触发) / `input`(steer 运行中) / `note`(**不授权**) / `resume` / `policy_change`。
- doer→orchestrator：`report`(state+≤600 字 summary) / `attention`(一个结构化问题) / `handback`(带 reasons 回弹 router)。
- human→orchestrator：chat 消息；orchestrator→human：surfaced 卡/问题（attention-first）。

## 传输层映射（复用异构通道）
| doer | dispatch | input/note | report/attention |
|------|----------|-----------|------------------|
| task | TasksService 建+触发(绑 cabin_id) | steer doer_session_id | chat-event-bridge wake |
| workflow | run_workflow | respond_approval/interaction | execution 事件→bridge |
| clone | delegate_to_*+CloneRuntime.chat | CloneRuntime.chat follow-up | chunks SSE |
| subagent | SDK Agent-tool（fire-and-forget） | **无**(一次性) | subagent_runs completed |

异构降级：subagent 只 dispatch→report，UI 不对其暴露 note/resume。

## 投递语义（仿 superagent effects/delivery）
- 持久：每条消息落 cabin_job_events（append-only）。
- 有序：per-job 有序；orchestrator 串行处理。
- 幂等：requestId 去重（复用 bridge dedup maps）。
- 唤醒：bindExecution(executionId, ChatWakeTarget) → **舱主会话**；coalesce 5s、max 3 wakes/exec、stream-active/409 requeue。
- 可见性分级：progress→ActivityBus(内部不 wake)；high-signal(ready/attention/failed)→wake orchestrator；仅人需→surface 卡。
- 权限：mandate 不可变；note 不授权；handback 重入 router 作 candidate。

## G2 关键绑定
舱任务派发时 execution ChatWakeTarget 覆写为舱主会话（chat-event-bridge 路由若 task.cabin_id → **wake** 落 cabin.main_session_id）。主会话不绑单任务；任务会话仍一对一 resolveForSession。

**2026-11-14 修订（用户口径）**：运行态**卡**改落任务自己的 chat（`tasks.source_chat_session_id`，缺线程才回落舱主会话）—— 任务状态转场 / 工作流运行卡 / 人工暂停·继续卡都跟任务线程走；舱主会话只保留 wake 与 C6 账本信号。否则任务 chat 看不到工作流状态，舱 chat 会把同一 execution 重复画几张。暂停/继续卡同时降级为轻量转场卡（`payload.runState`，不带节点摘要），前端另按 executionId 去重运行卡。

## trace 模型（C6）
cabin_job_events kind：dispatch/report/attention/handback/note/human_input；actor：orchestrator/doer/human；payload JSON{summary,state,question,reason,mandate}。append-only 禁改触发器。仿 superagent TriggerDisposition/Decision 审计。

## 三类 doer trace 复用
- 临时子代理：subagent_runs + subagent-window（指令/操作日志/最终汇报/tokens，2s 轮询）。
- task/workflow：agent_events（per-node 有序）+ harness_events（delegation/blocked）+ interaction_messages。
- 舱级时间线：CabinTraceWindow 聚合 cabin_job_events，下钻 subagent-window/run 窗/agent_events。

## 新增代码
CabinCommService：规范化 outbound(dispatch/input/note/resume 按类型映射) + inbound(report/attention/handback→events+wake)。orchestrator 工具 dispatch_task/note_job/resume_job。inbound 复用 bridge 扩展路由舱事件。