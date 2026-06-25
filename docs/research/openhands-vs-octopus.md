# OpenHands vs Octopus 深度架构对比

> 调研对象：[OpenHands/OpenHands](https://github.com/OpenHands/OpenHands)（原 All-Hands-AI/OpenHands，77.6k★，MIT）
> 对比对象：Octopus（本项目，TypeScript monorepo AI agent 工作流平台）
> 调研日期：2026-06-18
> 源码版本：OpenHands `openhands-sdk==1.28.0`（仓库正处于多仓库拆分迁移期）

---

## 0. 一句话定位差异

| | OpenHands | Octopus |
|--|-----------|---------|
| **本质** | LLM 自主循环的编码 Agent（"让 AI 像人一样写代码"） | 预定义 DAG 的自动化工作流引擎（"让 AI 按流程可重复执行"） |
| **控制流** | LLM 自主决策每一步 | YAML DAG 显式定义节点依赖 |
| **确定性** | 低——同输入可能不同路径 | 高——同 DAG 同输入同路径 |

这是两个项目的**根本范式差异**，所有后续架构差异都由此衍生。

---

## 一、项目定位与哲学

### OpenHands

前身 OpenDevin，定位为"AI-Driven Development"——让 AI agent 自主完成软件开发任务。核心信条是 **agent 自主性**：LLM 在 agent loop 中自行决定调用什么工具、何时停止，人类只在需要时介入。SWE-Bench 77.6% 是其能力证明。

哲学：**灵活性优先**。agent 面对开放性编码任务，无法预定义所有路径，所以把决策权交给 LLM。

### Octopus

定位为"多组织通用平台"——CLI + Skill + Agent + Workflow Engine。核心信条是 **流程确定性**：5 步创建流程、YAML DAG 工作流、Auto Answers 无人值守、6 种节点执行器。

哲学：**可重复性优先**。工作流要可审计、可复现、可无人值守运行。LLM 是执行器之一（AgentExecutor），不是唯一决策者。

### 关键区别

```
OpenHands:  用户 → [LLM 自主循环] → 结果
                    ↑ LLM 决定一切

Octopus:    用户 → [DAG: bash→agent→condition→approval→loop] → 结果
                    ↑ 人类预定义流程，LLM 只在 agent 节点内自主
```

---

## 二、技术栈与仓库结构

| 维度 | OpenHands | Octopus |
|------|-----------|---------|
| 语言 | Python 3.12-13 | TypeScript (Node ≥22) |
| 仓库 | 多仓库拆分（app / sdk / canvas / tools） | 单 monorepo 7 包 (pnpm workspace) |
| 后端 | FastAPI + uvicorn | Hono |
| 前端 | Next.js (agent-canvas，独立仓库) | Next.js (web-app，monorepo 内) |
| 实时通信 | WebSocket (python-socketio) + SSE | SSE + WebSocket (yjs-ws) |
| 数据库 | PostgreSQL (SQLAlchemy async) + Redis | SQLite (better-sqlite3) |
| 持久化 | Event Store (事件流持久化) | SQLite + JSONL |
| 沙箱 | Docker / E2B / Modal / Daytona / K8s | 无独立沙箱（直接执行） |
| LLM 层 | litellm (100+ provider) | 自研 @octopus/providers + Claude SDK |
| 测试 | pytest + pytest-asyncio + playwright | Vitest |
| 可观测性 | OpenTelemetry + Langfuse | 自研 observability service |

### OpenHands 仓库拆分现状

| 仓库 | 定位 | 主要内容 |
|------|------|---------|
| `OpenHands/OpenHands` | 应用层 monorepo（原主仓库） | `openhands/app_server/`、`frontend/`、`openhands-ui/`、`skills/`、`containers/`、`enterprise/`、`tests/` |
| `OpenHands/software-agent-sdk` | **Agent 核心引擎**（新拆出） | `openhands-sdk/`、`openhands-agent-server/`、`openhands-tools/`、`openhands-workspace/` |
| `OpenHands/agent-canvas` | 新前端（Node.js，npm `@openhands/agent-canvas`） | Agent Canvas 控制中心 |

传统 OpenHands 的 agent/llm/runtime/controller 代码**已不在主仓库**，而是作为独立 PyPI 包发布（`openhands-sdk`/`openhands-agent-server`/`openhands-tools` ==1.28.0）。

**架构信号**：OpenHands 已走向多仓库 + 独立发版（模块边界已稳定到可独立发版），Octopus 保持单 monorepo 统一开发。

### Octopus 包结构

```
octopus/
├── packages/
│   ├── shared/          ← 共享类型 + VarPool + config + manifest + repo-ops
│   ├── providers/       ← AI Provider 抽象层（IAgentProvider + ClaudeSDKProvider）
│   ├── cli/             ← Commander.js CLI
│   ├── engine/          ← Workflow 执行引擎（6 executors + harness + WorkflowEngine）
│   ├── server/          ← Hono REST API + SSE + WebSocket
│   ├── web-app/         ← Next.js 前端
│   └── core-pack/       ← skills/agents/scripts/templates/presets/config
```

---

## 三、Agent 执行模型（核心差异）

### OpenHands：Conversation 驱动的自主循环

```
Conversation.run()
  → Agent 取 Event 流
  → 调 LLM (litellm)
  → LLM 返回 tool_call (LLMConvertibleEvent)
  → 执行 Tool → 产生 Observation Event
  → 回灌事件流
  → 直到 LLM 不再调用工具 (stop)
```

关键组件：
- **Conversation**（`sdk/conversation/`）：运行时载体，持有 agent + workspace，提供 `send_message()`/`run()`
- **Event 体系**（`sdk/event/`）：所有 action/observation 统一为 `Event`，可持久化、可恢复（`resume_transcript.py` 15.8KB）
- **stuck_detector**（`conversation/stuck_detector.py` 12KB）：检测 agent 陷入死循环
- **Condenser**（`context/condenser/`）：`LLMSummarizingCondenser` 在上下文超限时摘要压缩
- **Critic**（`agent/critic_mixin.py` 5.2KB）：agent 自我评审机制

SDK 公共 API 核心导出（`openhands/sdk/__init__.py`）：

```python
# LLM 层
from openhands.sdk.llm import (LLM, LLMRegistry, LLMProfileStore, RouterLLM,
    FallbackStrategy, LLMStreamChunk, TokenUsage, Message, ...)

# Agent 层
from openhands.sdk.agent import Agent, AgentBase   # ACPAgent 懒加载

# Conversation 层（核心运行时）
from openhands.sdk.conversation import (BaseConversation, Conversation,
    LocalConversation, RemoteConversation, ...)

# Event 层（事件流）
from openhands.sdk.event import (Event, LLMConvertibleEvent, MessageEvent, ...)

# Tool 层
from openhands.sdk.tool import (Action, Observation, Tool, ToolDefinition,
    register_tool, resolve_tool, list_registered_tools)
```

典型用法：

```python
from openhands.sdk import LLM, Agent, Conversation, Tool
from openhands.tools.file_editor import FileEditorTool
from openhands.tools.terminal import TerminalTool

llm = LLM(model="gpt-5.5", api_key=os.getenv("LLM_API_KEY"))
agent = Agent(llm=llm, tools=[Tool(name=TerminalTool.name), Tool(name=FileEditorTool.name)])
conversation = Conversation(agent=agent, workspace=os.getcwd())
conversation.send_message("Write 3 facts about the current project into FACTS.txt.")
conversation.run()
```

### Octopus：DAG 驱动的节点执行

```
WorkflowEngine.run(yaml)
  → 拓扑排序节点
  → 逐节点执行（或按 execute_when 条件跳过）
  → 每个节点是 6 种 executor 之一:
    - BashExecutor: 执行 shell 命令
    - PythonExecutor: 执行 Python 脚本
    - AgentExecutor: 调 IAgentProvider.sendQuery() (LLM 自主)
    - ConditionExecutor: 条件分支
    - ApprovalExecutor: 人工审批
    - LoopExecutor: 循环
  → 变量池传递节点间数据 ($vars.xxx / $node-id.output.xxx)
  → Auto Answers 注入预设答案实现无人值守
```

关键组件：
- **WorkflowEngine**（`engine/engine.ts`）：DAG 解析 + 拓扑排序 + 节点调度
- **6 Executors**（`engine/executors/`）：`agent.ts` / `approval.ts` / `bash.ts` / `condition.ts` / `loop.ts` / `python.ts`
- **VarPool**（`shared/`）：全局变量池 + 表达式求值
- **PromptInjector**（`engine/prompt-injector.ts`）：变量注入 + Auto Answers 编译
- **Hooks**（YAML）：`on_node_success`/`on_workflow_failure`/`on_complete` 等事件钩子

### 深度对比

| 维度 | OpenHands | Octopus |
|------|-----------|---------|
| 决策者 | LLM（每步自主决策） | DAG（人类预定义）+ LLM（agent 节点内自主） |
| 控制流 | 隐式（LLM 推理） | 显式（YAML DAG + condition/loop 节点） |
| 可审计性 | 中（Event 流可回放，但路径不确定） | 高（DAG 结构固定，执行树可可视化 `workspace tree`） |
| 可复现性 | 低（LLM 非确定性） | 高（DAG 确定性 + Auto Answers） |
| 灵活性 | 高（面对未知任务自适应） | 中（需预定义流程，agent 节点提供局部灵活性） |
| 死循环防护 | stuck_detector（运行时检测） | LoopExecutor max_iterations（编译时约束） |
| 上下文管理 | LLMSummarizingCondenser（自动压缩） | 无自动压缩（依赖 LLM 自身窗口管理） |
| 无人值守 | 需配置（agent 可能 ask_user） | 原生支持（Auto Answers 全局+节点级预设） |
| 会话恢复 | resume_transcript（完整事件回放） | 无（工作流从头重跑或手动 resume） |

**核心洞察**：OpenHands 的 agent loop 是**一个超大的自主循环**；Octopus 的 AgentExecutor 是**DAG 中的一个受控节点**——LLM 自主性被限制在单个节点范围内，节点间的流转由 DAG 确定。这是"自主 agent"与"工作流编排"两种范式的本质区别。

---

## 四、LLM Provider 抽象

### OpenHands

```
litellm (100+ provider)
  ↓
LLM 类 (llm.py, 115KB)
  ├── LLMRegistry (按 usage_id 管理实例，独立 metrics)
  ├── RouterLLM (按任务复杂度/成本路由到不同模型)
  ├── FallbackStrategy (主 provider 失败时降级)
  ├── LLMProfileStore (持久化 LLM 配置)
  └── CredentialStore + OAuthCredentials (认证管理)
```

- **不自己实现 provider 适配**，完全建立在 litellm（1.84.1 精确锁定）之上
- `VERIFIED_MODELS` / `UNVERIFIED_MODELS_EXCLUDING_BEDROCK`：模型验证状态标记
- `TokenUsage` + `Metrics`：token 计费跟踪
- `LLMStreamChunk` + 回调：流式输出
- `LLMRegistry` 确保每个 LLM 实例有独立 metrics（防止 `model_copy()` 共享）

### Octopus

```
IAgentProvider 接口 (packages/providers/src/types.ts:59)
  ├── sendQuery(prompt, cwd, options) → AsyncGenerator<MessageChunk>
  ├── getType(): string
  └── getLLMCalls?(): LLMCallRecord[]
      ↓
ClaudeSDKProvider (claude/provider.ts:118)
  ├── 包装 @anthropic-ai/claude-agent-sdk
  ├── SDK 事件 → MessageChunk 转换
  └── LLMCallTracker (LLM 调用追踪 + 成本计算)
      ↓
registerProvider(id, factory) / getProvider(id)
```

- **自研抽象层**，当前仅 ClaudeSDKProvider 一个实现
- `IAgentProvider` 不是纯 LLM 接口，而是**完整 agent 运行时接口**（包含工具循环、会话管理）
- `MessageChunk` 是丰富的流式事件联合类型（18 种事件类型）
- `LLMCallTracker`：LLM 调用记录 + 成本校准（`computeCost` / `calibrateCosts`）

### 深度对比

| 维度 | OpenHands | Octopus |
|------|-----------|---------|
| Provider 覆盖 | 100+ (litellm) | 1 (Claude SDK)，正在扩展 (Mastra/pi) |
| 抽象层级 | 纯 LLM 调用层 (completion/chat) | 完整 agent 运行时 (工具循环+会话) |
| 路由/降级 | RouterLLM + FallbackStrategy | 无 |
| 成本追踪 | Metrics + TokenUsage | LLMCallTracker + computeCost + calibrateCosts |
| 认证 | CredentialStore + OAuth | 环境变量 + settings.json |
| 模型验证 | VERIFIED_MODELS 标记 | 无 |
| 流式协议 | LLMStreamChunk (litellm 标准) | MessageChunk (自研 18 种事件) |

**核心洞察**：OpenHands 的 LLM 层是**薄抽象**（litellm 已经做了重活），Octopus 的 IAgentProvider 是**厚抽象**（包含完整 agent 运行时语义）。这导致 Octopus 扩展新 provider 更难（要实现完整 agent 行为），但抽象层级更高（调用方不需要管工具循环）。

---

## 五、Runtime / 沙箱

### OpenHands：多后端沙箱架构

```
App Server (控制层)
  ↓ docker.sock
Agent Server (执行层，运行在沙箱内)
  ├── bash_service.py (18.7KB) — 终端执行
  ├── file_router.py (10.5KB) — 文件操作
  ├── desktop_service.py (7.6KB) — VNC 远程桌面
  ├── git_router.py — Git 操作
  └── MCP / Skills / Hooks
```

沙箱后端矩阵：

| 后端 | 说明 |
|------|------|
| Docker（主） | 挂载 docker.sock，拉起 `ghcr.io/openhands/agent-server:1.28.0-python` |
| E2B | 云端代码解释器沙箱 |
| Modal | Modal 云函数沙箱 |
| Daytona | Daytona 开发环境沙箱 |
| Kubernetes | K8s pod 沙箱 |
| 本地 | 直接运行（README 警告危险） |

每个会话独立容器/pod，通过 `conversation_lease.py`(10.2KB) 实现并发租约锁定。

### Octopus：无独立沙箱

```
Server (Hono, 直接执行)
  ├── execution.ts — 工作流执行
  ├── BashExecutor — 直接 spawn 子进程
  ├── PythonExecutor — 直接执行 Python
  └── AgentExecutor — 调 IAgentProvider (Claude SDK 子进程)
```

多实例隔离靠 git worktree + hash 端口 + 独立 SQLite DB（`multi-instance-isolation.md`），不是沙箱隔离。

### 深度对比

| 维度 | OpenHands | Octopus |
|------|-----------|---------|
| 隔离方式 | 容器/pod 级隔离 | 进程级 + worktree 级 |
| 安全性 | 高（沙箱内执行不可信代码） | 中（直接在宿主执行） |
| 资源开销 | 高（每会话一个容器） | 低（共享进程） |
| 浏览器 | Playwright + browsergym + VNC 桌面 | agent-browser CLI |
| 文件系统 | 沙箱内隔离 | 直接访问宿主文件系统 |
| 多租户 | 容器级隔离 + 会话租约 | worktree + DB 隔离 |

**核心洞察**：OpenHands 的沙箱架构是为"不可信代码执行"设计的（agent 可能执行任意代码），Octopus 的直接执行是为"可信自动化"设计的（工作流在受控环境运行）。

---

## 六、事件流与状态管理

### OpenHands：统一 Event 体系

```
Event (基类)
  ├── LLMConvertibleEvent (可转 LLM message)
  ├── MessageEvent (用户消息)
  ├── HookExecutionEvent (Hook 执行)
  ├── CondenserEvent (上下文压缩)
  ├── StreamingDeltaEvent (流式增量)
  ├── TokenEvent (token 用量)
  ├── ConversationStateEvent (会话状态)
  └── ConversationErrorEvent (错误)
```

- **Event Store**（`event_store.py`）：事件流持久化
- **pub_sub.py**：发布订阅分发
- **resume_transcript.py**（15.8KB）：会话中断后完整恢复
- 事件流是 agent 的"记忆"——所有 action/observation 都是事件

### Octopus：SQLite + JSONL

```
SQLite (octopus.db)
  ├── workspaces 表
  ├── executions 表
  ├── nodes 表 (节点执行状态)
  └── variables 表 (变量池快照)

JSONL (logs/{execution-id}/{node-id}.jsonl)
  ├── agent_event (流式事件)
  ├── tool_start / tool_result
  ├── vars_update
  └── status
```

- 每个节点独立日志文件（JSONL）
- SQLite 存工作流/执行/节点状态
- 无事件流回放/恢复机制（工作流失败需重跑）

### 深度对比

| 维度 | OpenHands | Octopus |
|------|-----------|---------|
| 事件模型 | 统一 Event 体系（action/observation 都是事件） | 分层（SQLite 状态 + JSONL 日志） |
| 可恢复性 | 高（resume_transcript 完整回放） | 低（失败重跑，无断点恢复） |
| 可审计性 | 高（事件流完整记录） | 中（日志完整但无统一事件模型） |
| 上下文压缩 | LLMSummarizingCondenser（自动） | 无 |
| 卡死检测 | stuck_detector（运行时） | 无（靠 timeout） |

---

## 七、Workflow / 编排

### OpenHands：Workflow 作为 Tool

```python
# workflow 不是独立引擎，而是 agent 的一个工具
agent = Agent(llm=llm, tools=[
    Tool(name=TerminalTool.name),
    Tool(name=WorkflowTool.name),  # ← workflow 是 tool
])
```

Workflow 定义（`tools/workflow/definition.py` 6.7KB）+ 执行（`impl.py` 19KB）——agent 自主决定何时调用 workflow。

多 agent 协作：
- `parallel_executor.py`（11.5KB）：并行多 agent
- `delegate/`：子 agent 委托
- `ACP`（`acp_agent.py` 173KB）：接入第三方 agent（Claude Code/Codex/Gemini）

### Octopus：Workflow 作为独立引擎

```yaml
# workflow 是独立引擎，YAML 定义 DAG
nodes:
  - id: setup
    type: agent
  - id: plan
    type: agent
    depends_on: [setup]
  - id: review
    type: agent
    depends_on: [plan]
    execute_when: '$vars.review_blockers != "0"'
  - id: ship
    type: agent
    depends_on: [review]
```

6 种节点执行器 + 变量池 + 表达式求值 + Auto Answers + Hooks（notify/bash）。

### 深度对比

| 维度 | OpenHands | Octopus |
|------|-----------|---------|
| Workflow 定位 | Agent 的一个 Tool | 独立编排引擎 |
| 控制流 | LLM 决定（隐式） | YAML DAG（显式） |
| 条件分支 | LLM 判断 | ConditionExecutor + `execute_when` 表达式 |
| 循环 | LLM 决定 | LoopExecutor + max_iterations |
| 人工审批 | LLM ask_user | ApprovalExecutor（显式节点） |
| 变量传递 | Event 流上下文 | VarPool ($vars.xxx / $node.output.xxx) |
| 无人值守 | 需配置 | Auto Answers（全局+节点级预设） |
| 多 agent | parallel_executor + delegate + ACP | AgentExecutor 节点（agent 内子代理） |
| 第三方 agent | ACP 协议（Claude Code/Codex/Gemini） | 无 |

**核心洞察**：OpenHands 的 workflow 是"agent 调用 workflow"（自上而下），Octopus 的 workflow 是"workflow 调度 agent"（自下而上）。两种方向各有优势：
- OpenHands 模式：灵活，适合探索性任务
- Octopus 模式：可控，适合可重复自动化

---

## 八、Tool / Action 系统

### OpenHands

```
Tool (sdk/tool/)
  ├── register_tool() / resolve_tool() / list_registered_tools()
  ├── Action (基类) → Observation (基类)
  └── 内置 Tools:
      ├── TerminalTool — 终端
      ├── FileEditorTool — 文件编辑
      ├── PlanningFileEditorTool — 计划文件
      ├── TaskTrackerTool — 任务跟踪
      ├── apply_patch — patch 应用
      ├── browser_use — 浏览器 (browsergym)
      ├── glob / grep — 搜索
      ├── delegate — 子 agent 委托
      ├── workflow — workflow 调用
      └── gemini / tom_consult — 多 LLM 协作
```

### Octopus

Tool 概念分散在多层：
- **BashExecutor**：shell 命令执行（不是 LLM tool，是 DAG 节点）
- **PythonExecutor**：Python 脚本执行
- **AgentExecutor 内的 tools**：由 IAgentProvider（Claude SDK）自带工具集（Read/Write/Edit/Bash/Grep/Glob 等）
- **MCP 工具**：通过 `octopus-mcp-cli` 调用，在 SKILL.md 的 `## MCP 参考` 声明
- **Skills**：文件级（SKILL.md + scripts/ + references/），被 agent 加载为系统提示

### 深度对比

| 维度 | OpenHands | Octopus |
|------|-----------|---------|
| Tool 注册 | `register_tool()` 全局注册表 | 无统一注册（分散在 executor + provider） |
| Tool 定义 | Action/Observation 类继承 | AgentExecutor 内由 provider 定义 |
| 浏览器 | Playwright + browsergym + VNC | agent-browser CLI (octo-browser-vision skill) |
| 文件操作 | FileEditorTool（独立 tool） | Claude SDK 自带 Read/Write/Edit |
| 搜索 | glob/grep（独立 tool） | Claude SDK 自带 Grep/Glob |
| 任务跟踪 | TaskTrackerTool（独立 tool） | 无（靠 VarPool + 工作流状态） |

**核心洞察**：OpenHands 的 tool 系统是**显式注册、可扩展**的；Octopus 的 tool 能力**绑定在 IAgentProvider 实现**中（Claude SDK 自带工具集），扩展性受限。

---

## 九、MCP 集成

### OpenHands：SDK 一等公民

```python
from openhands.sdk import MCPClient, create_mcp_tools, MCPToolDefinition

# MCP 工具直接注册为 agent tool
mcp_tools = create_mcp_tools(mcp_client)
agent = Agent(llm=llm, tools=[Tool(name=TerminalTool.name), *mcp_tools])
```

- `MCPClient`：MCP 客户端
- `create_mcp_tools`：从 MCP server 自动创建 tools
- `mcp_router.py`（13.8KB）：REST API 管理 MCP server
- 依赖：`fastmcp>=3.2` + `mcp>=1.25`

### Octopus：YAML 注册表 + CLI 直连

```yaml
## SKILL.md 内声明
## MCP 参考
注册表: ~/.octopus/{org}/mcp/mcp_prod.yaml
覆盖环境:
  - prod (生产) — query_order, create_order
调用: octopus-mcp-cli order-service query_order '{"order_id": "12345"}' --org {org}
```

- MCP 服务信息存储在 YAML 注册表（`~/.octopus/{org}/mcp/mcp_{env}.yaml`）
- `octopus-mcp-cli`：CLI 直连 backend Server 调用 MCP tool
- mcp-discoverer agent：从 YAML 注册表查找可用 MCP

### 深度对比

| 维度 | OpenHands | Octopus |
|------|-----------|---------|
| 集成方式 | SDK 内置（MCPClient → tool 自动注册） | YAML 注册表 + CLI 桥接 |
| 调用方式 | agent 直接调用（tool call） | Bash 执行 octopus-mcp-cli 命令 |
| 动态发现 | 运行时连接 MCP server | mcp-discoverer agent 预发现 |
| 环境隔离 | 无（全局 MCP） | org 级 + env 级（mcp_{env}.yaml） |
| 多组织 | 无 | ✅ org 级隔离 |

**核心洞察**：OpenHands 的 MCP 是**运行时直连**（低延迟、实时），Octopus 的 MCP 是**预注册 + CLI 桥接**（可审计、多组织隔离）。Octopus 的多组织 MCP 隔离是其企业级特性。

---

## 十、Skills 系统

| 维度 | OpenHands | Octopus |
|------|-----------|---------|
| 格式 | 文件级（Python module / config） | 文件级（SKILL.md + scripts/ + references/） |
| 加载 | `load_project_skills` / `load_user_skills` / `load_skills_from_dir` | agent 加载为系统提示 |
| 市场 | `extensions/` + `marketplace/`（公共 skill 市场） | core-pack 预置（无市场） |
| 创建工具 | 无专门创建工具 | octo-skill-creator（5 步创建流程） |
| 验证 | 无 | skill-evaluator（6 点验证） |
| 进化 | 无 | octo-skill-evolution（经验记录/搜索/索引） |

**核心洞察**：Octopus 的 Skills 系统更成熟——有专门的创建工具（5 步流程）、验证机制（6 点验证）、经验进化（记录/搜索/索引）。OpenHands 的 Skills 更简单但支持市场分发。

---

## 十一、Server / API 对比

### OpenHands 两层 Server

```
App Server (FastAPI, /api/v1)
  ├── event_router — 事件
  ├── app_conversation_router — 会话
  ├── sandbox_router — 沙箱管理
  ├── settings_router — 设置
  ├── secrets_router — 密钥
  ├── skills_router — skills
  ├── webhook_router — webhook 回调
  └── git_router — git

Agent Server (沙箱内, REST)
  ├── conversation_router (19.2KB) — 会话生命周期
  ├── event_router (6.4KB) — 事件流
  ├── bash_router — 终端
  ├── file_router — 文件
  ├── mcp_router — MCP
  ├── llm_router — LLM
  ├── desktop_router — 远程桌面
  ├── hooks_router — Hook
  └── openai/ — OpenAI 兼容 API
```

### Octopus 单层 Server

```
Server (Hono, REST + SSE + WebSocket)
  routes/
  ├── workspace.ts — 工作空间 CRUD + 执行树
  ├── workflow.ts — 工作流管理
  ├── execution.ts — 执行控制
  ├── events.ts — SSE 事件流
  ├── scheduler.ts / cron.ts — 定时调度
  ├── chat.ts / scheduler-chat.ts — 对话
  ├── pipeline.ts / chain-routes.ts — 流水线/链式执行
  ├── dashboard.ts / analytics.ts — 仪表盘
  ├── org.ts — 组织管理
  ├── file-routes.ts — 文件
  ├── yjs-ws.ts — WebSocket 协同
  └── builtin-workflow.ts — 内置工作流

  services/
  ├── execution/ — 执行服务
  ├── scheduler/ — 调度器
  ├── notification.ts — 通知 (Hermes)
  ├── observability.ts — 可观测性
  ├── error-tracker.ts — 错误追踪
  ├── git-ops.ts — Git 操作
  ├── leaderboard.ts — 排行榜
  ├── log-analysis.ts — 日志分析
  ├── suggestion-engine.ts — 建议引擎
  └── chain-engine.ts — 链式引擎
```

### 深度对比

| 维度 | OpenHands | Octopus |
|------|-----------|---------|
| 架构 | 两层（App + Agent Server） | 单层（Hono） |
| 沙箱通信 | App → Docker → Agent Server | 无（直接执行） |
| OpenAI 兼容 | ✅（Agent Server 提供） | ❌ |
| 定时调度 | ❌ | ✅（scheduler + cron） |
| 链式执行 | ❌ | ✅（chain-engine，工作流串联） |
| 仪表盘/分析 | ❌ | ✅（dashboard + analytics + leaderboard） |
| 协同编辑 | ❌ | ✅（yjs-ws WebSocket） |
| 通知系统 | webhook 回调 | Hermes (Telegram) |
| 错误追踪 | OpenTelemetry | error-tracker service |

**核心洞察**：Octopus 的 Server 更偏**运营平台**（调度、分析、排行、协同），OpenHands 的 Server 更偏**执行环境**（沙箱、事件流、终端）。

---

## 十二、可观测性与评估

### OpenHands

- **OpenTelemetry**：OTLP 标准导出（`opentelemetry-exporter-otlp-proto-grpc`）
- **Langfuse**：`lmnr` 包集成
- **SWE-Bench 77.6%**：业界标准基准
- **Critic 机制**：`agent/critic_mixin.py`——agent 自我评审
- **VerificationSettings**：验证配置

### Octopus

- **observability service**：自研可观测性
- **error-tracker**：错误追踪
- **log-analysis**：日志分析
- **skill-evaluator**：6 点验证（YAML frontmatter / 结构完整性 / 生产安全 / 内容覆盖 / 自包含完整性 / MCP 有效性）
- **leaderboard**：排行榜
- 无标准基准（如 SWE-Bench）

---

## 十三、部署与运维

### OpenHands

```yaml
# docker-compose.yml 核心结构
services:
  openhands:
    build: ./containers/app/Dockerfile
    ports: ["3000:3000"]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock   # DinD 启动 agent-server
      - ~/.openhands:/.openhands
      - ${WORKSPACE_BASE:-$PWD/workspace}:/opt/workspace_base
    environment:
      - AGENT_SERVER_IMAGE_REPOSITORY=ghcr.io/openhands/agent-server
      - AGENT_SERVER_IMAGE_TAG=1.28.0-python
```

- App 容器通过挂载 docker.sock 动态拉起 agent-server 沙箱
- 多后端切换：Docker / E2B / Modal / Daytona / K8s
- 会话租约 + 资源锁实现并发安全
- 企业版（`enterprise/`，独立 license）

### Octopus

```bash
# 多实例隔离开发
pnpm dev                    # 主仓库（3001/3000）
git worktree add .worktrees/feat-xxx ...  # worktree（hash 端口 + 独立 DB）
pnpm prod                   # 生产模式（3099/3098，独立 DB）

# 三种模式
# dev (主仓库):  Server 3001, Web 3000, DB octopus.db
# dev (worktree): Server hash, Web hash+1, DB octopus-{branch}.db
# prod:          Server 3099, Web 3098, DB octopus-prod.db
```

- git worktree + hash 端口 + 独立 SQLite DB 实现多实例隔离
- 无容器化部署（直接 Node.js 进程）
- 无企业版

---

## 十四、总结：相同与不同

### 相同点

1. **都是 AI agent 平台**——都让 LLM 执行实际任务（编码/运维/业务流程）
2. **都有 Skills 系统**——文件级 skill 定义 + 加载机制
3. **都支持 MCP**——Model Context Protocol 集成
4. **都有 Server + 前端**——REST API + Web UI
5. **都有事件流/日志**——执行过程可追踪
6. **都支持多 agent**——子代理/委派机制
7. **都有工具系统**——终端/文件/浏览器等

### 核心不同点

| 维度 | OpenHands | Octopus |
|------|-----------|---------|
| **范式** | LLM 自主循环 | DAG 工作流编排 |
| **确定性** | 低（LLM 决策） | 高（DAG + Auto Answers） |
| **语言** | Python | TypeScript |
| **沙箱** | 多后端容器隔离 | 无沙箱（直接执行） |
| **LLM 层** | litellm（100+ provider） | 自研（1 provider，扩展中） |
| **Workflow** | Agent 的一个 Tool | 独立编排引擎 |
| **上下文管理** | Condenser 自动压缩 | 无 |
| **会话恢复** | resume_transcript | 无 |
| **多组织** | 无 | ✅ org 级隔离 |
| **定时调度** | 无 | ✅ scheduler + cron |
| **链式执行** | 无 | ✅ chain-engine |
| **协同编辑** | 无 | ✅ yjs-ws |
| **第三方 agent** | ACP 协议 | 无 |
| **可观测性** | OpenTelemetry 标准 | 自研 |
| **评估基准** | SWE-Bench 77.6% | skill-evaluator 6 点 |
| **仓库结构** | 多仓库拆分 + 独立发版 | 单 monorepo |

---

## 十五、Octopus 值得借鉴的 7 点

1. **LLM RouterLLM + FallbackStrategy**——成本路由（如 plan 用 opus，execute 用 sonnet）与 provider 降级链，Octopus 的 `@octopus/providers` 包可增强
2. **LLMSummarizingCondenser + stuck_detector**——长 agent 节点的上下文自动压缩与卡死检测，提升长工作流稳定性
3. **统一 Event 模型 + 会话恢复**——将 action/observation 统一为 Event，支持工作流断点恢复而非重跑
4. **ACP 协议**——接入第三方 agent（Claude Code/Codex/Gemini）作为 AgentExecutor 的备选执行后端
5. **多沙箱后端抽象**——至少支持 Docker 作为可选沙箱，特别是 AgentExecutor 执行 LLM 生成代码时
6. **OpenTelemetry 标准导出**——对接现有可观测性基础设施（OTLP），替代自研 observability
7. **Critic 机制**——agent 节点自评审，在工作流的 review/review-fix 节点中引入自我审查

---

## 十六、Octopus 的独有优势

1. **确定性 DAG 工作流**——可重复、可审计、可无人值守
2. **Auto Answers**——全局+节点级预设答案，实现真正无人值守
3. **多组织隔离**——org 级配置/DB/MCP 隔离
4. **链式执行**——工作流串联（prd-forge → prd-impl → s2-cr-flow）
5. **定时调度**——cron + scheduler
6. **协同编辑**——yjs-ws WebSocket
7. **Skill 生命周期**——5 步创建 + 6 点验证 + 经验进化
8. **单 monorepo**——开发体验统一，包间依赖简洁

---

## 附录：OpenHands 关键源码索引

| 关注点 | 位置 |
|--------|------|
| SDK 公共 API | `openhands/sdk/__init__.py` |
| Agent 类 | `openhands/sdk/agent/agent.py`（50KB） |
| AgentBase 抽象 | `openhands/sdk/agent/base.py`（38KB） |
| ACPAgent（第三方 agent） | `openhands/sdk/agent/acp_agent.py`（173KB） |
| 并行执行器 | `openhands/sdk/agent/parallel_executor.py`（11.5KB） |
| Critic mixin | `openhands/sdk/agent/critic_mixin.py`（5.2KB） |
| Conversation 运行时 | `openhands/sdk/conversation/` |
| 会话状态 | `openhands/sdk/conversation/state.py`（25.9KB） |
| 卡死检测 | `openhands/sdk/conversation/stuck_detector.py`（12KB） |
| 事件存储 | `openhands/sdk/conversation/event_store.py`（9.6KB） |
| 会话恢复 | `openhands/sdk/event/resume_transcript.py`（15.8KB） |
| Event 体系 | `openhands/sdk/event/` |
| LLM 主类 | `openhands/sdk/llm/llm.py`（115KB） |
| LLM 注册表 | `openhands/sdk/llm/llm_registry.py`（5.6KB） |
| LLM 路由 | `openhands/sdk/llm/router/`（RouterLLM） |
| 降级策略 | `openhands/sdk/llm/fallback_strategy.py`（5.5KB） |
| 消息类型 | `openhands/sdk/llm/message.py`（25.3KB） |
| Tool 系统 | `openhands/sdk/tool/` |
| MCP 集成 | `openhands/sdk/mcp/` |
| 上下文压缩 | `openhands/sdk/context/condenser/` |
| Agent 配置 | `openhands/sdk/settings/` |
| Workspace | `openhands/sdk/workspace/` |
| 子 agent 注册 | `openhands/sdk/subagent/` |
| Skills | `openhands/sdk/skills/` |
| Agent Server | `openhands-agent-server/openhands/agent_server/` |
| 会话服务 | `agent_server/conversation_service.py`（57KB） |
| 事件服务 | `agent_server/event_service.py`（55KB） |
| WebSocket | `agent_server/sockets.py`（20KB） |
| Bash 服务 | `agent_server/bash_service.py`（18.7KB） |
| 会话租约 | `agent_server/conversation_lease.py`（10.2KB） |
| Workflow Tool | `openhands-tools/openhands/tools/workflow/` |
| 内置 Tools | `openhands-tools/openhands/tools/` |
