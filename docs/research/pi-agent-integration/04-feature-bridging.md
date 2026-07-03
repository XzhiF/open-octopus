# 第四章：功能桥接设计

> 本章覆盖 Octopus 工作流特性如何映射到 Pi 的能力：子代理、技能注入、Auto Answers、Session Resume、Goal Mode。

---

## 4.1 子代理（Sub-Agents）桥接

### Octopus YAML 定义

```yaml
agents:
  researcher:
    description: "Deep research expert"
    prompt: "You are a research specialist..."
    tools: ["Read", "WebSearch"]
    model: "sonnet"
    skills: ["deep-research"]
    maxTurns: 10
    background: true
```

### 桥接策略

将每个子代理定义注册为一个 Pi Extension Tool。当主 agent 调用子代理时，工具内部创建一个新的 Pi Session 并执行。

### 实现

```typescript
// packages/providers/src/pi/extensions/sub-agent-tool.ts

import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'

interface SubAgentDef {
  description: string
  prompt: string
  tools?: string[]
  model?: string
  skills?: string[]
  maxTurns?: number
  background?: boolean
}

/**
 * 为每个子代理创建一个 Pi ToolDefinition
 * 主 agent 可以调用这个工具来委派任务给子代理
 */
export function createSubAgentTools(
  agents: Record<string, SubAgentDef>,
  parentCwd: string,
  parentOptions: SendQueryOptions
): ToolDefinition[] {
  return Object.entries(agents).map(([name, def]) => {
    return defineTool({
      name: `delegate_to_${name}`,
      label: `Delegate to ${name}`,
      description: def.description,
      parameters: Type.Object({
        task: Type.String({ description: 'The task to delegate to this sub-agent' }),
        context: Type.Optional(Type.String({ description: 'Additional context' })),
      }),
      executionMode: def.background ? 'parallel' : 'sequential',
      
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        // 1. 创建子 agent session
        const { session } = await createAgentSession({
          cwd: parentCwd,
          model: params.model ? resolveModel(def.model, ctx.modelRegistry) : undefined,
          tools: def.tools,  // 限制工具集
        })
        
        // 2. 构建子代理 prompt
        const subPrompt = [
          def.prompt,
          '',
          '## Task',
          params.task,
          params.context ? `\n## Context\n${params.context}` : '',
        ].join('\n')
        
        // 3. 设置 abort
        if (signal) {
          signal.addEventListener('abort', () => session.abort(), { once: true })
        }
        
        // 4. 执行子代理
        let result = ''
        const collectText = (event: any) => {
          if (event.type === 'message_update' && 
              event.assistantMessageEvent?.type === 'text_delta') {
            result += event.assistantMessageEvent.delta
            onUpdate?.({
              content: [{ type: 'text', text: result }],
              details: { progress: 'running' },
            })
          }
        }
        
        const unsubscribe = session.subscribe(collectText)
        
        try {
          await session.prompt(subPrompt)
        } finally {
          unsubscribe()
          session.dispose()
        }
        
        // 5. 返回结果
        return {
          content: [{ type: 'text', text: result || 'Sub-agent completed with no text output.' }],
          details: { agent: name, status: 'completed' },
        }
      },
    })
  })
}
```

### 与 ClaudeSDKProvider 行为的差异

| 特性 | ClaudeSDKProvider | PiAgentProvider |
|------|-------------------|-----------------|
| 子代理调用方式 | SDK 内置 Task 工具 | 自定义 Extension Tool |
| 工具隔离 | SDK 管理 | 通过 `tools` 参数限制 |
| 并行执行 | SDK 内部管理 | `executionMode: 'parallel'` |
| 模型覆盖 | SDK 管理 | 通过 `resolveModel` + `setModel` |

### 限制

- Pi 的子代理是同步工具调用（不像 ClaudeSDKProvider 有 `background` 概念）
- `background: true` 映射为 `executionMode: 'parallel'`，允许 Pi 并行执行多个工具
- 最大轮次限制需要通过 `shouldStopAfterTurn` 或 `maxTurns` 配置实现

---

## 4.2 技能（Skills）注入

### Octopus 技能系统

Octopus 的 `skills` 是 core-pack 中的 markdown 文件，通过 `SendQueryOptions.skills` 传递给 Provider。

### 桥接策略

技能文本注入到 Pi 的 system prompt，通过 `before_provider_request` 扩展钩子实现。

### 实现

```typescript
// packages/providers/src/pi/extensions/octopus-hooks.ts

import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

/**
 * 创建 Octopus 技能注入的 Extension
 */
export function createSkillsExtension(skills: string[]): ExtensionFactory {
  return (pi) => {
    if (skills.length === 0) return
    
    // 加载技能内容
    const skillContents = skills.map(name => loadSkillContent(name))
    
    pi.on('before_provider_request', (event) => {
      // 在 system prompt 中注入技能
      const skillsSection = skillContents
        .map(s => `### Skill: ${s.name}\n${s.content}`)
        .join('\n\n')
      
      // 修改 context 中的 system prompt
      if (event.context) {
        event.context.systemPrompt = [
          event.context.systemPrompt ?? '',
          '',
          '## Available Skills',
          skillsSection,
        ].join('\n')
      }
    })
  }
}

