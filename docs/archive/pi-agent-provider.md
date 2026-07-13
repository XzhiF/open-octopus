# Pi Agent Provider 架构文档

> Pi Agent Provider 使 Octopus 工作流引擎能够通过 Pi SDK 调用 dashscope/qwen 等非 Anthropic 模型，
> 与 Claude SDK Provider 并行，共享同一套工作流 YAML 定义。
> 本文档涵盖架构、自定义 Provider 扩展设计、已知限制与问题排查记录。

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

---

## 2. Provider 路由

### 选择优先级

```
node.engine > workflow.engine > "claude"（默认）
```

- **Workflow 级**：`engine: pi` 决定 providers map 加载哪些 provider
- **Node 级**：`engine: pi` 可覆盖 workflow 级设置
- **CLI 级**：`--engine pi` 覆盖 workflow 级设置

### models.yaml Tier 别名

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

---

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

---

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

---

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

---

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

---

## 7. 会话管理

`SessionCache` 管理 Pi SDK `AgentSession` 生命周期：

- **缓存策略**：按 `cwd` 或 `cwd:resumeSessionId` 缓存
- **最大会话数**：可配置（默认 10）
- **空闲超时**：可配置（默认 30 分钟）
- **去重**：并发创建同一 key 时共享 Promise

---

## 8. 安全

- **环境变量白名单**：`buildSessionEnv()` 只透传 `DASHSCOPE_*`、`ANTHROPIC_*` 等前缀
- **命令黑名单**：`octopus-hooks` extension 拦截危险 bash 命令（`rm -rf /`、`sudo`、`bash -c` 等）
- **Sub-agent 嵌套**：限制 depth=1，防止无限递归

---

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

---

## 10. 自定义 Provider 扩展（custom_providers）

### 设计目标

1. 用户在 `models.yaml` 声明 provider（baseUrl + api 协议 + 模型列表）
2. Adapter 加载配置，自动注册到 Pi SDK ModelRegistry
3. 内置 provider（anthropic、openai 等）只需 API Key，无需 YAML 配置
4. 向后兼容：现有 `EXTRA_PROVIDERS` 作为 fallback，YAML 配置优先覆盖

### YAML 结构

```yaml
# ~/.octopus/models.yaml

default: pro

# ─── Tier 别名（现有功能，不变）───
providers:
  pi:
    pro-max: dashscope/qwen3.7-max
    pro: dashscope/qwen3.7-plus
    se: dashscope/qwen3.6-plus
  claude:
    pro-max: opus
    pro: sonnet
    se: haiku

# ─── Provider 注册（新增）───
# 用于非内置的 OpenAI-compatible provider
# 内置 provider（anthropic/openai/google 等）不需要在这里配置，只需环境变量
custom_providers:
  dashscope:
    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
    api: openai-completions
    env_key: DASHSCOPE_API_KEY          # 环境变量名（可选，默认大写 provider_name + _API_KEY）
    models:
      - id: qwen3.7-max
        name: Qwen 3.7 Max
        context_window: 131072
        max_tokens: 16384
      - id: qwen3.7-plus
        name: Qwen 3.7 Plus
        context_window: 131072
        max_tokens: 16384

  # ─── 扩展示例：DeepSeek ───
  deepseek:
    base_url: https://api.deepseek.com/v1
    api: openai-completions
    models:
      - id: deepseek-chat
        name: DeepSeek Chat
        context_window: 65536
        max_tokens: 8192
      - id: deepseek-reasoner
        name: DeepSeek Reasoner
        reasoning: true
        context_window: 65536
        max_tokens: 8192

  # ─── 扩展示例：本地 Ollama ───
  ollama:
    base_url: http://localhost:11434/v1
    api: openai-completions
    env_key: OLLAMA_API_KEY             # 本地可以设空值
    models:
      - id: llama3.1:70b
        name: Llama 3.1 70B
        context_window: 131072
        max_tokens: 4096
```

### 字段说明

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `base_url` | ✅ | — | API 端点 |
| `api` | ✅ | — | API 协议，目前只支持 `openai-completions` |
| `env_key` | ❌ | `{PROVIDER_NAME}_API_KEY`（大写） | 环境变量名 |
| `models[].id` | ✅ | — | 模型 ID（API 使用的标识） |
| `models[].name` | ❌ | 同 id | 显示名称 |
| `models[].context_window` | ❌ | 32768 | 上下文窗口大小 |
| `models[].max_tokens` | ❌ | 8192 | 最大输出 tokens |
| `models[].reasoning` | ❌ | false | 是否推理模型 |
| `models[].cost` | ❌ | 全 0 | `{ input, output, cacheRead, cacheWrite }` |

### 加载流程

```
models.yaml 加载
  → 解析 custom_providers 段
  → 对每个 provider:
    1. 从 env 取 API Key（env_key 或默认）
    2. 无 key → 跳过（不报错，只是不可用）
    3. 有 key → 注册到 ModelRegistry
  → 与 EXTRA_PROVIDERS 合并（YAML 优先覆盖同名 provider）
```

### 改动范围

| 文件 | 改动 |
|------|------|
| `shared/src/config/model-alias.ts` | Schema 加 `custom_providers` 段 |
| `providers/src/pi/pi-sdk-adapter.ts` | `registerProvidersFromEnv` 接受外部 provider 配置 |
| `providers/src/pi/provider.ts` | 加载 `custom_providers` 传给 adapter |

---

## 11. 已知限制

