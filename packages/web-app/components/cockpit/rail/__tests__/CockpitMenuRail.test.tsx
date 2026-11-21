// 右栏主按钮组（CockpitMenuRail）：
//   · 顺序 = 下指令 → 目录 → 消耗 → 调试 → 变更 → 更多（变更倒数第二）；
//   · 「变更」只在 cwd 本身是独立 git 仓库（CabinDetail.cwd_git）时出现。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CockpitStateProvider } from '../../state/CockpitStateProvider'
import { CockpitMenuRail } from '../CockpitMenuRail'

const cabinState = vi.hoisted(() => ({ cwdGit: true }))

vi.mock('@/components/cabin/cabin-provider', () => ({
  useCabinOptional: () => ({ cabin: { cwd_git: cabinState.cwdGit } }),
}))

function renderRail() {
  return render(
    <CockpitStateProvider entryCabinId="c1">
      <CockpitMenuRail />
    </CockpitStateProvider>,
  )
}

/** 主按钮组里带 data-testid 的顺序（「更多」的风琴项不算）。 */
function railOrder(): string[] {
  const rail = screen.getByTestId('cockpit-menu-rail')
  const skip = new Set(['cockpit-menu-rail', 'cockpit-menu-fan', 'cockpit-menu-activity-count'])
  return [...rail.querySelectorAll<HTMLElement>('[data-testid^="cockpit-menu-"]')]
    .map((el) => el.dataset.testid!)
    .filter((id) => !skip.has(id))
}

beforeEach(() => {
  cabinState.cwdGit = true
})

describe('CockpitMenuRail · 变更按钮', () => {
  it('cwd 是独立 git 仓库：「变更」出现且紧挨在「更多」上方', () => {
    renderRail()
    const order = railOrder()
    expect(order).toEqual([
      'cockpit-menu-command',
      'cockpit-menu-cabin-tree',
      'cockpit-menu-activity',
      'cockpit-menu-usage',
      'cockpit-menu-debug',
      'cockpit-menu-changes',
      'cockpit-menu-more',
    ])
    expect(screen.getByTestId('cockpit-menu-changes').textContent).toContain('变更')
  })

  it('cwd 不是独立 git 仓库：不出「变更」按钮', () => {
    cabinState.cwdGit = false
    renderRail()
    expect(screen.queryByTestId('cockpit-menu-changes')).toBeNull()
    expect(railOrder()).toEqual([
      'cockpit-menu-command',
      'cockpit-menu-cabin-tree',
      'cockpit-menu-activity',
      'cockpit-menu-usage',
      'cockpit-menu-debug',
      'cockpit-menu-more',
    ])
  })
})

describe('CockpitMenuRail · 活动按钮', () => {
  it('有运行中活动：活动在「目录」与「消耗」之间，徽标 = 运行中数', () => {
    render(
      <CockpitStateProvider entryCabinId="c1">
        <CockpitMenuRail activityLive={3} />
      </CockpitStateProvider>,
    )
    expect(railOrder()).toEqual([
      'cockpit-menu-command',
      'cockpit-menu-cabin-tree',
      'cockpit-menu-activity',
      'cockpit-menu-usage',
      'cockpit-menu-debug',
      'cockpit-menu-changes',
      'cockpit-menu-more',
    ])
    expect(screen.getByTestId('cockpit-menu-activity').textContent).toContain('活动')
    expect(screen.getByTestId('cockpit-menu-activity-count')).toHaveTextContent('3')
  })

  it('活动数为 0：按钮常住，只是不显示徽标', () => {
    renderRail()
    expect(screen.getByTestId('cockpit-menu-activity').textContent).toContain('活动')
    expect(screen.queryByTestId('cockpit-menu-activity-count')).toBeNull()
  })
})

describe('CockpitMenuRail · 更多', () => {
  it('生产代码只留 汐音 / 动作 / 日志 / 设置；跃迁 / 模拟 / 编队已下线', () => {
    renderRail()
    fireEvent.click(screen.getByTestId('cockpit-menu-more'))
    const fan = screen.getByTestId('cockpit-menu-fan')
    const items = [...fan.querySelectorAll<HTMLElement>('[data-testid^="cockpit-fan-"]')]
      .map((el) => el.dataset.testid!)
    expect(items).toEqual([
      'cockpit-fan-xiyin',
      'cockpit-fan-poses',
      'cockpit-fan-log',
      'cockpit-fan-settings',
    ])
    expect(screen.queryByTestId('cockpit-fan-warp')).toBeNull()
    expect(screen.queryByTestId('cockpit-fan-sim')).toBeNull()
    expect(screen.queryByTestId('cockpit-fan-fleet')).toBeNull()
  })
})
