# 第八章：可行性验证与风险修正

> 基于对 Pi 源码的二次验证，修正前 7 章设计中的可行性和风险判断。

---

## 8.1 三项关键验证结果

### ✅ Pi 包已发布到 npm

| 包 | npm 版本 | 状态 |
|---|---|---|
| `@earendil-works/pi-ai` | 0.80.3 | ✅ 已发布 |
| `@earendil-works/pi-agent-core` | 0.80.3 | ✅ 已发布 |
| `@earendil-works/pi-coding-agent` | 0.80.3 | ✅ 已发布 |

**结论**：可直接 `pnpm add`，无需 `file:` 引用或 git submodule。第六章的"风险 1"可删除。

### ✅ Pi 支持完整的 Session Resume

验证了 Pi 的 session 恢复 API：

| 能力 | API | 存在 |
|------|-----|------|
| 按文件路径恢复 | `SessionManager.open(path)` | ✅ |
| 按 session ID 恢复 | `resolveSessionPath(id)` → prefix match → `open()` | ✅ |
| 恢复最近 session | `SessionManager.continueRecent(cwd)` | ✅ |
| SDK 层恢复 | `createAgentSession({ sessionManager: preOpenedManager })` | ✅ |
| 运行时切换 | `AgentSessionRuntime.switchSession(path)` | ✅ |

**结论**：第四章 4.4 节的 Session Resume **完全可行**。但设计需要修正（见 8.3 节）。

### ✅ Pi 支持 Headless 模式

验证结果：
- `createAgentSession()` + `session.prompt()` 路径中**零终端依赖**
- `agent-session.ts` 无 `process.stdin`、`readline`、TUI import
- 已有 `print-mode.ts` 作为非交互模式的先例
- 可通过 `DefaultResourceLoader({ noExtensions: true })` 禁用磁盘扩展加载

**结论**：Pi 在服务端进程中运行完全没有问题。

---

## 8.2 无阻塞项的设计

以下模块经验证**没有任何实现障碍**：

| 模块 | 章节 | 验证结果 |
|------|------|----------|
| AsyncEventBridge | 3.3 | 标准 push→pull 模式，纯 TypeScript，无外部依赖 |
| EventMapper | 3.4 | Pi 事件类型完整覆盖 Octopus 所需，映射表完备 |
| TokenAggregator | 3.7 | 纯计算，Pi 的 `Usage` 类型有 `cost` 字段 |
| ModelResolver | 3.5 | `ModelRegistry.find(provider, id)` API 存在 |
| Model Alias | 7 | 纯字符串映射，与 Pi 无关，零风险 |
| 子代理工具 | 4.1 | `createAgentSession()` 可嵌套调用 |
| 技能注入 | 4.2 | 直接拼接到 prompt 文本即可 |
| Auto Answers | 4.3 | 已在 prompt 中，无需处理 |
| Goal Mode | 4.5 | 已在 prompt 中，无需处理 |
| 变量系统 | 4.6 | 已在 prompt 中，无需处理 |
| Abort 信号 | 4.8 | `session.abort()` API 存在 |
| SwarmExecutor 兼容 | 4.9 | 最小事件集 `text_delta` + `result` 可产出 |
| Headless 运行 | — | 零终端依赖，`noExtensions: true` 可用 |

---

## 8.3 需要修正的设计

### 修正 1：Session Resume 实现方式（第四章 4.4 节）

**原设计**（不够精确）：
```typescript
const restored = await createAgentSession({ cwd })
// TODO: 需要 Pi API 支持加载特定 session ID 的历史
```

