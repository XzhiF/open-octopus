# 第五章：真实测试策略

> 本章定义如何验证 Pi Provider 集成的正确性：单元测试、集成测试、E2E 工作流测试。

---

## 5.1 测试金字塔

```
                    ┌─────────┐
                    │  E2E    │  3-5 个完整工作流
                   ┌┴─────────┴┐
                   │ Integration│  Provider + Engine 联调
                  ┌┴────────────┴┐
                  │    Unit      │  事件映射、模型解析、Token 聚合
                  └──────────────┘
```

---

## 5.2 单元测试

### 测试范围

| 模块 | 测试目标 | Mock 需求 |
|------|----------|-----------|
| `event-mapper.ts` | Pi 事件 → MessageChunk 映射正确性 | 无（纯函数） |
| `async-bridge.ts` | push/end/fail → AsyncGenerator 行为 | 无（纯异步） |
| `model-resolver.ts` | 字符串 → Model 对象解析 | Mock ModelRegistry |
| `token-aggregator.ts` | Usage 累加 → TokenUsage 输出 | 无（纯计算） |
| `session-cache.ts` | Session 创建/缓存/恢复 | Mock createAgentSession |

### 事件映射测试

```typescript
// packages/providers/src/__tests__/pi/event-mapper.test.ts

import { describe, it, expect, beforeEach } from 'vitest'
import { mapPiEventToChunks, type MapperContext } from '../../pi/event-mapper'
import { TokenAggregator } from '../../pi/token-aggregator'

describe('Pi Event Mapper', () => {
  let ctx: MapperContext
  
  beforeEach(() => {
    ctx = {
      messageId: '',
      toolStartTimes: new Map(),
      tokenAggregator: new TokenAggregator(),
    }
  })
  
  describe('message lifecycle', () => {
    it('maps message_start to message_start with generated id', () => {
      const result = mapPiEventToChunks(
        { type: 'message_start', message: {} as any },
        ctx
      )
      expect(result).toEqual({
        type: 'message_start',
        messageId: expect.any(String),
      })
      expect(ctx.messageId).toBeTruthy()
    })
    
    it('maps message_end to text_done + message_stop', () => {
      ctx.messageId = 'test-msg-1'
      const result = mapPiEventToChunks(
        { type: 'message_end', message: {} as any },
        ctx
      )
      expect(result).toEqual([
        { type: 'text_done', messageId: 'test-msg-1' },
        { type: 'message_stop', messageId: 'test-msg-1' },
      ])
    })
  })
  
  describe('text streaming', () => {
    it('maps message_update text_delta to text_delta', () => {
      ctx.messageId = 'test-msg-1'
      const result = mapPiEventToChunks(
        {
          type: 'message_update',
          message: {} as any,
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: 'Hello',
            partial: {} as any,
          },
        },
        ctx
      )
      expect(result).toEqual({
        type: 'text_delta',
        content: 'Hello',
        messageId: 'test-msg-1',
      })
    })
  })
  
  describe('thinking streaming', () => {
    it('maps thinking_start/delta/end to thinking chunks', () => {
      ctx.messageId = 'test-msg-1'
      
      const start = mapPiEventToChunks({
        type: 'message_update', message: {} as any,
        assistantMessageEvent: { type: 'thinking_start', contentIndex: 0, partial: {} as any },
      }, ctx)
      expect(start).toMatchObject({ type: 'thinking_start' })
      
      const delta = mapPiEventToChunks({
        type: 'message_update', message: {} as any,
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'thinking...', partial: {} as any },
      }, ctx)
      expect(delta).toMatchObject({ type: 'thinking', content: 'thinking...' })
      
      const end = mapPiEventToChunks({
        type: 'message_update', message: {} as any,
        assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'thinking...', partial: {} as any },
      }, ctx)
      expect(end).toMatchObject({ type: 'thinking_done' })
    })
  })
  
  describe('tool execution', () => {
    it('maps tool_execution_start to tool_call_start + tool_call', () => {
      ctx.messageId = 'test-msg-1'
      const result = mapPiEventToChunks({
        type: 'tool_execution_start',
        toolCallId: 'tc-1',
        toolName: 'bash',
        args: { command: 'ls' },
      }, ctx)
      
      expect(result).toHaveLength(2)
      expect(result![0]).toMatchObject({ type: 'tool_call_start', toolCallId: 'tc-1', toolName: 'bash' })
      expect(result![1]).toMatchObject({ type: 'tool_call', toolCallId: 'tc-1', toolInput: { command: 'ls' } })
    })
    
    it('maps tool_execution_end to tool_result with duration', () => {
      ctx.toolStartTimes.set('tc-1', Date.now() - 1500)
      
      const result = mapPiEventToChunks({
        type: 'tool_execution_end',
        toolCallId: 'tc-1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'file1.txt\nfile2.txt' }] },
        isError: false,
      }, ctx)
      
      expect(result).toMatchObject({
        type: 'tool_result',
        toolCallId: 'tc-1',
        content: 'file1.txt\nfile2.txt',
        isError: false,
        toolDuration: expect.stringMatching(/^\d+\.\d+s$/),
      })
    })
    
    it('maps tool_execution_end error correctly', () => {
      const result = mapPiEventToChunks({
        type: 'tool_execution_end',
        toolCallId: 'tc-1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'Permission denied' }] },
        isError: true,
      }, ctx)
      
      expect(result).toMatchObject({
        type: 'tool_result',
        isError: true,
      })
    })
  })
  
  describe('agent_end → result', () => {
    it('maps agent_end to result with tokens', () => {
      ctx.tokenAggregator.add('claude-sonnet-4-20250514', {
        input: 1000, output: 500, cacheRead: 200, cacheWrite: 0,
        totalTokens: 1500, cost: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0, total: 0.0183 },
      })
      
      const result = mapPiEventToChunks({
        type: 'agent_end',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done!' }] } as any],
      }, ctx)
      
      expect(result).toMatchObject({
        type: 'result',
        content: 'Done!',
        tokens: { input: 1000, output: 500, total: 1500 },
        costUsd: 0.0183,
        modelUsages: [{ model: 'claude-sonnet-4-20250514', inputTokens: 1000, outputTokens: 500 }],
      })
    })
  })
  
  describe('compaction events', () => {
    it('maps compaction_start to status compacting', () => {
      const result = mapPiEventToChunks(
        { type: 'compaction_start', reason: 'threshold' },
        ctx
      )
      expect(result).toEqual({ type: 'status', status: 'compacting' })
    })
    
    it('maps compaction_end to status null', () => {
      const result = mapPiEventToChunks(
        { type: 'compaction_end', reason: 'threshold', aborted: false } as any,
        ctx
      )
      expect(result).toEqual({ type: 'status', status: null })
    })
  })
  
  describe('ignored events', () => {
    it.each(['agent_start', 'turn_start', 'turn_end', 'queue_update', 'entry_appended'] as const)(
      'returns null for %s',
      (eventType) => {
        const result = mapPiEventToChunks({ type: eventType } as any, ctx)
        expect(result).toBeNull()
      }
    )
  })
})
```

