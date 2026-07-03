/**
 * 最小验证：Pi Agent SDK 流式事件 × 阿里云百炼 DashScope
 *
 * 验证目标：
 *   1. pi-ai 的 streamSimple() 能连 DashScope 并产出 AssistantMessageEvent 流
 *   2. pi-agent-core 的 Agent loop 能驱动工具调用并产出 AgentEvent 流
 *   3. 所有关键事件类型都会触发
 *
 * 前置条件：
 *   - DASHSCOPE_API_KEY 环境变量已设置
 *   - pnpm add @earendil-works/pi-ai @earendil-works/pi-agent-core @earendil-works/pi-coding-agent
 *
 * 运行：
 *   pnpm test --filter @octopus/providers -- --run pi-streaming-dashscope
 */

import { describe, it, expect } from 'vitest'

// ─── pi-ai (Layer 1: 纯 LLM 流式协议) ───
import {
  type Model,
  type Context,
  type AssistantMessageEvent,
  type AssistantMessage,
} from '@earendil-works/pi-ai'

// ─── pi-agent-core (Layer 2: Agent 循环 + 事件) ───
import { Agent, type AgentEvent } from '@earendil-works/pi-agent-core'

// ─── pi-coding-agent (Layer 3: 工具 + Session) ───
import {
  createAgentSession,
  createBashTool,
  createReadTool,
} from '@earendil-works/pi-coding-agent'

// ═══════════════════════════════════════════════════
// DashScope 模型定义（OpenAI-compatible API）
// ═══════════════════════════════════════════════════

const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const MODEL_ID = 'qwen3-max'

function makeDashScopeModel(): Model<any> {
  return {
    id: MODEL_ID,
    name: 'Qwen Max',
    api: 'openai-completions',
    provider: 'dashscope' as any,
    baseUrl: DASHSCOPE_BASE_URL,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
  } as any
}