**修正后**（基于验证的真实 API）：
```typescript
// 1. 用 session ID 查找 JSONL 文件路径
// Pi 的 resolveSessionPath() 支持 prefix match
import { SessionManager } from '@earendil-works/pi-coding-agent'

// 方案 A：用 continueRecent 恢复 cwd 最近的 session
const sessionManager = SessionManager.continueRecent(cwd)

// 方案 B：用 open 恢复指定文件
const sessionManager = SessionManager.open(sessionFilePath)

// 方案 C：用 SessionManager.list() 按 ID 查找
const sessions = await SessionManager.list(cwd)
const match = sessions.find(s => s.id === resumeSessionId
                              || s.id.startsWith(resumeSessionId))
const sessionManager = match
  ? SessionManager.open(match.path)
  : SessionManager.create(cwd)

// 2. 传入预加载的 sessionManager
const { session } = await createAgentSession({
  cwd,
  sessionManager,  // ← 关键：传入预打开的 SessionManager
})

// createAgentSession 会检测已有数据并恢复：
// - 恢复 messages 到 agent.state.messages
// - 恢复 model 和 thinkingLevel
```

**Octopus Session ID → Pi Session 的映射问题**：

Octopus 的 `resumeSessionId` 是 `AgentNodeRunner` 从上一次 `result` chunk 中提取的 `sessionId`。ClaudeSDKProvider 返回的是 Claude SDK 的 session ID。Pi 返回的是 Pi 自己的 session ID（UUID 格式）。

两者格式不同，但**不需要兼容**——因为 `engine: claude` 和 `engine: pi` 是不同的 provider，不会交叉 resume。只需确保 Pi Provider 返回的 `sessionId` 是 Pi 的 session ID（从 `session.sessionId` 获取）。

### 修正 2：Headless 模式需要禁用磁盘扩展（第三章 3.6 节）

**原设计**（遗漏）：
```typescript
result = await createAgentSession({ cwd })
```

**修正后**（必须禁用磁盘扩展）：
```typescript
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent'

const loader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
  noExtensions: true,     // ← 不加载 ~/.pi/agent/extensions/ 中的扩展
  noSkills: true,         // ← 不加载 Pi 的 skills（Octopus 有自己的）
  noContextFiles: true,   // ← 不加载 AGENTS.md / CLAUDE.md
  noPromptTemplates: true,
  noThemes: true,
})
await loader.reload()

result = await createAgentSession({
  cwd,
  resourceLoader: loader,  // ← 传入自定义 loader
})
```

**为什么要禁用**：
- Pi 默认从 `~/.pi/agent/extensions/` 和 `cwd/.pi/extensions/` 加载 TypeScript 扩展
- 如果用户同时安装了 Pi CLI，磁盘上可能有 Pi 扩展，会干扰 Octopus 行为
- Octopus 的技能、子代理、auto answers 通过自己的机制注入，不需要 Pi 的扩展系统

### 修正 3：provider.ts 主类补充 headless 配置

第三章 3.6 节的 `PiAgentProvider` 类 `getOrCreateSession()` 方法需修正：

```typescript
private async getOrCreateSession(
  cwd: string,
  options?: SendQueryOptions,
  resumeSessionId?: string,
): Promise<CreateAgentSessionResult> {
  const cacheKey = `${cwd}:${resumeSessionId ?? 'new'}`
  let result = this.sessionCache.get(cacheKey)
  if (result) return result

  // 构建 headless resource loader
  const loader = new DefaultResourceLoader({
    cwd,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
  })
  await loader.reload()

  // Session 恢复
  let sessionManager: SessionManager | undefined
  if (resumeSessionId) {
    const sessions = await SessionManager.list(cwd)
    const match = sessions.find(s =>
      s.id === resumeSessionId || s.id.startsWith(resumeSessionId)
    )
    sessionManager = match
      ? SessionManager.open(match.path)
      : undefined
  }

  result = await createAgentSession({
    cwd,
    resourceLoader: loader,
    sessionManager,
    customTools: options?.agents
      ? createSubAgentTools(options.agents, cwd, options)
      : [],
  })

  this.sessionCache.set(cacheKey, result)
  return result
}
```

---

## 8.4 存在但可控的风险

### 风险 1：Pi 工具质量 vs Claude Code 工具