| 限制 | 说明 |
|------|------|
| Qwen se 模型工具调用不稳定 | qwen3.6-plus 有时跳过工具调用或陷入死循环，pro 模型正常 |
| Sub-agent 嵌套 depth=1 | 最多一层委派，Claude SDK 支持 5 层 |
| 无 Background 执行 | Sub-agent 同步执行，不支持异步后台（workflow 层有 DAG 并行） |
| 无 Resume 能力 | Sub-agent 无法恢复之前的 session |
| Pi SDK 版本锁定 | `>=0.80.3 <0.82.0`，升级需验证兼容性 |

---

## 12. 问题排查记录

> 实施过程中发现的问题、根因分析与修复方案。
> 时间：2026-07-06 | Commits：`4cf2086` → `957f1ba` → `9a23aa4`

### P1: Provider 路由不生效

**现象**：Workflow 设置 `engine: pi`，实际仍走 Claude SDK Provider。

**根因**：5 处代码硬编码 fallback `"claude"`，未读取 `workflow.engine`。

**修复**：

| 文件 | 修复 |
|------|------|
| `engine.ts` | `node.engine ?? this.workflow.engine ?? "claude"` |
| `swarm.ts` | 构造函数加 `workflowEngine` 参数 |
| `loop.ts` | 同上 |
| `ExecutionLifecycle.ts` | `resolveProviders` 追加 `workflow.engine` |
| `server/index.ts` | 去掉 `OCTOPUS_ENABLE_PI` feature flag |

**验证**：Server stdout 打印 `[PiProvider] sendQuery called`。

---

### P2: 模型自称 Claude

**现象**：Qwen 模型通过 Pi SDK 运行时回答 "I am Claude, made by Anthropic"。

**排查过程**（6 组对照实验 `test-pi-exact.mjs`）：

| 条件 | 结果 |
|------|------|
| 直接 API（无 prompt） | "I am Qwen" ✅ |
| 短 prompt + tools | "coding assistant" ✅ |
| **完整 Pi SDK prompt + tools** | **"I am Claude"** ❌ |
| Tools 写在 prompt 文本（无 API tools） | "I am Claude" ❌ |
| Tools 在 prompt + API tools 同时存在 | "I am Qwen" ✅ |

**根因**：Pi SDK system prompt 中 `Available tools: read, bash, edit, write` 文本格式触发 qwen 的 Claude 训练模式。

**修复**：`resolveSystemPrompt()` 注入 Octopus identity 规则，通过 `resourceLoader.getSystemPrompt()` 覆写持久化。

**关键技术点**：
- `createAgentSession` 忽略 `options.systemPrompt`
- 直接设 `agent.state.systemPrompt` 被 `_rebuildSystemPrompt()` 覆盖
- 必须通过 `resourceLoader.getSystemPrompt()` 注入

---

### P3: 工具调用日志为空

**现象**：日志中 `tool_call` 无参数，`tool_result` 为空字符串。但实际工具执行成功。

**根因**：`event-mapper.ts` 字段名与 Pi SDK agent-core 不匹配。

| Pi SDK 实际 | Mapper 使用 | 结果 |
|------------|-----------|------|
| `e.toolCallId` | `e.id` | undefined |
| `e.args` | `e.input` | undefined |
| `e.result` | `e.output` | undefined |

**修复**：使用 `e.toolCallId ?? e.id` 兼容两种格式。

---

### P4: Sub-Agent 工具未注册

**现象**：模型报告 "I don't have delegation tools available"。

**根因**：Sub-agent 作为 `extensions` 传给 `createAgentSession`，但 Pi SDK 期望 `customTools`。两者是完全不同的机制。

**修复**：
- `toSubAgentTool()` 返回 Pi SDK 兼容的工具定义格式（name/parameters/execute）
- adapter 传 `customTools` 而非 `extensions`

---

### P5: Skills 未注入

**现象**：模型无法看到 `.claude/skills/` 中定义的 skills。

**根因**：两层问题：
1. `noSkills: true` 禁用了 Pi SDK 原生 skill 加载
2. `resourceLoader.reload()` 未被调用（`createAgentSession` 只在自行创建 resourceLoader 时调用 reload）

**修复**：
- `noSkills: false`
- `agentDir: .claude`（从 `.pi-agent` 改为 `.claude`）
- 手动 `await resourceLoader.reload()`

---

### P6: prod.mjs Health Check 404

**现象**：`pnpm prod` 启动后 health check 返回 404。

**根因**：`prod.mjs` 请求 `/api/health`，但 server 实际端点是 `/api/actuator/health`（actuator 重构后路径变更）。

**修复**：URL 改为 `/api/actuator/health`，响应映射对齐 `dev.mjs`。

---

### P7: Sub-Agent System Prompt 未生效

**现象**：Sub-agent 没有使用 `def.prompt` 作为 system prompt，而是拼到 user message。

**根因**：`toSubAgentTool` 的 `execute()` 将 prompt 拼成 `${def.prompt}\n\nTask: ${args.task}` 作为 user message 发送，未设置 system prompt。

**修复**：
- `createSession({ systemPrompt: def.prompt })` — prompt 作为 system prompt
- `promptSession(session, args.task)` — user message 只发 task

---

### P8: Sub-Agent 工具限制无效

**现象**：`tools: [Read, Grep]` 定义的只读 sub-agent 仍能使用 bash。

**根因**：`def.tools` 未传给子 session 的 `createAgentSession`。

**修复**：
- adapter `SessionOptions` 加 `tools?: string[]`
- `toSubAgentTool` 将 PascalCase 映射为 lowercase 后传入
- `createAgentSession({ tools: opts.tools })`

---

### P9: Sub-Agent Skills 未透传

**现象**：`skills: [octo-workflow-dev]` 指定的 skill 在 sub-agent 中不可见。

**根因**：`def.skills` 未传给子 session。

**修复**：`createSession({ skills: def.skills })` 透传到 adapter 的 skills 过滤。
