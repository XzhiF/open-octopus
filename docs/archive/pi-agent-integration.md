# Pi Agent Provider 架构文档

> Pi Agent Provider 使 Octopus 工作流引擎能够通过 Pi SDK 调用 dashscope/qwen 等非 Anthropic 模型，
> 与 Claude SDK Provider 并行，共享同一套工作流 YAML 定义。

---

## 1. 整体架构

```
Workflow YAML
  engine: pi | claude        ← workflow 级 provider 选择
  model: pro | pro-max | se  ← 模型 tier 别名
  ┌──────────────────────────────────────────────────┐
  │                   Engine 层                       │
  │  resolveProviders() → { pi: PiAgentProvider }    │
  │  resolveAgents()    → agent_file 解析 + 合并      │
  │  createExecutor()   → node.engine ?? wf.engine   │
  └──────────────┬───────────────────────────────────┘
                 │ options: { prompt, agents, skills, model }
  ┌──────────────▼───────────────────────────────────┐
  │              PiAgentProvider                      │
  │  resolveSystemPrompt() → Octopus identity 注入    │
  │  toSubAgentTool()      → Pi SDK customTool 格式   │
  │  SessionCache          → 会话复用                  │
  └──────────────┬───────────────────────────────────┘
                 │
  ┌──────────────▼───────────────────────────────────┐
  │            pi-sdk-adapter (隔离层)                 │
  │  resourceLoader → .claude/skills/ 扫描 + 过滤      │
  │  modelRegistry  → dashscope provider 注册          │
  │  createAgentSession({ customTools, tools,         │
  │                       systemPrompt, skills })      │
  │  systemPrompt 覆写 → identity 持久化               │
  └──────────────┬───────────────────────────────────┘
                 │
  ┌──────────────▼───────────────────────────────────┐
  │         @earendil-works/pi-coding-agent           │
  │  AgentSession → agentic loop (LLM ↔ tools)       │
  │  事件流 → AsyncEventBridge → MessageChunks        │
  └──────────────┬───────────────────────────────────┘
                 │
  ┌──────────────▼───────────────────────────────────┐
  │              event-mapper                         │
  │  Pi SDK 事件 → Octopus MessageChunk 格式           │
  │  tool_execution_start/end → tool_call/tool_result │
  └──────────────────────────────────────────────────┘
```

## 2. Provider 路由

### 选择优先级

```
node.engine > workflow.engine > "claude"（默认）
```

- **Workflow 级**：`engine: pi` 决定 providers map 加载哪些 provider
- **Node 级**：`engine: pi` 可覆盖 workflow 级设置
- **CLI 级**：`--engine pi` 覆盖 workflow 级设置

### models.yaml 别名

```yaml
providers:
  pi:
    pro-max: dashscope/qwen3.7-max
    pro:     dashscope/qwen3.7-plus
    se:      dashscope/qwen3.6-plus
  claude:
    pro-max: opus
    pro:     sonnet
    se:      haiku
```

加载路径优先级：`{orgDir}/models.yaml` > `~/.octopus/models.yaml` > 内置默认

## 3. System Prompt 链路

```
Engine agent-runner
  → systemPrompt: { type: "preset", preset: "claude_code" }
    │
    ▼
PiAgentProvider.resolveSystemPrompt()
  → 注入 Octopus identity 规则文本
  → 返回 identity + user append
    │
    ▼
adapter.createSession({ systemPrompt })
  → resourceLoader.getSystemPrompt 覆写
  → 原始 prompt + "\n\n" + identity 文本
    │
    ▼
_rebuildSystemPrompt() 使用 resourceLoader 的返回值
  → 持久注入到 agent.state.systemPrompt
```

**Octopus Identity 规则：**
> When asked about your identity: you are an Octopus AI model (pro-max/pro/se tier),
> powered by the Octopus platform. Do not claim to be Claude, GPT, or any other model.

## 4. Sub-Agent 机制

### 定义方式

Workflow YAML 中通过 `agents` 字段定义：

```yaml
nodes:
  - id: orchestrator
    type: agent
    agents:
      code-reviewer:
        description: "代码审查专家"
        prompt: "你是一个代码审查专家..."
        tools: [Read, Grep]
        skills: [chinese-code-review]
        model: pro
      math-expert:
        agent_file: ".claude/agents/math-expert.md"  # Engine 层解析 frontmatter
```

### 执行流程