function loadSkillContent(name: string): { name: string; content: string } {
  // 从 core-pack 或 ~/.octopus/skills/ 加载技能 markdown
  // 与现有 AgentExecutor 中的技能加载逻辑保持一致
  return { name, content: '' }
}
```

### 替代方案：直接注入 prompt

更简单的方式是在 `sendQuery()` 时将技能内容拼接到 prompt 中：

```typescript
const enrichedPrompt = [
  prompt,
  '',
  '## Available Skills',
  ...skills.map(name => loadSkillContent(name)),
].join('\n')

await session.prompt(enrichedPrompt)
```

**推荐**：先用替代方案（直接注入），验证通过后再优化为扩展钩子方式。

---

## 4.3 Auto Answers 注入

### Octopus Auto Answers 机制

Auto Answers 是由 `compileAutoAnswers()` 编译的指令文本，注入到 prompt 中告诉 LLM 如何自动回答问题。

### 桥接策略

**无需特殊处理**。Auto Answers 已经在 `AgentExecutor.buildPrompt()` 中被编译并拼接到 prompt 文本中。Pi 收到的是已经包含 auto answer 指令的完整 prompt。

### 流程

```
AgentExecutor.buildPrompt()
  → 编译 auto_answers 为指令文本
  → 拼接到 prompt 末尾
  → 传递给 provider.sendQuery(prompt, ...)
  → Pi 收到的 prompt 已包含 auto answer 指令
```

### 验证要点

- Pi 的 agent loop 会遵循 prompt 中的指令自动回答问题
- 如果 Pi 的工具（如 AskUser 类工具）弹出问题，prompt 中的指令应引导 agent 选择推荐选项
- Pi 没有内置的 `AskUserQuestion` 工具，所以不会出现 ClaudeSDKProvider 的 `ask_user_question` 拦截场景

---

## 4.4 Session Resume 桥接

### Octopus 会话恢复

```yaml
- id: followup
  type: agent
  resume_from: "$prev.session"  # 引用前序节点的 session ID
  prompt: "Continue the analysis..."
```

### Pi 会话持久化

Pi 使用 JSONL 文件存储 session，支持：
- `SessionManager.create()` — 创建新 session
- `SessionManager` 通过 `getSessionId()` 获取当前 ID
- 会话历史在 `agent.state.messages` 中

### 桥接策略

```typescript
// session-cache.ts

interface SessionEntry {
  session: CreateAgentSessionResult
  sessionId: string
  cwd: string
  createdAt: number
}

export class SessionCache {
  private sessions = new Map<string, SessionEntry>()
  
  /** 获取或创建 session */
  async getOrCreate(
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): Promise<CreateAgentSessionResult> {
    
    // 1. 如果是 resume，尝试查找已缓存的 session
    if (resumeSessionId) {
      const cached = this.sessions.get(resumeSessionId)
      if (cached) {
        return cached.session
      }
      
      // 2. 尝试从磁盘恢复（Pi 的 SessionManager 支持）
      // Pi 的 session 存储在 ~/.pi/agent/sessions/ 或 cwd/.pi/sessions/
      const restored = await createAgentSession({
        cwd,
        // sessionManager 需要指向之前的 session 文件
      })
      
      // 3. 恢复消息历史
      // TODO: 需要 Pi API 支持加载特定 session ID 的历史
      return restored
    }
    
    // 4. 按 cwd 查找活跃 session
    const active = Array.from(this.sessions.values())
      .find(s => s.cwd === cwd)
    if (active) {
      return active.session
    }
    
    // 5. 创建新 session
    const result = await createAgentSession({ cwd })
    const sessionId = result.session.sessionId
    this.sessions.set(sessionId, {
      session: result,
      sessionId,
      cwd,
      createdAt: Date.now(),
    })
    
    return result
  }
  
  /** 获取 session ID（用于返回给 Octopus） */
  getSessionId(session: AgentSession): string {
    return session.sessionId
  }
  
  /** 清理过期 session */
  cleanup(maxAge: number = 3600_000): void {
    const now = Date.now()
    for (const [id, entry] of this.sessions) {
      if (now - entry.createdAt > maxAge) {
        entry.session.dispose()
        this.sessions.delete(id)
      }
    }
  }
}
```

### 限制

- Pi 的 Session 恢复机制与 ClaudeSDKProvider 不同
- 首版可能不支持跨进程的 session resume（Pi session 在内存中）
- 需要通过 Pi 的 JSONL 持久化实现跨进程恢复

---

## 4.5 Goal Mode 桥接

### Octopus Goal模式

当 YAML 节点设置 `goal` 时，`AgentExecutor.buildGoalPrompt()` 生成结构化 prompt：

```
## Goal
{goal}

## Constraints
{constraints}

## Allowed Tools
{tools}

## Instructions
...

## Previous Node Results
{context}

