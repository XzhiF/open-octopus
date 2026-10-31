/**
 * 真 SDK 子进程集成测试 —— 钉死「中断时能不能拿到 token 消耗」。
 *
 * 背景（2026-10-31）：主对话中断后账本没有这一轮的用量。上一轮调研发现
 * 落账只挂在 result chunk 上，而停止按钮走 abortController 硬中断。
 * SDK 官方文档（code.claude.com/docs/en/agent-sdk）给出的三条事实：
 *
 *   1. `interrupt()` 只在 **streaming input mode** 可用；single message input
 *      mode 不支持 real-time interruption；
 *   2. clean interrupt 时，被中断轮的 `SDKResultMessage` 仍会产出（receipt
 *      先于它到达）；
 *   3. 所有 result 变体（含 error_during_execution）都带 usage / modelUsage /
 *      total_cost_usd —— 「cancelled request」就是 error_during_execution。
 *
 * 本文件用真实 SDK 子进程验证上述事实，并量化两个边界：
 *   ① 现状（abortController + string prompt）→ 迭代器抛错，**没有 result**，token 全丢；
 *   ② 正解（streaming input + interrupt()，打断工具执行）→ result 带**真实非零** usage；
 *   ③ 边界（interrupt() 打断首条模型消息本身）→ result 存在但 usage **归零**
 *      （被取消的 API 调用本身无终值可计 —— 任何方案都拿不到这一条）。
 *
 * 这些是网络 + 真实计费的行为，CI 默认跳过：
 *
 *   OCTOPUS_SDK_INTEGRATION=1 pnpm --filter @octopus/providers exec vitest run claude-interrupt
 *
 * 认证沿用本机 `~/.claude/settings.json` 的 env（与 ClaudeSDKProvider 的
 * buildSubprocessEnv 同源），未配置 auth 时不要打开本测试。
 */

import { describe, it, expect } from 'vitest'
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeSDKProvider } from '../claude/provider'
import fs from 'fs'
import os from 'os'
import path from 'path'

const RUN = process.env.OCTOPUS_SDK_INTEGRATION === '1'

/** 与 providers/src/claude/provider.ts buildSubprocessEnv 同源的最小版本。 */
function subprocessEnv(): NodeJS.ProcessEnv {
  let settingsEnv: Record<string, string> = {}
  try {
    settingsEnv = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'),
    ).env ?? {}
  } catch { /* 无 settings.json → 依赖 process.env */ }
  return {
    ...process.env,
    ...settingsEnv,
    ...(process.env.ANTHROPIC_API_KEY || settingsEnv.ANTHROPIC_API_KEY
      ? {}
      : { CLAUDE_USE_GLOBAL_AUTH: 'true' }),
  }
}

const CWD = os.tmpdir()

function baseOptions(extra?: Options): Options {
  return {
    cwd: CWD,
    maxTurns: 1,
    includePartialMessages: true,
    settingSources: [],
    env: subprocessEnv(),
    ...extra,
  }
}

const LONG_PROMPT =
  'Write a very long detailed essay (at least 2000 words) about the history of chess. Do not use any tools.'

type ResultMessage = Extract<SDKMessage, { type: 'result' }>

function isResult(m: SDKMessage): m is ResultMessage {
  return m.type === 'result'
}

/** 流事件里的内容增量（thinking/text 都算），用于挑中断时机。 */
function isContentDelta(m: SDKMessage): boolean {
  if (m.type !== 'stream_event') return false
  const e = m.event as { type?: string }
  return e.type === 'content_block_delta'
}

function tokenSum(usage: Record<string, unknown> | undefined): number {
  if (!usage) return 0
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  // 原始 SDK result：snake_case；Octopus provider chunk：规范 camelCase。
  return n(usage.input_tokens) + n(usage.output_tokens)
    + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens)
    + n(usage.inputTokens) + n(usage.outputTokens)
    + n(usage.cacheReadTokens) + n(usage.cacheCreationTokens)
}