### 异步桥接测试

```typescript
// packages/providers/src/__tests__/pi/async-bridge.test.ts

import { describe, it, expect } from 'vitest'
import { AsyncEventBridge } from '../../pi/async-bridge'

describe('AsyncEventBridge', () => {
  it('converts push events to async generator', async () => {
    const bridge = new AsyncEventBridge<number, string>((n) => `value:${n}`)
    
    // 生产者在微任务中推送
    queueMicrotask(() => {
      bridge.push(1)
      bridge.push(2)
      bridge.push(3)
      bridge.end()
    })
    
    const results: string[] = []
    for await (const item of bridge.generator()) {
      results.push(item)
    }
    
    expect(results).toEqual(['value:1', 'value:2', 'value:3'])
  })
  
  it('handles mapper returning null (filter)', async () => {
    const bridge = new AsyncEventBridge<number, string>(
      (n) => n % 2 === 0 ? `even:${n}` : null
    )
    
    queueMicrotask(() => {
      bridge.push(1)
      bridge.push(2)
      bridge.push(3)
      bridge.push(4)
      bridge.end()
    })
    
    const results: string[] = []
    for await (const item of bridge.generator()) {
      results.push(item)
    }
    
    expect(results).toEqual(['even:2', 'even:4'])
  })
  
  it('handles mapper returning array (expand)', async () => {
    const bridge = new AsyncEventBridge<number, string>(
      (n) => [`a:${n}`, `b:${n}`]
    )
    
    queueMicrotask(() => {
      bridge.push(1)
      bridge.end()
    })
    
    const results: string[] = []
    for await (const item of bridge.generator()) {
      results.push(item)
    }
    
    expect(results).toEqual(['a:1', 'b:1'])
  })
  
  it('propagates errors', async () => {
    const bridge = new AsyncEventBridge<number, string>((n) => `value:${n}`)
    
    queueMicrotask(() => {
      bridge.push(1)
      bridge.fail(new Error('boom'))
    })
    
    await expect(async () => {
      for await (const _ of bridge.generator()) {}
    }).rejects.toThrow('boom')
  })
  
  it('handles push after end (ignored)', async () => {
    const bridge = new AsyncEventBridge<number, string>((n) => `value:${n}`)
    
    bridge.push(1)
    bridge.end()
    bridge.push(2)  // 应该被忽略
    
    const results: string[] = []
    for await (const item of bridge.generator()) {
      results.push(item)
    }
    
    expect(results).toEqual(['value:1'])
  })
})
```

