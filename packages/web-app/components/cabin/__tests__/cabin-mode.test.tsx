import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CabinModeProvider, useCabinMode } from '../cabin-mode'
import { CABIN_DRAFT_KEY, CABIN_DRAFT_TTL } from '@/lib/cabin-draft'

function Probe() {
  const mode = useCabinMode()
  return (
    <div>
      <span data-testid="active">{mode.activeCabinId ?? 'none'}</span>
      <span data-testid="drafting">{String(mode.drafting)}</span>
      <span data-testid="draftOpen">{String(mode.draftOpen)}</span>
      <span data-testid="draftName">{mode.draft?.name || 'none'}</span>
      <span data-testid="draftPath">{mode.draft?.path ?? 'none'}</span>
      <button type="button" onClick={() => mode.openCabin('c1')}>open</button>
      <button type="button" onClick={() => mode.startDraft()}>draft</button>
      <button type="button" onClick={() => mode.updateDraft({ name: '账本舱', path: '/tmp/ledger' })}>update</button>
      <button type="button" onClick={() => mode.closeDraft()}>close</button>
      <button type="button" onClick={() => mode.cancelDraft()}>cancel</button>
      <button type="button" onClick={() => mode.exitCabin()}>exit</button>
    </div>
  )
}

describe('CabinModeProvider — 桌面内切舱 / 新建不在新路由', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('openCabin 落 active 状态并持久化；exitCabin 清掉', () => {
    render(<CabinModeProvider><Probe /></CabinModeProvider>)
    expect(screen.getByTestId('active')).toHaveTextContent('none')

    fireEvent.click(screen.getByText('open'))
    expect(screen.getByTestId('active')).toHaveTextContent('c1')
    expect(window.localStorage.getItem('octopus.cabin.active.v1')).toBe('c1')

    fireEvent.click(screen.getByText('exit'))
    expect(screen.getByTestId('active')).toHaveTextContent('none')
    expect(window.localStorage.getItem('octopus.cabin.active.v1')).toBeNull()
  })

  it('startDraft 退出当前舱并进入新建页；cancelDraft 丢弃草稿', () => {
    render(<CabinModeProvider><Probe /></CabinModeProvider>)
    fireEvent.click(screen.getByText('open'))
    expect(screen.getByTestId('active')).toHaveTextContent('c1')

    fireEvent.click(screen.getByText('draft'))
    expect(screen.getByTestId('active')).toHaveTextContent('none')
    expect(screen.getByTestId('drafting')).toHaveTextContent('true')
    expect(screen.getByTestId('draftName')).toHaveTextContent('none')
    expect(window.localStorage.getItem('octopus.cabin.active.v1')).toBeNull()

    fireEvent.click(screen.getByText('cancel'))
    expect(screen.getByTestId('drafting')).toHaveTextContent('false')
    expect(screen.getByTestId('draftName')).toHaveTextContent('none')
  })

  it('v4：走开（openCabin / closeDraft）只关右页，草稿留着', () => {
    render(<CabinModeProvider><Probe /></CabinModeProvider>)
    fireEvent.click(screen.getByText('draft'))
    fireEvent.click(screen.getByText('update'))
    expect(screen.getByTestId('draftName')).toHaveTextContent('账本舱')

    fireEvent.click(screen.getByText('open'))
    expect(screen.getByTestId('active')).toHaveTextContent('c1')
    expect(screen.getByTestId('draftOpen')).toHaveTextContent('false')
    expect(screen.getByTestId('draftName')).toHaveTextContent('账本舱')

    fireEvent.click(screen.getByText('close'))
    expect(screen.getByTestId('draftOpen')).toHaveTextContent('false')
    expect(screen.getByTestId('draftName')).toHaveTextContent('账本舱')
  })

  it('v4：草稿落 localStorage，刷新（重新挂载）还在；24h 过期丢弃', () => {
    const first = render(<CabinModeProvider><Probe /></CabinModeProvider>)
    fireEvent.click(screen.getByText('draft'))
    fireEvent.click(screen.getByText('update'))
    const stored = JSON.parse(window.localStorage.getItem(CABIN_DRAFT_KEY) ?? '{}')
    expect(stored.name).toBe('账本舱')
    first.unmount()

    render(<CabinModeProvider><Probe /></CabinModeProvider>)
    expect(screen.getByTestId('draftName')).toHaveTextContent('账本舱')
    expect(screen.getByTestId('draftPath')).toHaveTextContent('/tmp/ledger')
    // 刷新后不自动抢右页。
    expect(screen.getByTestId('draftOpen')).toHaveTextContent('false')
  })

  it('v4：草稿超过 24h 丢弃', () => {
    window.localStorage.setItem(
      CABIN_DRAFT_KEY,
      JSON.stringify({ name: '旧舱', path: null, projects: [], requirements: '', updatedAt: Date.now() - CABIN_DRAFT_TTL - 1000 }),
    )
    render(<CabinModeProvider><Probe /></CabinModeProvider>)
    expect(screen.getByTestId('draftName')).toHaveTextContent('none')
    expect(window.localStorage.getItem(CABIN_DRAFT_KEY)).toBeNull()
  })

  it('启动时从 localStorage 恢复上次的舱', () => {
    window.localStorage.setItem('octopus.cabin.active.v1', 'c9')
    render(<CabinModeProvider><Probe /></CabinModeProvider>)
    expect(screen.getByTestId('active')).toHaveTextContent('c9')
  })

  it('没有 provider 时回落到普通对话（不抛错）', () => {
    render(<Probe />)
    expect(screen.getByTestId('active')).toHaveTextContent('none')
    expect(screen.getByTestId('drafting')).toHaveTextContent('false')
    fireEvent.click(screen.getByText('open'))
    expect(screen.getByTestId('active')).toHaveTextContent('none')
  })
})