describe.skipIf(!RUN)('SDK 中断机制 × token 账本（真实子进程）', () => {
  it('① 现状：abortController 硬中断没有 result —— 用量无从获取', async () => {
    const ac = new AbortController()
    const seen: SDKMessage[] = []
    let threw: unknown = null

    // 400ms 后硬中断（等首个模型事件出现，避免打断启动阶段）。
    let armed = false
    const arm = () => {
      if (armed) return
      armed = true
      setTimeout(() => ac.abort(), 400)
    }

    try {
      for await (const m of query({ prompt: LONG_PROMPT, options: baseOptions({ abortController: ac }) })) {
        seen.push(m)
        if (isContentDelta(m)) arm()
        if (isResult(m)) break
      }
    } catch (err) {
      threw = err
    }

    // 事实①：迭代器以异常结束，且全程没有任何 result message。
    expect(seen.some(isResult)).toBe(false)
    expect(threw).not.toBeNull()
  }, 120_000)

  it('② 正解：streaming input + interrupt()（工具执行中）→ result 带真实 usage', async () => {
    let releaseInput!: () => void
    const inputDone = new Promise<void>((r) => { releaseInput = r })
    async function* input() {
      yield {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content: 'Use the Bash tool to run: node -e "setTimeout(()=>console.log(\'tool-done\'),8000)". Then report what it printed.',
        },
        parent_tool_use_id: null,
      }
      await inputDone
    }

    const q = query({
      prompt: input(),
      options: baseOptions({
        maxTurns: 3,
        allowedTools: ['Bash'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      }),
    })

    let result: ResultMessage | null = null
    let interrupted = false
    try {
      for await (const m of q) {
        // 首个 tool_use 出现 ⇒ 第一条模型消息已完成；等工具真正开跑再中断。
        if (!interrupted && m.type === 'assistant'
          && Array.isArray(m.message?.content)
          && m.message.content.some((b) => b.type === 'tool_use')) {
          interrupted = true
          await new Promise((r) => setTimeout(r, 700))
          const receipt = await q.interrupt()
          expect(receipt === undefined || Array.isArray(receipt.still_queued)).toBe(true)
        }
        if (isResult(m)) { result = m; break }
      }
    } finally {
      releaseInput()
    }

    expect(interrupted).toBe(true)
    expect(result).not.toBeNull()
    // 被中断轮仍产出 result；terminal_reason 指明是哪种中断。
    expect(result!.subtype).toBe('error_during_execution')
    expect((result as { terminal_reason?: string }).terminal_reason).toBe('aborted_tools')
    // 已完成的那次模型调用用量是真实值 —— 这正是账本要记的钱。
    expect(tokenSum(result!.usage as unknown as Record<string, unknown>)).toBeGreaterThan(0)
    expect(Object.keys(result!.modelUsage ?? {}).length).toBeGreaterThan(0)
  }, 120_000)

  it('③ 边界：interrupt() 打断首条模型消息本身 → result 存在但 usage 归零', async () => {
    let releaseInput!: () => void
    const inputDone = new Promise<void>((r) => { releaseInput = r })
    async function* input() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: LONG_PROMPT },
        parent_tool_use_id: null,
      }
      await inputDone
    }

    const q = query({ prompt: input(), options: baseOptions() })
    let result: ResultMessage | null = null
    let fired = false
    try {
      for await (const m of q) {
        if (!fired && isContentDelta(m)) {
          fired = true
          await new Promise((r) => setTimeout(r, 400))
          await q.interrupt()
        }
        if (isResult(m)) { result = m; break }
      }
    } finally {
      releaseInput()
    }

    expect(result).not.toBeNull()
    expect(result!.subtype).toBe('error_during_execution')
    expect((result as { terminal_reason?: string }).terminal_reason).toBe('aborted_streaming')
    // 文档钉死的边界：被取消的这一次 API 调用没有终值，主循环 usage 全 0。
    // 任何实现都拿不到这条（不是 Octopus 的 bug，是计费事实）。
    expect(tokenSum(result!.usage as unknown as Record<string, unknown>)).toBe(0)
  }, 120_000)

  it('④ Octopus provider（interruptible）在工具执行中被打断 → 吐带用量的 error chunk', async () => {
    const ac = new AbortController()
    const provider = new ClaudeSDKProvider()
    const chunks: Array<Record<string, unknown>> = []
    let sawToolCall = false

    for await (const chunk of provider.sendQuery(
      'Use the Bash tool to run: node -e "setTimeout(()=>console.log(\'tool-done\'),8000)". Then report what it printed.',
      CWD,
      undefined,
      {
        interruptible: true,
        abortSignal: ac.signal,
        maxTurns: 3,
        env: subprocessEnv() as Record<string, string>,
      },
    )) {
      chunks.push(chunk as unknown as Record<string, unknown>)
      // 工具入参完整（tool_call）⇒ 第一条模型消息已完成；稍等工具开跑再停。
      if (chunk.type === 'tool_call' && !sawToolCall) {
        sawToolCall = true
        await new Promise((r) => setTimeout(r, 700))
        ac.abort()
      }
    }

    expect(sawToolCall).toBe(true)
    const err = chunks.find((c) => c.type === 'error')
    expect(err).toBeDefined()
    expect(err!.code).toBe('error_during_execution')
    // 被中断轮的 result 用量被 provider 透传下来 —— 这就是路由落账的数据源。
    expect(tokenSum(err!.usage as Record<string, unknown>)).toBeGreaterThan(0)
    expect((err!.modelUsages as unknown[]).length).toBeGreaterThan(0)
  }, 120_000)
})
