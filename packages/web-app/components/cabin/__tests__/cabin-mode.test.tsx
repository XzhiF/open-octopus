import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CabinModeProvider, useCabinMode } from '../cabin-mode'

function Probe() {
  const mode = useCabinMode()
  return (
    <div>
      <span data-testid="active">{mode.activeCabinId ?? 'none'}</span>
      <span data-testid="drafting">{String(mode.drafting)}</span>
      <button type="button" onClick={() => mode.openCabin('c1')}>open</button>
      <button type="button" onClick={() => mode.startDraft()}>draft</button>
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

  it('startDraft 退出当前舱并进入 pendingCabin；cancelDraft 回普通对话', () => {
    render(<CabinModeProvider><Probe /></CabinModeProvider>)
    fireEvent.click(screen.getByText('open'))
    expect(screen.getByTestId('active')).toHaveTextContent('c1')

    fireEvent.click(screen.getByText('draft'))
    expect(screen.getByTestId('active')).toHaveTextContent('none')
    expect(screen.getByTestId('drafting')).toHaveTextContent('true')
    expect(window.localStorage.getItem('octopus.cabin.active.v1')).toBeNull()

    fireEvent.click(screen.getByText('cancel'))
    expect(screen.getByTestId('drafting')).toHaveTextContent('false')
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
