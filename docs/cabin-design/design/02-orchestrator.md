# 02 · 调度者 orchestrator（C2/C3/C5）

> 舱主 chat = 组织调度者，不亲自写代码。角色提示词软约束（已确认）。复用 session_role_states 角色卡机制。

## cabin-orchestrator preset · 系统提示草案
```
你是工作舱「{cabin.name}」的组织调度者（orchestrator）。
职责：理解需求 → 规划迭代 → 派发任务 → 监督注意力 → 裁决知识。
【硬边界】你不亲自写业务代码、不直接 edit/bash 改仓库；代码由派发出的任务 doer 在独立 worktree 完成。你只调度、查询、裁决。
【自决】指令已明确(explicit)→直接派发，不必问人；模糊(inferred)→评估，必要时只问一个结构化问题。合理默认免问。autonomy={mode}：off 只建议不派发；observe 推断派发先确认；auto 明确指令自决。
【串行】人面对你一个对话。一次只推进一条、一次只问一个结构化问题；提问用对话正文。
【注意力】只把需要人的事 surface 成卡；progress 内部消化，不打扰人。
【授权】每次派发记录不可变 mandate(strength/scope/basis)；note 转达不授权；需求变更须新派发新 mandate。
【上下文】每回合注入舱摘要：需求/迭代/任务清单/attention/健康。用 cabin.* 工具管理，勿镜像任务状态。
```

## 调度工具集
- `cabin.list_tasks`：列舱内任务 id/标题/状态/迭代/worktree（派生）。
- `cabin.dispatch_task`：经 TasksService 建真实任务+绑 cabin_id/iteration_id+触发；写 cabin_jobs(mandate/prompt/priority)+dispatch event。
- `cabin.note_job` / `cabin.resume_job`：steer 运行中 doer（note 不授权）。
- `cabin.iteration_*`：迭代 CRUD/排序。
- `cabin.attention_*`：读/处理串行收件箱。
- findings 裁决：复用 FindingOpsService adopt/ignore（讨论=对话续流零状态）。
- 软约束：不硬移除 edit/bash，靠提示引导委派（仿 superagent）。

## 有界自决（C5，仿 superagent policy.ts）
两层授权：确定性 gate 判 explicit/inferred → explicit 直接路由免评估；inferred 需评估（off/observe/auto + 匹配规则）。Mandate 不可变，reopen 后 revalidate（需求变更须新 mandate）。
doer 边界（写进任务 doer preset）：小改动自主做到完成；阻塞解除自主恢复；仅破坏性/跨模块重设计/反复失败才暂停升级（incident escalation，决策权 Agent 确认权人）。

## 派发流程（C2/C9）
转发原始 trigger + 路由事实（不改写成计划）→ 建任务/工作流/子代理 → 绑 cabin_id → worktree 隔离（initWorktreeOne）→ 写 cabin_jobs + dispatch event → execution ChatWakeTarget 覆写为舱主会话（G2）。

## agent 可知关联 + 上下文注入
每回合上下文注入舱摘要块（deriveCabinView 派生：舱名/需求/迭代/任务清单/attention/健康）。注入机制（P0 细化）：system prompt 段或 role-card 上下文槽，经 cabin_id 拉取。任务 doer 经 tasks.cabin_id 反查归属。关系单写者=任务行，舱不镜像状态。

## 与现有 preset 关系
区别于 main-agent（可为 doer）/task-author。舱主会话创建时绑 cabin-orchestrator；初始化访谈（askDir/askRepos/askM1）也是该角色行为。