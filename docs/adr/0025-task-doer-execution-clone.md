# 新增内置分身 task-doer：任务执行/验收期对话的承接者

任务弹窗对话（快速修改 / 人工接管 / 修复轮追加指令）原被默认挂在 task-author 上——但 task-author 的 buildPathGuard 以 cwd=task home 硬禁写项目代码（写权环，ADR-0018 §6），动代码必须换身份。决定：**新增内置分身 `task-doer`（显示名"任务执行者"）**承接执行/验收期一切对话，cwd=任务执行 workspace，经既有 workspace-chat 协议（`/api/workspaces/:id/chat`）跑，guard 模型零改动、不新增聊天通道。会话拓扑为**前后相接、各自唯一**：一 task = 一条 task-author 草稿会话（`source_chat_session_id`，谈）+ 一条 task-doer 会话（做，新增字段指向，建议 `doer_session_id`），不按 round 裂变；大改劝退（是否该打回修复轮）由 task-doer 的 persona 用模型判断，不做关键词正则。

## Consequences

- 弹窗 UI 呈现"这个任务有一个对话"，server 按任务当前态路由到对应会话——"一面两会话"是权限域的切分，不是交互分裂。
- 人工接管启动 = 对绑定执行直接 **abort**（不留 paused 半程反悔态；节点终止、工作区现场保留、台账记 takeover）；反悔场景由打回→修复轮覆盖。
- 接管件无自动复检（绑定流已死、无修复轮回归节点），验收**不加机器闸**：台账如实标"自动复检未跑（接管件）"，人工走查+跑起来看把关。
- 与 harness 自动接管（`agent_takeover`）划清：本词条指**人工**接管。
