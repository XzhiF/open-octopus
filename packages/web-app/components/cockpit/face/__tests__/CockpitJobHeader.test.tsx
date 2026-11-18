// S4 — CockpitJobHeader 呈现层测试（v21 三轮：原型 .ph / .dtabs）：
// DOM 顺序（关闭第一）、平行四边形页签切换、副行「项目 · 分支 · 编号」空值省略、
// 纯函数派生。

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
    // 关闭在视觉上也在最左：它是 .ck12-dh（原型 .ph）的第一个子元素。
    const head = container.querySelector('.ck12-dh')
    expect(head?.firstElementChild).toBe(screen.getByTestId('cockpit-job-close'))
  })

  it('七个页签都渲染成平行四边形 .dtab，点击回传对应 tab', () => {
    const { onTabChange, container } = renderHeader()
    for (const key of ['overview', 'relay', 'run', 'changes', 'accept', 'files', 'debug']) {
      expect(screen.getByTestId(`cockpit-tab-${key}`)).toBeInTheDocument()
    }
    expect(container.querySelectorAll('.ck12-dtab').length).toBe(7)
    fireEvent.click(screen.getByTestId('cockpit-tab-run'))
    expect(onTabChange).toHaveBeenCalledWith('run')
  })

  it('副行空值整段省略：全空时没有副行', () => {
    const { container } = renderHeader()
    expect(container.querySelector('.ck12-dh-pt span')).toBeNull()
  })

  it('副行「项目 · 分支 · 编号」按有值段拼，空段不占分隔符', () => {
    const { container } = renderHeader({
      cabinName: 'Aurora',
      branch: 'feat-cabin',
      executor: 'a1b2c3d4',
    })
    const sub = container.querySelector('.ck12-dh-pt span')
    expect(sub?.textContent).toBe('Aurora · feat-cabin · a1b2c3d4')

    const onlyBranch = renderHeader({ branch: 'feat-cabin' })
    expect(onlyBranch.container.querySelector('.ck12-dh-pt span')?.textContent).toBe('feat-cabin')
  })

  it('标题带状态表情（原型 STATE_EMO）', () => {
    const { container } = renderHeader({ status: 'running' })
    expect(container.querySelector('.ck12-dh-pt b')?.textContent).toContain('⚡')
    expect(container.querySelector('.ck12-dh-pt b')?.textContent).toContain('接入渠道')
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