**问题**：Pi 的 Bash/Read/Write/Edit/Grep/Find/Ls 是 Pi 团队重写的实现，不如 Claude Code SDK 的内置工具成熟。具体差异：

| 工具 | Claude Code SDK | Pi | 差异 |
|------|----------------|-----|------|
| Bash | 沙箱隔离、超时、权限检查 | 直接 child_process spawn | Pi 更简单 |
| Edit | 精确替换 + diff 预览 | 字符串替换 | 类似 |
| Read | 自动截断 + 行号 | 文件读取 | 类似 |
| Write | 创建/覆盖 + 目录创建 | 文件写入 | 类似 |

**影响**：工具执行结果可能不如 Claude Code 精确，但不影响核心流程。
**缓解**：首版可接受，后续可通过 Pi 的 `afterToolCall` hook 添加安全检查。

### 风险 2：vars_update 格式遵循度

**问题**：Octopus 的 `parseVarsUpdate()` 依赖 agent 输出包含特定 JSON 格式：
```
{"vars_update": {"key": "value"}}
```

这个指令在 prompt 中，不同 LLM 遵循指令的能力不同：
- Claude (via ClaudeSDKProvider) — 高度遵循
- GPT-4o (via Pi) — 可能不遵循
- DeepSeek (via Pi) — 可能不遵循

**影响**：非 Anthropic 模型可能无法正确传递变量。
**缓解**：
1. 在 prompt 中强调格式要求（已有）
2. 增加 `parseVarsUpdate()` 的容错性（放宽 JSON 匹配）
3. 对非 Anthropic 模型，添加更明确的 few-shot 示例

### 风险 3：maxBudgetUsd 不支持

**问题**：`SendQueryOptions.maxBudgetUsd` 是预算上限。ClaudeSDKProvider 通过 SDK 的 `maxBudgetUsd` 参数实现。Pi 的 `createAgentSession()` 和 `session.prompt()` **没有预算参数**。

**影响**：Pi Provider 无法在超出预算时自动停止。
**缓解**：
- 方案 A：在 `agent_end` 事件中检查累计 cost，超出后在下一个 prompt 前停止
- 方案 B：通过 `shouldStopAfterTurn` 钩子检查 `TokenAggregator.totalCost()`
- 方案 C：首版不实现（记录为已知限制）

**推荐方案 B**：
```typescript
// 在 createAgentSession 的 agent options 中
agent.shouldStopAfterTurn = (context) => {
  if (options?.maxBudgetUsd && tokenAggregator.totalCost() > options.maxBudgetUsd) {
    return true  // 停止循环
  }
  return false
}
```

### 风险 4：Pi 扩展磁盘加载

**问题**：默认会加载 `~/.pi/agent/extensions/` 中的扩展。
**状态**：✅ 已在修正 2 中解决（`noExtensions: true`）。

### 风险 5：TypeBox vs Zod

**问题**：Pi 内部用 TypeBox 定义工具参数 schema，Octopus 用 Zod。
**影响**：无。两者不直接交互。Pi 的工具 schema 在 Pi 内部使用，Octopus 的 schema 在 Octopus 内部使用。接口边界是 `MessageChunk` 联合类型，两者都用 TypeScript 原生类型。
**状态**：✅ 非风险。

---

## 8.5 确认不存在的问题

以下在第六章风险清单中标记的项目，经验证**不构成问题**：

| 原标记风险 | 验证结果 |
|---|---|
| Pi 包未发布到 npm | ✅ 已发布 0.80.3 |
| Node 版本冲突 | ✅ Octopus 无 engines 限制 |
| Session 持久化格式不兼容 | ✅ Pi 有完整的 session open/resume API |
| pi-coding-agent 需要 TUI | ✅ 核心路径零终端依赖 |
| ESM/CJS 兼容 | ✅ Pi 用 Node16 module，与 Octopus 一致 |

---

## 8.6 最终风险矩阵