### Token 聚合测试

```typescript
// packages/providers/src/__tests__/pi/token-aggregator.test.ts

import { describe, it, expect } from 'vitest'
import { TokenAggregator } from '../../pi/token-aggregator'

describe('TokenAggregator', () => {
  it('aggregates single model usage', () => {
    const agg = new TokenAggregator()
    agg.add('claude-sonnet', {
      input: 1000, output: 500, cacheRead: 200, cacheWrite: 100,
      totalTokens: 1500,
      cost: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.0015, total: 0.0198 },
    })
    
    expect(agg.toTokenUsage()).toEqual({ input: 1000, output: 500, total: 1500 })
    expect(agg.totalCost()).toBeCloseTo(0.0198)
  })
  
  it('aggregates multiple calls for same model', () => {
    const agg = new TokenAggregator()
    const usage = {
      input: 500, output: 200, cacheRead: 0, cacheWrite: 0,
      totalTokens: 700,
      cost: { input: 0.001, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.006 },
    }
    
    agg.add('gpt-4o', usage)
    agg.add('gpt-4o', usage)
    
    expect(agg.toTokenUsage()).toEqual({ input: 1000, output: 400, total: 1400 })
    expect(agg.toModelUsages()).toHaveLength(1)
    expect(agg.toModelUsages()[0].inputTokens).toBe(1000)
  })
  
  it('aggregates multiple models', () => {
    const agg = new TokenAggregator()
    agg.add('claude-sonnet', {
      input: 1000, output: 500, cacheRead: 0, cacheWrite: 0,
      totalTokens: 1500,
      cost: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0, total: 0.018 },
    })
    agg.add('gpt-4o', {
      input: 800, output: 300, cacheRead: 0, cacheWrite: 0,
      totalTokens: 1100,
      cost: { input: 0.002, output: 0.008, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    })
    
    expect(agg.toTokenUsage()).toEqual({ input: 1800, output: 800, total: 2600 })
    expect(agg.toModelUsages()).toHaveLength(2)
    expect(agg.totalCost()).toBeCloseTo(0.028)
  })
})
```

