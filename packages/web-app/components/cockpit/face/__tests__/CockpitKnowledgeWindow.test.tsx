// v22 #7（2026-11-23 用户）：全舱知识中心窗。
//   · HUD「⚛ 知识中心」→ openCockpitKnowledge() 开窗；
//   · 内容 = /knowledge 页面原样嵌入（embedded：页面自己的标题条让位，不双标题）；
//   · ✕ / Esc（层栈）都能收窗。

import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { CockpitStateProvider } from '../../state/CockpitStateProvider'
import { CockpitLayerStack } from '../../state/CockpitLayerStack'
import { CockpitKnowledgeWindow, openCockpitKnowledge } from '../CockpitKnowledgeWindow'

vi.mock('@/app/knowledge/page', () => ({
  default: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="kc-page-stub" data-embedded={embedded ? '1' : '0'}>知识中心页面桩</div>
  ),
}))

function openWindow() {
  return render(
    <CockpitStateProvider entryCabinId="c1">
      <CockpitLayerStack>
        <CockpitKnowledgeWindow />
      </CockpitLayerStack>
    </CockpitStateProvider>,
  )
}

describe('CockpitKnowledgeWindow — 全舱知识中心', () => {
  it('默认不挂；打开后窗口头是 ⚛ 知识中心，正文嵌入 /knowledge（embedded）', async () => {
    openWindow()
    expect(screen.queryByTestId('cockpit-knowledge-win')).toBeNull()

    act(() => openCockpitKnowledge())
    expect(screen.getByTestId('cockpit-knowledge-win')).toBeTruthy()
    const head = screen.getByTestId('cockpit-knowledge-head')
    expect(head.textContent).toContain('⚛')
    expect(head.textContent).toContain('知识中心')
    expect(head.textContent).toContain('GLOBAL WIKI')

    // lazy /knowledge 页面：嵌入模式（页面头让位给窗口头）。
    const stub = await screen.findByTestId('kc-page-stub')
    expect(stub).toHaveAttribute('data-embedded', '1')
  })

  it('✕ 收窗；再开后 Esc 走层栈也能收', async () => {
    openWindow()
    act(() => openCockpitKnowledge())
    await screen.findByTestId('kc-page-stub')

    fireEvent.click(screen.getByTestId('cockpit-knowledge-close'))
    expect(screen.queryByTestId('cockpit-knowledge-win')).toBeNull()

    act(() => openCockpitKnowledge())
    expect(screen.getByTestId('cockpit-knowledge-win')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('cockpit-knowledge-win')).toBeNull()
  })
})
