// S4 — CockpitJobHeader 呈现层测试：DOM 顺序（关闭第一）、五行页签切换、
// 行2 的空值整段省略、纯函数派生。

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  CockpitJobHeader,
  elapsedLabel,
  tabForAttentionStage,
} from '../CockpitJobHeader'

describe('CockpitJobHeader', () => {
  function renderHeader(overrides: Partial<Parameters<typeof CockpitJobHeader>[0]> = {}) {
    const onClose = vi.fn()
    const onTabChange = vi.fn()
    const utils = render(
      <CockpitJobHeader
        kind="task"
        title="接入渠道"
        status="running"
        tab="overview"
        onTabChange={onTabChange}
        onClose={onClose}
        {...overrides}
      />,
    )
    return { ...utils, onClose, onTabChange }
  }

  it('header 的第一个可聚焦元素是关闭（DOM 顺序，不用 CSS order 伪装）', () => {
    const { container } = renderHeader()
    const focusables = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    expect(focusables.length).toBeGreaterThan(0)
    expect(focusables[0]).toBe(screen.getByTestId('cockpit-job-close'))
    // 关闭在视觉上也在最左：它是 h1 的第一个子元素。
    const h1 = container.querySelector('.ck12-jh-h1')
    expect(h1?.firstElementChild).toBe(screen.getByTestId('cockpit-job-close'))
  })

  it('五个页签都渲染，点击回传对应 tab', () => {
    const { onTabChange } = renderHeader()
    for (const key of ['overview', 'relay', 'run', 'changes', 'accept']) {
      expect(screen.getByTestId(`cockpit-tab-${key}`)).toBeInTheDocument()
    }
    fireEvent.click(screen.getByTestId('cockpit-tab-run'))
    expect(onTabChange).toHaveBeenCalledWith('run')
  })

  it('行2 空值整段省略：全空时整行不出现', () => {
    const { container } = renderHeader()
    expect(container.querySelector('.ck12-jh-h2')).toBeNull()
  })

  it('行2 只在有值的段之间放分隔符（不留空分隔符）', () => {
    const { container } = renderHeader({
      branch: 'feat-cabin',
      doing: '正在跑 node-2',
      executor: 'a1b2c3d4',
      costLabel: '¥1.28',
    })
    const h2 = container.querySelector('.ck12-jh-h2')
    expect(h2).not.toBeNull()
    expect(h2?.textContent).toContain('feat-cabin')
    expect(h2?.textContent).toContain('正在跑 node-2')
    expect(h2?.textContent).toContain('a1b2c3d4')
    expect(h2?.textContent).toContain('¥1.28')
    // 左组 2 段 → 1 个分隔符；右组 2 段 → 1 个（⏱ 没有 startedAt，不出现）。
    // 组与组之间是空格 + spacer，不放「·」。
    expect(container.querySelectorAll('.ck12-jh-sep').length).toBe(2)
    expect(h2?.textContent).not.toContain('⏱')
  })

  it('执行者缺省回落到舱名；两者都无则省略', () => {
    const withCabin = render(
      <CockpitJobHeader kind="task" title="t" onClose={() => {}} cabinName="Aurora" />,
    )
    expect(withCabin.container.querySelector('.ck12-jh-h2')?.textContent).toContain('Aurora')
    withCabin.unmount()

    const empty = render(<CockpitJobHeader kind="task" title="t" onClose={() => {}} />)
    expect(empty.container.querySelector('.ck12-jh-h2')).toBeNull()
  })

  it('有 attention 去处理按钮 → 点击回调；没有就不渲染', () => {
    const onGoHandle = vi.fn()
    const { rerender } = renderHeader({ onGoHandle })
    fireEvent.click(screen.getByTestId('cockpit-job-go'))
    expect(onGoHandle).toHaveBeenCalledTimes(1)

    rerender(<CockpitJobHeader kind="task" title="t" onClose={() => {}} />)
    expect(screen.queryByTestId('cockpit-job-go')).toBeNull()
  })

  it('载入态：关闭仍在第一位，页签/动作不渲染', () => {
    const { container } = renderHeader({ loading: true })
    const buttons = container.querySelectorAll('button')
    expect(buttons[0]).toBe(screen.getByTestId('cockpit-job-close'))
    expect(screen.queryByTestId('cockpit-tab-run')).toBeNull()
    expect(container.textContent).toContain('载入作业')
  })
})

describe('作业头纯函数', () => {
  it('tabForAttentionStage 按 stage 落页签', () => {
    expect(tabForAttentionStage('review')).toBe('accept')
    expect(tabForAttentionStage('answer')).toBe('relay')
    expect(tabForAttentionStage('adjudicate')).toBe('relay')
    expect(tabForAttentionStage('blocked')).toBe('run')
  })

  it('elapsedLabel 缺值/非法值返回 null（整段省略）', () => {
    expect(elapsedLabel(null, null, Date.now())).toBeNull()
    expect(elapsedLabel('not-a-date', null, Date.now())).toBeNull()
  })

  it('elapsedLabel 秒/分/时/天', () => {
    const start = '2026-11-14T00:00:00.000Z'
    const at = (seconds: number) => Date.parse(start) + seconds * 1000
    expect(elapsedLabel(start, null, at(42))).toBe('42s')
    expect(elapsedLabel(start, null, at(5 * 60))).toBe('5m')
    expect(elapsedLabel(start, null, at(2 * 3600 + 7 * 60))).toBe('2h07m')
    expect(elapsedLabel(start, null, at(26 * 3600))).toBe('1d2h')
  })
})