### 模型解析测试

```typescript
// packages/providers/src/__tests__/pi/model-resolver.test.ts

import { describe, it, expect } from 'vitest'
import { resolveModel } from '../../pi/model-resolver'

// Mock ModelRegistry
function createMockRegistry(models: any[]) {
  return {
    find: (provider: string, modelId: string) =>
      models.find(m => m.provider === provider && m.id === modelId),
    getAll: () => models,
  } as any
}

describe('resolveModel', () => {
  const models = [
    { id: 'gpt-4o', provider: 'openai', name: 'GPT-4o' },
    { id: 'claude-sonnet-4-20250514', provider: 'anthropic', name: 'Claude Sonnet' },
    { id: 'gemini-2.5-pro', provider: 'google', name: 'Gemini Pro' },
  ]
  const registry = createMockRegistry(models)
  
  it('resolves provider/model-id format', () => {
    const result = resolveModel('openai/gpt-4o', registry)
    expect(result?.id).toBe('gpt-4o')
    expect(result?.provider).toBe('openai')
  })
  
  it('resolves aliases', () => {
    const result = resolveModel('sonnet', registry)
    expect(result?.id).toBe('claude-sonnet-4-20250514')
  })
  
  it('searches all models by id', () => {
    const result = resolveModel('gpt-4o', registry)
    expect(result?.id).toBe('gpt-4o')
  })
  
  it('returns undefined for unknown model', () => {
    const result = resolveModel('unknown-model', registry)
    expect(result).toBeUndefined()
  })
  
  it('returns undefined for undefined input', () => {
    const result = resolveModel(undefined, registry)
    expect(result).toBeUndefined()
  })
})
```

---

## 5.3 集成测试

### 测试目标

验证 PiAgentProvider 与 Octopus 引擎的联调：
- Provider 注册和发现
- AgentNodeRunner 消费 MessageChunk
- SwarmExecutor 消费 MessageChunk

### Mock 方案

使用 Pi 的 `faux` provider（`packages/ai/src/providers/faux.ts`）作为 Mock LLM：

```typescript
// Pi 内置的测试 provider，可控制返回内容
import { createFauxProvider } from '@earendil-works/pi-ai/providers/faux'

const fauxProvider = createFauxProvider({
  responses: [
    { text: 'Hello from Pi!', toolCalls: [] },
    { text: 'Task completed.', toolCalls: [] },
  ],
})
```

### 集成测试示例

```typescript
// packages/providers/src/__tests__/pi/provider.integration.test.ts

import { describe, it, expect } from 'vitest'
import { PiAgentProvider } from '../../pi/provider'
import type { MessageChunk } from '../../types'

describe('PiAgentProvider Integration', () => {
  it('produces text_delta and result chunks', async () => {
    const provider = new PiAgentProvider()
    
    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery(
      'Say hello',
      process.cwd(),
      undefined,
      { model: 'anthropic/claude-haiku-4-5-20251001' }  // 用 haiku 省钱
    )) {
      chunks.push(chunk)
    }
    
    // 验证关键事件
    expect(chunks.some(c => c.type === 'message_start')).toBe(true)
    expect(chunks.some(c => c.type === 'text_delta')).toBe(true)
    expect(chunks.some(c => c.type === 'result')).toBe(true)
    
    // 验证 result 有 token 信息
    const result = chunks.find(c => c.type === 'result')
    expect(result?.tokens).toBeDefined()
    expect(result?.tokens?.input).toBeGreaterThan(0)
    
    provider.dispose()
  }, 60_000)  // 60s timeout（LLM 调用可能慢）
  
  it('handles tool calls', async () => {
    const provider = new PiAgentProvider()
    
    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery(
      'List files in current directory using bash tool',
      process.cwd(),
      undefined,
      { model: 'anthropic/claude-haiku-4-5-20251001' }
    )) {
      chunks.push(chunk)
    }
    
    // 应该有工具调用
    expect(chunks.some(c => c.type === 'tool_call')).toBe(true)
    expect(chunks.some(c => c.type === 'tool_result')).toBe(true)
    
    provider.dispose()
  }, 120_000)
  
  it('handles abort signal', async () => {
    const provider = new PiAgentProvider()
    const controller = new AbortController()
    
    // 100ms 后取消
    setTimeout(() => controller.abort(), 100)
    
    const chunks: MessageChunk[] = []
    try {
      for await (const chunk of provider.sendQuery(
        'Write a very long essay about the history of computing',
        process.cwd(),
        undefined,
        { model: 'anthropic/claude-haiku-4-5-20251001', abortSignal: controller.signal }
      )) {
        chunks.push(chunk)
      }
    } catch {
      // abort 可能抛出错误
    }
    
    // 不应该有 result（被中断了）
    // 或者 result 的 content 为空
    provider.dispose()
  }, 10_000)
})
```

