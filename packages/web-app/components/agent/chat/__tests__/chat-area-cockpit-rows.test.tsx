// 全域座舱 · 主 chat 行（2026-11-20 用户 #10 · C 版 classic TUI）：
//   · 去掉左侧固定标签列与时间 gutter；用户行 `❯ YOU` 与正文同行；
//   · 助手行头「✦ 汐音」与统计挤同一行，正文 / 过程贴同一左缘；
//   · 时间 + 复制常显在首行最右（不是悬停才出现）。

import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ChatArea } from '../ChatArea'
import type { AgentMessage, ToolCallRecord } from '@/lib/agent/types'

const copied: string[] = []
vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>()
  return {
    ...actual,
    copyToClipboard: vi.fn((text: string) => {
      copied.push(text)
      return true
    }),
  }
})

const baseProps = {
  messages: [] as AgentMessage[],
  streaming: false,
  streamContent: '',
  streamThinking: '',
  isThinking: false,
  toolCalls: [] as ToolCallRecord[],
  pendingConfirm: null,
  error: null,
  statusMessage: '',
  onSend: vi.fn(),
  onStop: vi.fn(),
  onConfirm: vi.fn(),
  hasSession: true,
  currentModel: 'pro',
  onModelChange: vi.fn(),
  tui: true,
  composerVariant: 'cockpit' as const,
}

const userMsg: AgentMessage = {
  id: 'u1',
  session_id: 's1',
  role: 'user',
  content: '好',
  created_at: '2026-11-20T09:32:00',
  is_summary: false,
  is_compressed: false,
  is_edited: false,
}

const aiMsg: AgentMessage = {
  id: 'a1',
  session_id: 's1',
  role: 'assistant',
  content: '收到。',
  created_at: '2026-11-20T09:33:00',
  is_summary: false,
  is_compressed: false,
  is_edited: false,
  turnStats: {
    durationMs: 1200,
    calls: 1,
    tokens: 245,
    inputTokens: 245,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheHitRate: null,
    costUsd: 0.001,
    costComplete: true,
    models: ['pro'],
  },
}

describe('ChatArea · 全域座舱主 chat 行（C 版）', () => {
  it('去掉标签列：用户行 `❯ YOU` 与正文同一行，不再有角色 / 时间列', () => {
    const { container } = render(<ChatArea {...baseProps} messages={[userMsg, aiMsg]} />)
    expect(container.querySelector('.ck12-tui-role')).toBeNull()
    expect(container.querySelector('.ck12-tui-time')).toBeNull()
    const user = container.querySelector('[data-tui-msg="user"]')!
    expect(user.textContent).toContain('❯ YOU')
    expect(user.textContent).toContain('好')
  })

  it('助手行头 ✦ 汐音 与统计同一行', () => {
    const { container } = render(<ChatArea {...baseProps} messages={[userMsg, aiMsg]} />)
    const tag = container.querySelector('.ck12-tui-tag:not(.is-you)')
    expect(tag?.textContent).toBe('✦ 汐音')
    expect(tag!.closest('[data-tui-meta-root]')).toBeTruthy()
    expect(container.textContent).toContain('已完成')
  })

  it('时间 + 复制常显（每条消息各一份），不是悬停才出现', () => {
    const { container } = render(<ChatArea {...baseProps} messages={[userMsg, aiMsg]} />)
    const acts = container.querySelectorAll('[data-testid="cockpit-msgacts"]')
    expect(acts).toHaveLength(2)
    for (const a of acts) expect(a.textContent).toMatch(/\d{1,2}:\d{2}/)
    expect(acts[0].querySelector('[data-testid="cockpit-msgacts-copy"]')).toBeTruthy()
  })

  it('点复制 → 把该条正文写进剪贴板，按钮进入已复制态', () => {
    copied.length = 0
    const { container } = render(<ChatArea {...baseProps} messages={[userMsg, aiMsg]} />)
    const aiActs = container.querySelectorAll('[data-testid="cockpit-msgacts"]')[1]
    fireEvent.click(aiActs.querySelector('[data-testid="cockpit-msgacts-copy"]')!)
    expect(copied).toEqual(['收到。'])
    expect(aiActs.className).toContain('is-copied')
  })

  it('流式过程挂同款助手行头：✦ 汐音 + 输出中…', () => {
    const { container } = render(
      <ChatArea
        {...baseProps}
        streaming
        streamTimeline={[{ kind: 'thinking', id: 't1', text: '正在读取 manifest…', active: true }]}
      />,
    )
    const live = container.querySelector('.ck12-tui-livehead')!
    expect(live.textContent).toContain('✦ 汐音')
    expect(live.textContent).toContain('输出中…')
  })
})