## Available Variables
{variables}
```

### 桥接策略

**无需特殊处理**。Goal Mode 是 prompt 工程，在 executor 层面完成。Pi 收到的是已经格式化的 goal prompt。

### 验证要点

- Goal prompt 包含明确的工具使用指令，Pi 的 agent loop 会遵循
- Goal prompt 包含 `vars_update` JSON 格式要求，Pi 的 agent 应能输出符合格式的内容
- `parseVarsUpdate()` 在 executor 层面解析，不依赖 Provider

---

## 4.6 变量系统桥接

### Octopus 变量系统

- `$vars.xxx` — 全局变量池
- `$node-id.output.xxx` — 前序节点输出
- `$last_output` — 当前节点输出
- `$iteration` — 循环迭代号

### 桥接策略

**无需特殊处理**。变量替换在 `AgentExecutor.buildPrompt()` 中通过 `substituteVars()` 完成。Pi 收到的是已经完成变量替换的 prompt 文本。

### 输出变量（vars_update）

Pi agent 的文本输出会被 `parseVarsUpdate()` 扫描，提取 `{"vars_update": {...}}` JSON。这是纯文本解析，不依赖 Provider 实现。

---

## 4.7 System Prompt 处理

### Octopus System Prompt

```typescript
export type SystemPromptInput = string | { type: 'preset'; preset: 'claude_code'; append?: string }
```

### 桥接策略

| SystemPromptInput 类型 | Pi 处理方式 |
|---|---|
| `string` | 覆盖 Pi 的 system prompt（通过 `before_provider_request` 钩子） |
| `{ type: 'preset', preset: 'claude_code' }` | **不适用** — Pi 不使用 Claude Code 预设。使用 Pi 默认 system prompt + `append` 内容 |
| `undefined` | 使用 Pi 默认 system prompt |

### 实现

```typescript
function applySystemPrompt(
  session: AgentSession,
  systemPrompt?: SystemPromptInput
): void {
  if (!systemPrompt) return
  
  const text = typeof systemPrompt === 'string'
    ? systemPrompt
    : systemPrompt.append ?? ''
  
  if (!text) return
  
  // 通过 agent 的 transformContext 注入
  const originalTransform = session.agent.transformContext
  session.agent.transformContext = async (messages, signal) => {
    // 修改 system prompt（Pi 的 system prompt 在 agent state 中）
    session.agent.state.systemPrompt = text
    return originalTransform ? originalTransform(messages, signal) : messages
  }
}
```

---

## 4.8 Abort 信号传递

### 实现

```typescript
// 在 sendQuery 中
if (options?.abortSignal) {
  // 1. 如果已 abort，直接跳过
  if (options.abortSignal.aborted) {
    yield { type: 'error', code: 'aborted', message: 'Request was aborted' }
    return
  }
  
  // 2. 监听 abort 事件
  options.abortSignal.addEventListener('abort', () => {
    session.abort()      // 通知 Pi agent 停止
    bridge.end()         // 结束事件流
  }, { once: true })
}
```

### Pi 的 abort 行为

- `session.abort()` → 设置 `Agent.signal` → agent loop 检查 signal 并在下一个 turn 前停止
- 正在执行的工具收到 `signal` 参数，可以提前退出
- LLM 调用通过 `StreamOptions.signal` 取消 HTTP 请求

---

## 4.9 SwarmExecutor 兼容

### SwarmExecutor 如何消费 Provider

SwarmExecutor 的 `collectFromProvider()` 直接迭代 `AsyncGenerator<MessageChunk>`：

```typescript
for await (const chunk of generator) {
  if (chunk.type === 'text_delta') text += chunk.content
  if (chunk.type === 'result') tokens = chunk.tokens
  if (chunk.type === 'tool_call') toolCalls.push(chunk)
}
```

### Pi Provider 兼容性

Pi Provider 必须产出：
- ✅ `text_delta` — 通过 `message_update` → `text_delta` 映射
- ✅ `result` — 通过 `agent_end` 映射
- ✅ `tool_call` — 通过 `tool_execution_start` 映射

**结论**：Pi Provider 完全兼容 SwarmExecutor 的消费模式。

---

## 4.10 功能桥接总结

| Octopus 特性 | 桥接方式 | 复杂度 | 首版实现 |
|---|---|---|---|
| 子代理 | Extension Tool | 🔴 高 | ✅ MVP（同步委派） |
| 技能注入 | prompt 拼接 / context hook | 🟢 低 | ✅ 直接拼接 |
| Auto Answers | 无需处理（已在 prompt 中） | 🟢 无 | ✅ |
| Session Resume | SessionCache + Pi SessionManager | 🟡 中 | ⏳ 首版简化 |
| Goal Mode | 无需处理（已在 prompt 中） | 🟢 无 | ✅ |
| 变量系统 | 无需处理（已在 prompt 中） | 🟢 无 | ✅ |
| System Prompt | transformContext 覆盖 | 🟡 中 | ✅ 简化版 |
| Abort 信号 | session.abort() | 🟢 低 | ✅ |
| SwarmExecutor | 兼容（产出 text_delta + result） | 🟢 无 | ✅ |
| 多提供商模型 | ModelRegistry + resolveModel | 🟡 中 | ✅ |