---

## 5.4 E2E 工作流测试

### 测试目标

验证完整工作流端到端执行：YAML 解析 → 引擎调度 → Pi Provider 执行 → 结果输出。

### 测试工作流

```yaml
# tests/fixtures/pi-integration-test.yaml
apiVersion: octopus/v1
kind: Workflow
name: pi-integration-test
engine: pi
model: anthropic/claude-haiku-4-5-20251001

variables:
  project_name: "Test Project"

auto_answers:
  - pattern: "*"
    answer: "Choose recommended"

nodes:
  # 1. 简单 agent
  - id: greet
    type: agent
    prompt: "Say hello to $vars.project_name and list 3 random facts."
    outputs:
      greeting: "$last_output"

  # 2. 带 bash 工具的 agent
  - id: explore
    type: agent
    depends_on: [greet]
    prompt: |
      Run 'echo "hello from pi"' using bash tool.
      Then summarize the output.
    outputs:
      exploration: "$last_output"

  # 3. 使用变量引用
  - id: summarize
    type: agent
    depends_on: [explore]
    prompt: |
      Summarize these results:
      Greeting: $greet.outputs.greeting
      Exploration: $explore.outputs.exploration
    outputs:
      summary: "$last_output"
```

### E2E 测试脚本

```typescript
// tests/e2e/pi-provider.test.ts

import { describe, it, expect } from 'vitest'
import { WorkflowEngine } from '@octopus/engine'
import { getProvider } from '@octopus/providers'
import { parseWorkflow } from '@octopus/shared'
import fs from 'fs'

describe('Pi Provider E2E', () => {
  it('executes full workflow with pi engine', async () => {
    const yaml = fs.readFileSync('tests/fixtures/pi-integration-test.yaml', 'utf8')
    const workflow = parseWorkflow(yaml)
    
    const piProvider = getProvider('pi')!
    const engine = new WorkflowEngine(workflow, { pi: piProvider }, {
      cwd: process.cwd(),
      org: 'test',
    })
    
    const result = await engine.execute()
    
    // 验证所有节点完成
    expect(result.status).toBe('completed')
    expect(result.nodes).toHaveLength(3)
    
    // 验证变量传递
    expect(result.varPool.get('project_name')).toBe('Test Project')
    
    // 验证每个节点有输出
    for (const node of result.nodes) {
      expect(node.status).toBe('completed')
      expect(node.output).toBeTruthy()
    }
  }, 300_000)  // 5 分钟超时
})
```

### Swarm E2E 测试

```yaml
# tests/fixtures/pi-swarm-test.yaml
apiVersion: octopus/v1
kind: Workflow
name: pi-swarm-test

nodes:
  - id: debate
    type: swarm
    engine: pi
    mode: review
    topic: "Is TypeScript better than Python for backend development?"
    experts:
      - name: ts-advocate
        model: anthropic/claude-haiku-4-5-20251001
      - name: py-advocate
        model: anthropic/claude-haiku-4-5-20251001
    host:
      model: anthropic/claude-haiku-4-5-20251001
```