| 风险 | 严重度 | 概率 | 缓解 | 状态 |
|------|--------|------|------|------|
| Pi 工具质量不如 Claude Code | 中 | 高 | 首版可接受，后续 hook 加固 | 可控 |
| 非 Anthropic 模型不遵循 vars_update | 中 | 中 | prompt 强化 + 容错解析 | 可控 |
| maxBudgetUsd 不原生支持 | 低 | 高 | shouldStopAfterTurn 钩子 | 可控 |
| 子代理 session 创建开销大 | 低 | 中 | session 池化（后续优化） | 可控 |
| Pi 版本更新破坏接口 | 中 | 低 | 锁定 0.80.3 + 升级测试 | 可控 |

---

## 8.7 实测验证（DashScope qwen3-max）

> 测试日期：2026-07-03
> 测试文件：`packages/providers/src/__tests__/pi-streaming-dashscope.test.ts`
> LLM：阿里云百炼 DashScope / qwen3-max（OpenAI-compatible API）

### 三层全链路测试结果

| 测试 | 层 | 耗时 | 事件数 | 结果 |
|------|---|------|--------|------|
| pi-ai streamSimple | Layer 1：纯 LLM 协议 | 1.2s | 12 | ✅ 全部通过 |
| pi-agent-core Agent | Layer 2：Agent 循环 | 1.9s | 32 | ✅ 全部通过 |
| pi-coding-agent AgentSession | Layer 3：完整 Session | 1.8s | 31 | ✅ 全部通过 |

### 验证的事件类型清单

**Layer 1 — pi-ai AssistantMessageEvent（5 种）**：
```
start: 1, text_start: 1, text_delta: 8, text_end: 1, done: 1
```
- ✅ `start` — 流开始
- ✅ `text_delta` — 文本增量流式输出（8 个 chunk，实时打印到 stdout）
- ✅ `done` — 流结束，含 reason="stop"
- ✅ `usage` — input=24, output=37, totalTokens=61

**Layer 2 — pi-agent-core AgentEvent（10 种）**：
```
agent_start: 1, turn_start: 2, message_start: 4, message_update: 14,
message_end: 4, tool_execution_start: 1, tool_execution_update: 2,
tool_execution_end: 1, turn_end: 2, agent_end: 1
```
- ✅ **agent_start / agent_end** — Agent 生命周期
- ✅ **turn_start / turn_end** — Turn 生命周期（2 轮：第 1 轮调工具，第 2 轮输出结果）
- ✅ **message_start / message_update / message_end** — LLM 消息流（4 条消息 = user + assistant + tool_result + assistant）
- ✅ **tool_execution_start / update / end** — bash 工具完整执行链
- ✅ **工具自主调用** — LLM 自主决定调用 bash 工具执行 `echo "hello from pi × dashscope"`

**Layer 3 — pi-coding-agent AgentSessionEvent（10 种）**：
```
agent_start: 1, turn_start: 2, message_start: 4, message_update: 13,
message_end: 4, tool_execution_start: 1, tool_execution_update: 2,
tool_execution_end: 1, turn_end: 2, agent_end: 1
```
- ✅ 包含 Layer 2 的全部事件类型
- ✅ Session ID 生成：`019f25ef-5db0-7de5-9ba5-42e75366db32`
- ✅ 消息持久化：`session.messages.length === 4`
- ✅ Headless 运行：无 TUI 依赖，纯 API 调用
- ⚠️ `entry_appended` 仅在文件持久化模式下触发（in-memory session 不触发）

### 关键发现与注意事项

#### ⚠️ 发现 1：API Key 注入方式（必须用 ModelRegistry）

**错误方式**（实测无效）：
```typescript
const { session } = await createAgentSession({ cwd, model })
session.agent.getApiKey = async () => apiKey  // ← 无效！
```

**原因**：`createAgentSession()` 内部构建 `streamFn` 时，闭包捕获了 `ModelRegistry`。后续的 `agent.getApiKey` 覆盖不影响已有的 `streamFn`。

