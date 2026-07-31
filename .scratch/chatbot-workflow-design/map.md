# Decision Map — Interaction 节点架构重设计

## Destination
将 Interaction 节点从"借用 chatbot session"重构为"workflow-native 对话系统"——两个系统彻底解耦。

## Notes

### 原始问题
- Interaction 节点借用 chatbot session 存储对话，导致数据归属分裂
- Token/cost/duration 无法与 workflow 分析体系统一
- Session 混杂在 chatbot tab 栏
- Chatbot 对工作流无感知，需要 slash command 等额外机制
- 本质是两套独立系统用外键硬连

### 竞品启示
- LangGraph: 对话和工作流分离，interrupt()/Command(resume) 是不同 API 路径
- Temporal: Signal/Query 机制，workflow 等待时零资源消耗
- Cursor/Claude Code: Chat IS the workflow（单用户 IDE 模式，不适合多工作流并行）
- Octopus 差异化: "workflow 内的多轮对话式 HITL"是独特能力

## Decisions so far
- D1: 架构模型 → **彻底解耦**（Workflow 拥有所有 interaction 数据，Chatbot 通过 skill 交互）
- D2: 对话存储 → **interaction_messages 表**（workflow 系统自己的消息表）
- D3: Session linking → **删除**（chat_sessions 不再关联 workflow）
- D4: Chatbot 控制 → **Skill 驱动**（octo-workflow-ops skill 调 workflow API）
- D5: ChatBridge → **删除**（不再需要跨系统 session 管理）
- D6: Token/Cost → **天然统一**（interaction route 直接写入 node_token_usages + llm_calls）
- D7: UI 组件 → **复用 ChatPanel**（只改数据源）
- D8: 竞品参考 → **LangGraph interrupt/resume**（对话和工作流分离，API 桥接）
- D9: 日志整合 → **关键事件双写 agent_events**（右侧面板看摘要，节点详情看完整对话）
- D10: 节点详情 UI → **InteractionDetailTabs**（对话记录 + 追踪 + 结果三 tab）

## Not yet specified
_(已清空)_

## Out of scope
- Chat UI 组件重新设计（复用现有组件）
- 工作流引擎核心执行逻辑修改
- Slash command 系统（chatbot 通过 skill 实现）