---

## 5.5 性能基准测试

### 测试目标

对比 ClaudeSDKProvider 和 PiAgentProvider 的性能指标。

```typescript
// tests/benchmarks/provider-comparison.test.ts

import { describe, it } from 'vitest'

describe('Provider Performance Comparison', () => {
  const prompt = 'Write a function that calculates fibonacci numbers.'
  const cwd = process.cwd()
  
  it('benchmarks ClaudeSDKProvider', async () => {
    const provider = getProvider('claude')!
    const start = performance.now()
    
    let tokenCount = 0
    for await (const chunk of provider.sendQuery(prompt, cwd)) {
      if (chunk.type === 'text_delta') tokenCount += chunk.content.length
    }
    
    const elapsed = performance.now() - start
    console.log(`ClaudeSDKProvider: ${elapsed.toFixed(0)}ms, ${tokenCount} chars`)
  }, 120_000)
  
  it('benchmarks PiAgentProvider', async () => {
    const provider = getProvider('pi')!
    const start = performance.now()
    
    let tokenCount = 0
    for await (const chunk of provider.sendQuery(prompt, cwd, undefined, {
      model: 'anthropic/claude-haiku-4-5-20251001',
    })) {
      if (chunk.type === 'text_delta') tokenCount += chunk.content.length
    }
    
    const elapsed = performance.now() - start
    console.log(`PiAgentProvider: ${elapsed.toFixed(0)}ms, ${tokenCount} chars`)
    
    provider.dispose()
  }, 120_000)
})
```

### 关键性能指标

| 指标 | 目标 | 测量方法 |
|------|------|----------|
| TTFT (Time To First Token) | < 2s | message_start 到第一个 text_delta |
| 总执行时间 | 与 ClaudeSDKProvider ±20% | start → result |
| Session 创建时间 | < 500ms | createAgentSession() |
| 事件映射开销 | < 1ms/event | mapPiEventToChunks() |
| 内存使用 | < 200MB per session | process.memoryUsage() |

---

## 5.6 测试运行指南

### 快速测试（不需要 API Key）

```bash
# 仅单元测试（mock 模式）
pnpm test --filter @octopus/providers -- --testPathPattern="pi/"

# 包含 async-bridge 和 event-mapper
pnpm test --filter @octopus/providers -- --testPathPattern="pi/(event-mapper|async-bridge|token-aggregator|model-resolver)"
```

### 需要 API Key 的测试

```bash
# 设置环境变量
export ANTHROPIC_API_KEY="sk-ant-..."

# 集成测试（真实 LLM 调用，用 haiku 省钱）
pnpm test --filter @octopus/providers -- --testPathPattern="pi/provider.integration"

# E2E 工作流测试
pnpm test -- --testPathPattern="e2e/pi-provider"
```

### 手动冒烟测试

```bash
# 1. 构建
pnpm build --filter @octopus/providers

# 2. 运行简单工作流
cat > /tmp/pi-test.yaml << 'EOF'
apiVersion: octopus/v1
kind: Workflow
name: pi-smoke
engine: pi
model: anthropic/claude-haiku-4-5-20251001
nodes:
  - id: hello
    type: agent
    prompt: "Say hello and your model name."
EOF

octopus workflow run /tmp/pi-test.yaml --org xzf
```

---

## 5.7 Mock 方案总结

| 测试层 | Mock 方案 | 是否真实 LLM |
|--------|-----------|-------------|
| 单元测试 | 纯函数 + Mock ModelRegistry | ❌ |
| 集成测试 | Pi faux provider / 真实 haiku | 可选 |
| E2E 测试 | 真实 LLM（haiku 省钱） | ✅ |
| 性能测试 | 真实 LLM | ✅ |

### 成本控制

