/**
 * 真 SDK 子进程集成测试 —— 钉死手动 `/compact` 的收尾形状。
 *
 * 背景（2026-11-04 用户反馈）：在对话里发 `/compact` 后没有任何反馈，composer
 * 下方的 ctx 角标也不动，要再发一条消息才更新。
 *
 * 真机实测（SDK 0.3.235）确认 SDK 侧的事实：
 *   1. 压缩成功只发 `system:status compacting` → `status null` → `system:init`
 *      → `system:compact_boundary`（带 pre/post token 账），**没有任何 assistant
 *      消息**，result 正文为空（`num_turns: 0`，modelUsage 仍带摘要调用的用量）；
 *   2. 这一轮没有 `stream_event.message_start`，所以旧的「message_start 时报一次
 *      ctx」永远等不到 —— 角标只能停在压缩前；
 *   3. `compact_boundary` 到达时 query 仍存活，`getContextUsage()` 已能看到压缩后
 *      的真实占用。
 *
 * 本测试验证 provider 现在的行为：boundary 当轮就吐 `context_usage`，并为手动
 * 压缩补一条可见回执（result 之前），最后正常收轮。
 *
 * 网络 + 真实计费，CI 默认跳过：
 *
 *   OCTOPUS_SDK_INTEGRATION=1 pnpm --filter @octopus/providers exec vitest run claude-compact
 *
 * 认证沿用本机 `~/.claude/settings.json` 的 env（与 ClaudeSDKProvider 的
 * buildSubprocessEnv 同源），未配置 auth 时不要打开本测试。
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ClaudeSDKProvider } from '../claude/provider'
import type { MessageChunk } from '../types'

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

async function collect(
  provider: ClaudeSDKProvider,
  prompt: string,
  resume?: string,
  extra?: { interruptible?: boolean },
): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = []
  for await (const chunk of provider.sendQuery(prompt, CWD, resume, {
    env: subprocessEnv() as Record<string, string>,
    ...(extra ?? {}),
  })) {
    chunks.push(chunk)
  }
  return chunks
}

function sessionOf(chunks: MessageChunk[]): string | undefined {
  return (chunks.find((c) => c.type === 'result') as
    | Extract<MessageChunk, { type: 'result' }>
    | undefined)?.sessionId
}

describe.skipIf(!RUN)('SDK /compact（真实子进程）', () => {
  it('压缩成功：boundary 当轮刷 ctx，并补一条可见回执', async () => {
    const provider = new ClaudeSDKProvider()

    // 先垫两轮内容，否则 CLI 会答「Not enough messages to compact.」。
    const seed1 = await collect(
      provider,
      'Write about 150 words about the history of tea. Plain prose, no tools.',
    )
    const sessionId = sessionOf(seed1)
    expect(sessionId).toBeTruthy()

    await collect(
      provider,
      'Write about 150 words about the history of coffee. Plain prose, no tools.',
      sessionId,
    )

    // 与聊天路径同形：streaming input（interruptible）+ resume。
    const compact = await collect(provider, '/compact', sessionId, { interruptible: true })

    const ctx = compact.find((c) => c.type === 'context_usage') as
      | Extract<MessageChunk, { type: 'context_usage' }>
      | undefined
    expect(ctx).toBeDefined()
    expect(ctx!.data.totalTokens).toBeGreaterThan(0)

    const receipt = compact.find((c) => c.type === 'local_command_output') as
      | Extract<MessageChunk, { type: 'local_command_output' }>
      | undefined
    expect(receipt).toBeDefined()
    expect(receipt!.content).toContain('上下文已压缩')

    const receiptIdx = compact.findIndex((c) => c.type === 'local_command_output')
    const resultIdx = compact.findIndex((c) => c.type === 'result')
    expect(resultIdx).toBeGreaterThan(receiptIdx)
    expect(sessionOf(compact)).toBe(sessionId)
  }, 300_000)
})
