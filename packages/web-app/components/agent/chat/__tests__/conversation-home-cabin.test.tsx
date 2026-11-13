// 桌面壳内的作战舱上下文切换：新建/进舱/退出都不改路由（2026-11-13 原型对齐）。
// 这里 mock 掉重组件，只锁 ConversationHome 的三态与 cabinBridge 接线。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/components/agent/chat/ChatTab', () => ({
  ChatTab: ({ cabinBridge }: { cabinBridge?: { drafting: boolean; cabins: unknown[] } }) => (
    <div data-testid="chat-tab" data-drafting={String(!!cabinBridge?.drafting)} data-cabins={cabinBridge?.cabins.length ?? -1} />
  ),
}))

vi.mock('@/components/cabin/CabinDesktopHost', () => ({
  CabinDesktopHost: ({ cabinId }: { cabinId: string }) => <div data-testid="cabin-host">{cabinId}</div>,
}))

vi.mock('@/hooks/use-cabins', () => ({
  useCabins: () => ({ cabins: [{ id: 'c1' }, { id: 'c2' }], loading: false }),
}))

import { ConversationHome } from '../ConversationHome'
import { CabinModeProvider, useCabinMode } from '@/components/cabin/cabin-mode'

function ModeControls() {
  const mode = useCabinMode()
  return (
    <div>
      <button type="button" onClick={() => mode.startDraft()}>draft</button>
      <button type="button" onClick={() => mode.openCabin('c1')}>open</button>
      <button type="button" onClick={() => mode.exitCabin()}>exit</button>
    </div>
  )
}

describe('ConversationHome — 桌面内作战舱三态', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('普通对话 → pendingCabin → 舱上下文 → 返回对话，全部留在同一壳内', () => {
    render(
      <CabinModeProvider>
        <ModeControls />
        <ConversationHome />
      </CabinModeProvider>,
    )

    expect(screen.getByTestId('chat-tab')).toHaveAttribute('data-drafting', 'false')
    // 左栏桥：桌面也拿到完整舱列表（→ 作战舱段/状态圈）。
    expect(screen.getByTestId('chat-tab')).toHaveAttribute('data-cabins', '2')
    expect(screen.queryByTestId('cabin-host')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('draft'))
    expect(screen.getByTestId('chat-tab')).toHaveAttribute('data-drafting', 'true')
    expect(screen.queryByTestId('cabin-host')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('open'))
    expect(screen.queryByTestId('chat-tab')).not.toBeInTheDocument()
    expect(screen.getByTestId('cabin-host')).toHaveTextContent('c1')

    fireEvent.click(screen.getByText('exit'))
    expect(screen.getByTestId('chat-tab')).toBeInTheDocument()
    expect(screen.queryByTestId('cabin-host')).not.toBeInTheDocument()
  })
})