- 集成测试默认使用 `claude-haiku`（最便宜）
- E2E 测试设置 `$OCTOPUS_TEST_SKIP_LLM=1` 跳过真实 LLM 调用
- CI 中只运行单元测试，集成/E2E 手动触发

---

## 5.8 实测验证的测试模式（已验证可用）

> 以下模式经过 2026-07-03 实测验证，使用 DashScope qwen3-max，三层全链路通过。
> 完整测试文件：`packages/providers/src/__tests__/pi-streaming-dashscope.test.ts`

### 自定义提供商注册模式

这是测试任何非内置提供商的**必要前置步骤**。Pi 的 `createAgentSession()` 内部 `streamFn` 通过 `ModelRegistry` 获取 API Key，不能用 `agent.getApiKey` 覆盖。

```typescript
import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent'

const authStorage = AuthStorage.inMemory()
const modelRegistry = ModelRegistry.inMemory(authStorage)

modelRegistry.registerProvider('dashscope', {
  name: 'DashScope',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
  api: 'openai-completions',
  models: [{
    id: 'qwen3-max',
    name: 'Qwen Max',
    api: 'openai-completions',
    reasoning: false,
    input: ['text'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
  }],
})
```

### Headless Session 创建模式

```typescript
import { DefaultResourceLoader, createAgentSession } from '@earendil-works/pi-coding-agent'

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  noExtensions: true,     // 必须：避免加载磁盘上的 Pi CLI 扩展
  noSkills: true,
  noContextFiles: true,
  noPromptTemplates: true,
  noThemes: true,
})
await loader.reload()

const { session } = await createAgentSession({
  cwd: process.cwd(),
  model,
  modelRegistry,       // ← 传入预注册了提供商的 registry
  resourceLoader: loader,
})
```

### 事件收集模式

```typescript
const events: any[] = []

session.subscribe((event: any) => {
  events.push(event)
  // 可选：实时打印
  if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
    process.stdout.write(event.assistantMessageEvent.delta)
  }
})

await session.prompt('你的测试 prompt')

// 统计事件类型
const counts = new Map<string, number>()
for (const e of events) {
  counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
}

// 断言关键事件
expect(counts.has('agent_start')).toBe(true)
expect(counts.has('agent_end')).toBe(true)
expect(counts.has('message_update')).toBe(true)  // 流式文本
expect(counts.has('tool_execution_start')).toBe(true)  // 工具调用
```

### 实测事件数据（供实现参考）

以下是一次典型的 AgentSession 执行（bash 工具调用 `date` 命令）的事件分布：

```
agent_start: 1           ← Agent 开始
turn_start: 2            ← 2 轮（第 1 轮决定调工具，第 2 轮输出结果）
message_start: 4         ← 4 条消息（user + assistant + tool_result + assistant）
message_update: 13       ← 13 个流式 token
message_end: 4
tool_execution_start: 1  ← bash 工具开始
tool_execution_update: 2 ← bash 执行中进度
tool_execution_end: 1    ← bash 返回结果
turn_end: 2
agent_end: 1             ← Agent 结束
总计: 31 events
```

### 关键断言清单（事件映射验证用）

实现 `PiAgentProvider` 的 `event-mapper.ts` 后，以下事件**必须**被正确映射：

| Pi 事件 | 映射到的 Octopus MessageChunk | 实测出现 |
|---------|------------------------------|----------|
| `message_start` | `message_start` | ✅ 4次 |
| `message_update` → `text_delta` | `text_delta` | ✅ 13次 |
| `message_end` | `text_done` + `message_stop` | ✅ 4次 |
| `tool_execution_start` | `tool_call_start` + `tool_call` | ✅ 1次 |
| `tool_execution_update` | `tool_progress` | ✅ 2次 |
| `tool_execution_end` | `tool_result` | ✅ 1次 |
| `agent_end` | `result`（含 tokens） | ✅ 1次 |