```
Engine resolveAgents()
  → agent_file: 读取 .md → 解析 frontmatter → 合并到 agent def
  → 传给 provider 的 options.agents
    │
    ▼
PiAgentProvider.sendQuery()
  → toSubAgentTool(name, def, cwd) → Pi SDK customTool 格式
    │
    ▼
customTools 注册到 Pi SDK session
  → 模型看到 delegate_to_{name} 工具
  → 调用时触发 execute()
    │
    ▼
execute() 创建独立子 session
  → systemPrompt: def.prompt
  → tools: def.tools（PascalCase → lowercase）
  → skills: def.skills（过滤）
  → promptSession(session, task)
  → 提取最后 assistant text → 返回 tool result
```

### AgentDefinition 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `description` | string | 模型据此决定何时委派 |
| `prompt` | string | Sub-agent 的 system prompt |
| `tools` | string[] | 可用工具（PascalCase，映射为 lowercase） |
| `skills` | string[] | Skill 名称过滤 |
| `model` | string | 模型 tier 或完整 ID |
| `agent_file` | string | `.md` 文件路径（Engine 层解析） |

## 5. Skills 系统

### 发现

Pi SDK `DefaultResourceLoader` 从以下目录扫描 `SKILL.md`：
- `{cwd}/.claude/skills/*/SKILL.md` — 工作空间级
- `~/.claude/skills/*/SKILL.md` — 用户级

### 注入

`formatSkillsForPrompt()` 在 system prompt 末尾注入 XML 列表：

```xml
<available_skills>
  <skill>
    <name>octo-dev-copilot</name>
    <description>Octopus 微服务生态编码助手...</description>
    <location>.claude/skills/octo-dev-copilot/SKILL.md</location>
  </skill>
</available_skills>
```

模型通过 `read` 工具按需加载完整内容（渐进式披露）。

### 过滤

Workflow YAML `skills` 字段控制可见性（对齐 Claude Agent SDK）：

| `skills` 值 | 行为 |
|-------------|------|
| 不传 | 所有发现的 skills 可见 |
| `["a", "b"]` | 仅指定 skills 可见 |
| `[]` | 无 skill 可见 |

## 6. 事件映射

Pi SDK `agent-core` 事件 → Octopus `MessageChunk` 格式：

| Pi SDK 事件 | 字段 | Octopus Chunk |
|-------------|------|---------------|
| `message_start` | — | `message_start` |
| `message_update` | `assistantMessageEvent` | `text_delta` / `thinking` / `thinking_done` |
| `tool_execution_start` | `toolCallId`, `toolName`, `args` | `tool_call_start` + `tool_call` |
| `tool_execution_update` | `toolCallId`, `elapsedSeconds` | `tool_progress` |
| `tool_execution_end` | `toolCallId`, `result`, `isError` | `tool_result` |
| `agent_end` | `messages`, `usage` | `text_done` + `message_stop` + `result` |

## 7. 会话管理

`SessionCache` 管理 Pi SDK `AgentSession` 生命周期：

- **缓存策略**：按 `cwd` 或 `cwd:resumeSessionId` 缓存
- **最大会话数**：可配置（默认 10）
- **空闲超时**：可配置（默认 30 分钟）
- **去重**：并发创建同一 key 时共享 Promise

## 8. 安全

- **环境变量白名单**：`buildSessionEnv()` 只透传 `DASHSCOPE_*`、`ANTHROPIC_*` 等前缀
- **命令黑名单**：`octopus-hooks` extension 拦截危险 bash 命令（`rm -rf /`、`sudo`、`bash -c` 等）
- **Sub-agent 嵌套**：限制 depth=1，防止无限递归

## 9. 与 Claude SDK Provider 对比

| 维度 | Claude SDK | Pi SDK |
|------|-----------|--------|
| 底层模型 | Anthropic Claude | dashscope/qwen 等多模型 |
| System Prompt | Claude Code 原生 | Pi SDK 默认 + Octopus identity |
| Skills | Claude Code 原生 Skill tool | Pi SDK `formatSkillsForPrompt` + `read` |
| Sub-agents | Agent 工具（内置） | `delegate_to_*` customTools |
| 工具调用 | 原生支持 | Pi SDK → openai-completions API |
| 会话恢复 | 原生支持 | SessionCache（按 cwd） |
| 进程模型 | 子进程 | 进程内 session |

## 10. 已知限制

| 限制 | 说明 |
|------|------|
| Qwen se 模型工具调用不稳定 | qwen3.6-plus 有时跳过工具调用或陷入死循环，pro 模型正常 |
| Sub-agent 嵌套 depth=1 | 最多一层委派，Claude SDK 支持 5 层 |
| 无 Background 执行 | Sub-agent 同步执行，不支持异步后台（workflow 层有 DAG 并行） |
| 无 Resume 能力 | Sub-agent 无法恢复之前的 session |
| Pi SDK 版本锁定 | `>=0.80.3 <0.82.0`，升级需验证兼容性 |
