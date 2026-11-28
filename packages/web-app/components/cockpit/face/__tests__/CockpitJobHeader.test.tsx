// S4 — CockpitJobHeader 呈现层测试（v21 五轮：原型 .ph / .dtabs）：
// DOM 顺序（关闭第一）、页签改由 CockpitJobTabs 渲染（v21 五轮进正文）、
// 副行「项目 · 分支 · 编号」空值省略、dossier ⛶ 只在 Provider 下出现、纯函数派生。

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  CockpitJobHeader,
  CockpitJobTabs,
  elapsedLabel,
} from '../CockpitJobHeader'
import { DossierWindowContext } from '../dossier-window'

describe('CockpitJobHeader', () => {
  function renderHeader(overrides: Partial<Parameters<typeof CockpitJobHeader>[0]> = {}) {
    const onClose = vi.fn()
    const utils = render(
      <CockpitJobHeader
        kind="task"
        title="接入渠道"
        status="running"
        onClose={onClose}
        {...overrides}
      />,
    )
    return { ...utils, onClose }
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

  it('页签不在头部（原型 .pb 内），由 CockpitJobTabs 渲染十个平行四边形 .dtab', () => {
    const onTabChange = vi.fn()
    const { container: head } = renderHeader()
    expect(head.querySelector('.ck12-dtab')).toBeNull()

    // v22 #5：对话页签删除 —— 编队对话是独立 chat 窗。
    // 2026-11-24：验收后加「归档」只读明细页签。
    // 2026-11-25：末尾补「消耗 / 子代理」。
    const { container } = render(<CockpitJobTabs tab="run" onTabChange={onTabChange} />)
    for (const key of [
      'relay', 'run', 'changes', 'accept', 'archive',
      'files', 'debug', 'project', 'usage', 'agents',
    ]) {
      expect(screen.getByTestId(`cockpit-tab-${key}`)).toBeInTheDocument()
    }
    expect(screen.queryByTestId('cockpit-tab-dialog')).toBeNull()
    expect(container.querySelectorAll('.ck12-dtab').length).toBe(10)
    fireEvent.click(screen.getByTestId('cockpit-tab-run'))
    expect(onTabChange).toHaveBeenCalledWith('run')
  })

  it('页签角标：badges 给对应签挂 .n（如「子代理 5」）', () => {
    const { container } = render(
      <CockpitJobTabs tab="run" onTabChange={() => {}} badges={{ agents: 5 }} />,
    )
    const badge = screen.getByTestId('cockpit-tab-agents').querySelector('.n')
    expect(badge?.textContent).toBe('5')
    expect(screen.getByTestId('cockpit-tab-run').querySelector('.n')).toBeNull()
    expect(container.querySelectorAll('.ck12-dtab .n').length).toBe(1)
  })

  it('非任务作业由宿主过滤「归档」：传 tabs 时只渲染给定页签', () => {
    render(
      <CockpitJobTabs
        tab="run"
        onTabChange={() => {}}
        tabs={['relay', 'run', 'changes', 'accept', 'files', 'debug', 'project', 'usage', 'agents']}
      />,
    )
    expect(screen.queryByTestId('cockpit-tab-archive')).toBeNull()
  })

  it('归档闸：待归档 / 归档中时头部挂 📦 签，点了切归档页签', () => {
    const onOpenArchive = vi.fn()
    const { rerender } = renderHeader({ status: 'awaiting_archive', onOpenArchive })
    expect(screen.getByTestId('cockpit-dossier-archive').textContent).toContain('待归档')
    fireEvent.click(screen.getByTestId('cockpit-dossier-archive'))
    expect(onOpenArchive).toHaveBeenCalledTimes(1)

    rerender(
      <CockpitJobHeader
        kind="task"
        title="接入渠道"
        status="archiving"
        onClose={() => {}}
        onOpenArchive={onOpenArchive}
      />,
    )
    expect(screen.getByTestId('cockpit-dossier-archive').textContent).toContain('归档中')
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
    // 没有项目名 / 编号时退回舱名 / 执行者短 id（旧调用方行为不变）。
    expect(sub?.textContent).toBe('Aurora · feat-cabin · a1b2c3d4')

    const onlyBranch = renderHeader({ branch: 'feat-cabin' })
    expect(onlyBranch.container.querySelector('.ck12-dh-pt span')?.textContent).toBe('feat-cabin')
  })

  it('副行优先用项目名与作业编号（原型顺序：项目 · 分支 · 编号）', () => {
    const { container } = renderHeader({
      cabinName: 'Aurora',
      projectName: 'API 网关',
      branch: 'feat/refund-flow',
      jobNo: 't-2641',
      executor: 'a1b2c3d4',
    })
    expect(container.querySelector('.ck12-dh-pt span')?.textContent)
      .toBe('API 网关 · feat/refund-flow · t-2641')
  })

  it('副行可整段覆盖（会话详情：舱名 · 会话 <id>）', () => {
    const { container } = renderHeader({
      cabinName: 'Aurora',
      branch: 'feat-cabin',
      jobNo: 't-2641',
      subtitle: 'Aurora · 会话 s-9f2a',
    })
    expect(container.querySelector('.ck12-dh-pt span')?.textContent).toBe('Aurora · 会话 s-9f2a')
  })

  it('标题带状态表情（原型 STATE_EMO）', () => {
    const { container } = renderHeader({ status: 'running' })
    expect(container.querySelector('.ck12-dh-pt b')?.textContent).toContain('⚡')
    expect(container.querySelector('.ck12-dh-pt b')?.textContent).toContain('接入渠道')
  })

  it('dossier 内（有 Provider）才有 ⛶ 全屏钮，点击走 toggleMax', () => {
    const toggleMax = vi.fn()
    const { rerender } = render(
      <DossierWindowContext.Provider value={{ maximized: false, toggleMax }}>
        <CockpitJobHeader kind="task" title="t" onClose={() => {}} />
      </DossierWindowContext.Provider>,
    )
    fireEvent.click(screen.getByTestId('cockpit-dossier-max'))
    expect(toggleMax).toHaveBeenCalledTimes(1)

    // 全屏态图标翻转
    rerender(
      <DossierWindowContext.Provider value={{ maximized: true, toggleMax }}>
        <CockpitJobHeader kind="task" title="t" onClose={() => {}} />
      </DossierWindowContext.Provider>,
    )
    expect(screen.getByTestId('cockpit-dossier-max').textContent).toBe('⤡')

    // 不在 dossier（无 Provider）→ 不渲染
    render(<CockpitJobHeader kind="task" title="t2" onClose={() => {}} />)
    expect(screen.getAllByTestId('cockpit-job-header')).toHaveLength(2)
    expect(screen.queryAllByTestId('cockpit-dossier-max')).toHaveLength(1)
  })

  it('右上只有 ⛶：不再有项目签 / 中止 / 谈 / 决断 / 调试 / 去处理（v21 五轮）', () => {
    const { container } = render(
      <DossierWindowContext.Provider value={{ maximized: false, toggleMax: () => {} }}>
        <CockpitJobHeader kind="task" title="t" status="running" onClose={() => {}} />
      </DossierWindowContext.Provider>,
    )
    const buttons = [...container.querySelectorAll('.ck12-dh button')]
    // 关闭 + ⛶，就这两枚。
    expect(buttons.map((b) => b.getAttribute('data-testid'))).toEqual([
      'cockpit-job-close',
      'cockpit-dossier-max',
    ])
    expect(container.querySelector('.ck12-dh-acts')).toBeNull()
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