**正确方式**：
```typescript
import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent'

const authStorage = AuthStorage.inMemory()
const modelRegistry = ModelRegistry.inMemory(authStorage)

modelRegistry.registerProvider('dashscope', {
  name: 'DashScope',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
  api: 'openai-completions',
  models: [{ id: 'qwen3-max', name: 'Qwen Max', ... }],
})

const { session } = await createAgentSession({
  cwd,
  model,
  modelRegistry,  // ← 传入预配置的 registry
})
```

> 第三章 3.6 节的 `provider.ts` 代码已同步修正。

#### ⚠️ 发现 2：Headless 模式需禁用磁盘扩展

**问题**：`createAgentSession()` 默认从 `~/.pi/agent/extensions/` 和 `cwd/.pi/extensions/` 加载 TypeScript 扩展。如果用户同时安装了 Pi CLI，磁盘上的扩展会干扰 Octopus 行为。

**解决**：
```typescript
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent'

const loader = new DefaultResourceLoader({
  cwd,
  noExtensions: true,       // 关键：禁用磁盘扩展
  noSkills: true,           // 禁用 Pi skills（Octopus 有自己的）
  noContextFiles: true,     // 禁用 AGENTS.md / CLAUDE.md
  noPromptTemplates: true,
  noThemes: true,
})
await loader.reload()

const { session } = await createAgentSession({
  cwd,
  resourceLoader: loader,  // ← 传入自定义 loader
})
```

#### ⚠️ 发现 3：自定义提供商注册模板

以下是注册常见提供商到 Pi ModelRegistry 的模板，已在实测中验证 DashScope 可用：

```typescript
const PROVIDER_ENV_MAP = {
  anthropic:  { envKey: 'ANTHROPIC_API_KEY',  api: 'anthropic-messages' },
  openai:     { envKey: 'OPENAI_API_KEY',     api: 'openai-responses' },
  google:     { envKey: 'GOOGLE_API_KEY',     api: 'google-generative-ai' },
  deepseek:   { envKey: 'DEEPSEEK_API_KEY',   api: 'openai-completions' },
  dashscope:  { envKey: 'DASHSCOPE_API_KEY',  api: 'openai-completions' },
  xai:        { envKey: 'XAI_API_KEY',        api: 'openai-completions' },
  mistral:    { envKey: 'MISTRAL_API_KEY',    api: 'mistral-conversations' },
}

for (const [providerId, config] of Object.entries(PROVIDER_ENV_MAP)) {
  const apiKey = process.env[config.envKey]
  if (apiKey) {
    modelRegistry.registerProvider(providerId, {
      name: providerId,
      apiKey,
      api: config.api,
      // baseUrl 由 Pi 内置的提供商定义自动填充
    })
  }
}
```

#### ⚠️ 发现 4：ESM-only 包

Pi 三个包均为 `"type": "module"`，只导出 `"import"` 入口：
```json
{ "type": "module", "exports": { ".": { "import": "./dist/index.js" } } }
```

- Vitest 原生支持 ESM，测试中 `import` 语句正常工作
- 如需在 CJS 上下文中使用，必须用 `await import()` 动态加载
- `pnpm add` 安装后，包位于 `node_modules/.pnpm/` 下（pnpm symlink 结构）

### 运行测试

```bash
# 前置条件
export DASHSCOPE_API_KEY="sk-xxx"

# 运行
pnpm --filter @octopus/providers test -- --run pi-streaming-dashscope

# 预期输出
# ✓ pi-ai: streamSimple 产出 AssistantMessageEvent 流     ~1.2s
# ✓ pi-agent-core: Agent loop 产出 AgentEvent 流（含工具调用） ~1.9s
# ✓ pi-coding-agent: AgentSession 完整流程                  ~1.8s
# Test Files  1 passed (1)
#      Tests  3 passed (3)
```


**结论：没有实现不了的阻塞项。** 所有核心功能都有可行的实现路径。最大的不确定性是**非 Anthropic 模型的 prompt 遵循度**，但这是 LLM 行为的固有限制，不是集成架构的问题。
