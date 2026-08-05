# Agent Workflow Integration — Decision Map

## Destination
Octopus 系统 Agent 具备完整版本管理（发布历史 + 版本回滚），Workflow 引擎支持 `octopus_agent` 节点类型，可将任务委派给系统定义的 Agent/分身，通过四层协议栈（Contract + Observation + Intervention + Transport）实现结构化通信，并具备基础监督控制能力。

## Notes
- 现有 4 类 Agent：Main Agent、4 内置分身、自定义分身、资源安装分身
- 现有 10 种执行器，ExecutorFactory 使用 switch 注册模式
- VarPool 是中央数据总线，支持 fork/merge（并行隔离）
- Session 双系统：Agent session（server 层）+ Execution session（engine 层）
- 版本管理空白：仅 skill 有 evolution_log
- Swarm 已有 MessageBus + SharedMemory 多代理通信模式
- SubWorkflowExecutor 已有 scoped VarPool + I/O mapping 模式

## Decisions so far
- [x] **01-research-multi-agent-orchestration** (resolved): 8 框架对比 + 5 委派模式 + 11 条 Octopus 建议
- [x] **02-research-agent-versioning** (resolved): 行业共识 snapshot + 独立版本表 + tag resolution
- [x] **03-research-communication-protocols** (resolved): 5 层协议栈建议，A2A + MCP + 结构化委派
- [x] **04-version-semantics** (resolved): Release Tag + Maven-style 限定符 (alpha/beta/rc/stable)
- [x] **05-executor-positioning** (resolved): OctopusAgentExecutor 扩展 AgentExecutor (90% 复用)
- [x] **06-delegation-protocol** (resolved): 四层协议栈 Contract + Observation + Intervention + Transport
- [x] **07-version-data-model** (resolved): DB + Filesystem 双存储 (snapshot JSON + versions/ 目录)
- [x] **08-session-management** (resolved): New Delegate Session (每次执行新 session，从版本快照加载)
- [x] **09-harness-scope** (resolved): Observation (Heartbeat) + 基础 Intervention (abort/pause)
- [x] **10-frontend-ui** (resolved): 分身详情页 + Versions Tab

## Not yet specified
_(fog cleared — all decisions resolved)_

## Out of scope
- Harness 规则引擎 (redirect/checkpoint/auto-rules) — 后续迭代
- Agent 运行时性能优化
- 新的 LLM Provider 集成
- 分身创建/编辑 UI 重构
- 跨组织 Agent 共享
- A2A 外部互操作（外部 agent 集成）
