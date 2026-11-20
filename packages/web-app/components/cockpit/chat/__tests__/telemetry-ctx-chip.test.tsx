// 2026-11-19 用户 #3：通讯台 CTX 芯片与 classic 同形 ——
// `80.1K / 1M · 8.0%` 一行读全，芯片内用淡填充 + 底边 2px 条表达占用比例；
// 分档配色与 classic ContextUsageChip 一致（≥60% 琥珀 / ≥85% 红）。

import { useEffect } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import type { ContextUsageData } from '@/lib/agent/types'
import { CockpitStateProvider, useCockpitState } from '../../state/CockpitStateProvider'
import type { CockpitChatApi } from '../../state/cockpit-state'
import { CockpitConsoleTelemetry } from '../CockpitConsoleTelemetry'

vi.mock('../../bridge/use-cabin-usage', () => ({
  useCabinUsage: () => ({ usage: null, stale: false }),
}))

function Probe({ chat }: { chat: CockpitChatApi }) {
  const { reportChat } = useCockpitState()
  useEffect(() => {
    reportChat(chat)
  }, [chat, reportChat])
  return <CockpitConsoleTelemetry />
}

function chatWith(contextUsage: ContextUsageData | null): CockpitChatApi {
  return {
    model: 'pro',
    effort: 'high',
    contextWindow: '1m',
    streaming: false,
    queueDepth: 0,
    canSend: true,
    contextUsage,
    usage: null,
    submit() {},
    stop() {},
    setModel() {},
    setEffort() {},
    setContext() {},
  }
}

function ctxOf(percentage: number, overrides: Partial<ContextUsageData> = {}): ContextUsageData {
  return {
    categories: [],
    totalTokens: 80100,
    maxTokens: 1_000_000,
    rawMaxTokens: 1_000_000,
    percentage,
    model: 'pro',
    ...overrides,
  }
}

function renderChip(contextUsage: ContextUsageData | null) {
  const { container } = render(
    <CockpitStateProvider entryCabinId="cabin-1">
      <Probe chat={chatWith(contextUsage)} />
    </CockpitStateProvider>,
  )
  return container
}

describe('通讯台 CTX 芯片 — 用量 / 上限 / 百分比 + 内部进度条', () => {
  it('显示 `80.1K / 1M` 与 `8.0%`，填充和底条都到 8%', async () => {
    renderChip(ctxOf(8))
    const chip = screen.getByTestId('cockpit-con-ctx')
    await waitFor(() => expect(chip).toHaveTextContent('80.1K / 1M'))
    expect(chip).toHaveTextContent('8.0%')
    expect(chip).toHaveTextContent('CTX')
    expect(chip.getAttribute('data-tone')).toBe('ok')
    expect(chip.querySelector<HTMLElement>('.ck12-ctx-fill')?.style.width).toBe('8%')
    expect(chip.querySelector<HTMLElement>('.ck12-ctx-bar > i')?.style.width).toBe('8%')
  })

  it('≥60% 切琥珀档，≥85% 切红档（与 classic 分档同源）', async () => {
    renderChip(ctxOf(72))
    const chip = screen.getByTestId('cockpit-con-ctx')
    await waitFor(() => expect(chip.getAttribute('data-tone')).toBe('warn'))

    renderChip(ctxOf(90))
    const chips = screen.getAllByTestId('cockpit-con-ctx')
    await waitFor(() => expect(chips[chips.length - 1].getAttribute('data-tone')).toBe('hot'))
  })

  it('估算值带 ~ 前缀；没有数据时显示未就绪、不出现进度条', async () => {
    renderChip(ctxOf(8, { estimated: true }))
    expect(screen.getByTestId('cockpit-con-ctx')).toHaveTextContent('~8.0%')

    renderChip(null)
    const chips = screen.getAllByTestId('cockpit-con-ctx')
    const empty = chips[chips.length - 1]
    expect(empty).toHaveTextContent('未就绪')
    expect(empty.querySelector('.ck12-ctx-bar')).toBeNull()
  })
})
