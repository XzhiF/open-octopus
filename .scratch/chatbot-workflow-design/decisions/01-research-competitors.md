# 01 — 竞品架构调研

Type: research
Status: resolved

## Question
优秀的 coding agent 和同类工作流工具如何处理 chatbot ↔ workflow execution ↔ human-in-the-loop 的关系？

## Answer

### LangGraph（最相关参考）
- **Conversation IS the graph** — 对话不是外挂，它就是工作流本身。用 messages channel + thread_id 实现多轮对话
- **`interrupt()` 函数** — 在节点内部调用，类似 Python 的 `input()`。异常机制暂停执行，通过 checkpointer 持久化全量状态
- **两种输入机制严格分离**：
  - 新对话轮次 = `graph.invoke({"messages": [...]})` → 追加到 message channel
  - 恢复中断 = `graph.invoke(Command(resume=value))` → 提供给暂停节点的返回值
- **并行中断** — resume_map: `{interrupt_id: value}` 一次性恢复所有并行分支
- **无内置审批 UI** — 开发者自建前端，社区有开源 dashboard
- **Checkpoint 后端** — SQLite / PostgreSQL / Redis / MongoDB，完整状态快照

### Cursor / Claude Code
- **Chat 是控制面** — 对话就是主界面，任务在对话上下文中执行
- 不存在"工作流 session"和"chat session"的分离

### n8n / Temporal
- **Workflow UI 独立** — human task 在工作流自己的 UI 中处理
- 不与 chat 系统混合

### 关键启示
1. LangGraph 的 interrupt/resume 模式最值得借鉴：清晰的暂停→持久化→恢复链路
2. 对话和工作流的关系有两种范式：合一（Cursor）或分离（n8n）。我们选了混合（C 模型）
3. "新对话轮次"和"恢复中断"应该有不同的 API 路径，不应混用