// 收集事件的工具函数
function collectEvents<T>(events: T[], label: string) {
  const counts = new Map<string, number>()
  for (const e of events) {
    const type = (e as any).type
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  console.log(`\n═══ ${label} 事件统计 ═══`)
  for (const [type, count] of counts) {
    console.log(`  ${type}: ${count}`)
  }
  console.log(`  总计: ${events.length} events`)
  return counts
}

// ═══════════════════════════════════════════════════
// Test 1: pi-ai 原始流式协议
// ═══════════════════════════════════════════════════

describe('Pi Streaming Events × DashScope', () => {
  it('pi-ai: streamSimple 产出 AssistantMessageEvent 流', async () => {
    // 动态 import compat 层（pi-ai 的 streamSimple 入口）
    const { streamSimple } = await import('@earendil-works/pi-ai/compat')

    const model = makeDashScopeModel()
    const apiKey = process.env.DASHSCOPE_API_KEY
    expect(apiKey, 'DASHSCOPE_API_KEY 环境变量未设置').toBeTruthy()

    const context: Context = {
      messages: [
        {
          role: 'user',
          content: '用一句话介绍你自己，然后计算 17 × 23 = ?',
          timestamp: Date.now(),
        },
      ],
    }

    console.log(`\n→ pi-ai streamSimple: ${model.id} @ ${model.baseUrl}`)

    const events: AssistantMessageEvent[] = []
    let finalMessage: AssistantMessage | undefined

    const stream = streamSimple(model, context, { apiKey })

    for await (const event of stream) {
      events.push(event)

      // 实时打印关键事件
      switch (event.type) {
        case 'text_delta':
          process.stdout.write(event.delta)
          break
        case 'thinking_delta':
          // 思考内容（如果模型支持）
          break
        case 'done':
          finalMessage = event.message
          console.log(`\n  [done] reason=${event.reason}`)
          break
        case 'error':
          console.log(`\n  [error] reason=${event.reason}`)
          break
      }
    }

    const counts = collectEvents(events, 'pi-ai AssistantMessageEvent')

    // ── 断言：必须出现的事件类型 ──
    expect(counts.has('start'), '缺少 start 事件').toBe(true)
    expect(counts.has('text_delta'), '缺少 text_delta 事件（文本流）').toBe(true)
    expect(counts.has('done'), '缺少 done 事件').toBe(true)

    // ── 断言：最终消息 ──
    expect(finalMessage, 'done 事件应包含 final message').toBeDefined()
    expect(finalMessage!.content.length, 'final message 应有内容').toBeGreaterThan(0)

    const textContent = finalMessage!.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('')
    expect(textContent.length, '文本内容不应为空').toBeGreaterThan(0)
    console.log(`\n  最终文本 (${textContent.length} chars): ${textContent.slice(0, 200)}`)

    // ── 断言：usage 数据 ──
    if (finalMessage!.usage) {
      console.log(`  usage: input=${finalMessage!.usage.input}, output=${finalMessage!.usage.output}, total=${finalMessage!.usage.totalTokens}`)
      expect(finalMessage!.usage.totalTokens, 'totalTokens 应大于 0').toBeGreaterThan(0)
    }
  }, 60_000)

  // ═══════════════════════════════════════════════════
  // Test 2: pi-agent-core Agent 循环事件
  // ═══════════════════════════════════════════════════

  it('pi-agent-core: Agent loop 产出 AgentEvent 流（含工具调用）', async () => {
    const { streamSimple } = await import('@earendil-works/pi-ai/compat')

    const model = makeDashScopeModel()
    const apiKey = process.env.DASHSCOPE_API_KEY!
    const cwd = process.cwd()

    // 创建 Pi 内置工具（bash + read）
    const tools = [createBashTool(cwd), createReadTool(cwd)]

    console.log(`\n→ pi-agent-core Agent: ${model.id}, tools=[${tools.map(t => t.name).join(', ')}]`)

    const agent = new Agent({
      streamFn: (m, ctx, opts) => streamSimple(m, ctx, { ...opts, apiKey }),
      getApiKey: async () => apiKey,
    })

    // 设置工具和模型
    agent.state.model = model
    agent.state.tools = tools

    const events: AgentEvent[] = []

    agent.subscribe((event) => {
      events.push(event)

      switch (event.type) {
        case 'message_update': {
          const sub = event.assistantMessageEvent
          if (sub.type === 'text_delta') {
            process.stdout.write(sub.delta)
          }
          break
        }
        case 'tool_execution_start':
          console.log(`\n  [tool_start] ${event.toolName}(${JSON.stringify(event.args).slice(0, 80)})`)
          break
        case 'tool_execution_end':
          console.log(`  [tool_end] ${event.toolName} → ${(event.result?.content?.[0]?.text ?? '').slice(0, 80)}`)
          break
        case 'agent_end':
          console.log(`\n  [agent_end] messages=${event.messages.length}`)
          break
      }
    })

    // 运行 agent（要求它使用 bash 工具）
    await agent.prompt('用 bash 工具运行 echo "hello from pi × dashscope"，然后告诉我输出结果。')

    const counts = collectEvents(events, 'pi-agent-core AgentEvent')

    // ── 断言：Agent 生命周期 ──
    expect(counts.has('agent_start'), '缺少 agent_start').toBe(true)
    expect(counts.has('agent_end'), '缺少 agent_end').toBe(true)
    expect(counts.has('turn_start'), '缺少 turn_start').toBe(true)
    expect(counts.has('turn_end'), '缺少 turn_end').toBe(true)

    // ── 断言：消息事件 ──
    expect(counts.has('message_start'), '缺少 message_start').toBe(true)
    expect(counts.has('message_update'), '缺少 message_update（LLM 流式输出）').toBe(true)
    expect(counts.has('message_end'), '缺少 message_end').toBe(true)

    // ── 断言：工具执行事件 ──
    expect(counts.has('tool_execution_start'), '缺少 tool_execution_start（工具未被调用）').toBe(true)
    expect(counts.has('tool_execution_end'), '缺少 tool_execution_end').toBe(true)

    // ── 断言：工具确实被调用了 ──
    const toolStartEvents = events.filter(e => e.type === 'tool_execution_start')
    expect(
      toolStartEvents.some(e => (e as any).toolName === 'bash'),
      'bash 工具应被调用'
    ).toBe(true)
  }, 120_000)

  // ═══════════════════════════════════════════════════
  // Test 3: pi-coding-agent AgentSession 完整流程
  // ═══════════════════════════════════════════════════

  it('pi-coding-agent: AgentSession 完整流程（Session + Extension + Tools）', async () => {
    const apiKey = process.env.DASHSCOPE_API_KEY!
    const model = makeDashScopeModel()

    console.log(`\n→ pi-coding-agent AgentSession: ${model.id}`)

    // 创建 ModelRegistry 并注册 DashScope 提供商（含 API Key）
    const { ModelRegistry, AuthStorage } = await import('@earendil-works/pi-coding-agent')

    const authStorage = AuthStorage.inMemory()
    const modelRegistry = ModelRegistry.inMemory(authStorage)
    modelRegistry.registerProvider('dashscope', {
      name: 'DashScope',
      baseUrl: DASHSCOPE_BASE_URL,
      apiKey,
      api: 'openai-completions',
      models: [{
        id: MODEL_ID,
        name: 'Qwen Max',
        api: 'openai-completions',
        reasoning: false,
        input: ['text'] as ('text' | 'image')[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 4096,
      }],
    })

    // 创建 headless AgentSession（传入预配置的 modelRegistry）
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      model,
      modelRegistry,
      customTools: [],
    })

    // 收集 AgentSession 事件
    type SessionEvent = { type: string; [key: string]: any }
    const events: SessionEvent[] = []

    session.subscribe((event: any) => {
      events.push(event)

      switch (event.type) {
        case 'message_update': {
          const sub = event.assistantMessageEvent
          if (sub?.type === 'text_delta') {
            process.stdout.write(sub.delta)
          }
          break
        }
        case 'tool_execution_start':
          console.log(`\n  [tool_start] ${event.toolName}`)
          break
        case 'tool_execution_end':
          console.log(`  [tool_end] ${event.toolName}`)
          break
      }
    })

    // 运行
    await session.prompt('用 bash 运行 date 命令，告诉我现在几点。简短回答。')

    const counts = collectEvents(events, 'pi-coding-agent AgentSessionEvent')

    // ── 核心断言 ──
    expect(counts.has('agent_start'), '缺少 agent_start').toBe(true)
    expect(counts.has('agent_end'), '缺少 agent_end').toBe(true)
    expect(counts.has('message_update'), '缺少 message_update').toBe(true)
    expect(counts.has('tool_execution_start'), '缺少 tool_execution_start').toBe(true)
    expect(counts.has('tool_execution_end'), '缺少 tool_execution_end').toBe(true)

    // Session 特有事件（entry_appended 仅在文件持久化模式下触发，in-memory session 可能没有）
    // expect(counts.has('entry_appended'), '缺少 entry_appended（Session 持久化事件）').toBe(true)

    console.log(`\n  sessionId: ${session.sessionId}`)
    console.log(`  messages: ${session.messages.length}`)

    session.dispose()
  }, 120_000)
})
