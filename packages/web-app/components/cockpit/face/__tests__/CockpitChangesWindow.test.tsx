// 本舱变更窗（v22 十三轮 · 问题 #1）：
//   · 统计条 / 左树（仓 → 目录 → 文件，状态 + ±行）/ 干净仓脚注；
//   · 默认开第一个改动文件 → 懒拉 patch；点另一文件开 tab 并拉 patch；
//   · 刷新按钮重读各目录工作区；✕ 关窗。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))

const api = vi.hoisted(() => ({
  getCabinWorktreeChanges: vi.fn(),
  getCabinWorktreeChangePatch: vi.fn(),
}))

vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return { ...actual, ...api }
})

import type { CabinWorktreeChanges } from '@/lib/cabin-api'
import { CockpitStateProvider } from '../../state/CockpitStateProvider'
import { CockpitLayerStack } from '../../state/CockpitLayerStack'
import { CockpitChangesWindow } from '../CockpitChangesWindow'

const DATA: CabinWorktreeChanges = {
  dir: 'D:/ws/cabin',
  repos: [
    {
      name: 'ledger',
      dir: 'D:/ws/cabin/projects/ledger',
      branch: 'fix/reconcile',
      head: '8ab30d2',
      error: null,
      truncated: false,
      files: [
        { path: 'src/settlement/reconcile.ts', status: 'M', adds: 58, dels: 21 },
        { path: 'src/ledger/post.ts', status: '?', adds: 26, dels: 0, untracked: true },
      ],
    },
    {
      name: 'edge',
      dir: 'D:/ws/cabin/projects/edge',
      branch: 'feat/canary',
      head: '9d02f77',
      error: null,
      truncated: false,
      files: [],
    },
  ],
}

function Wrap({ children }: { children: ReactNode }) {
  return (
    <CockpitStateProvider entryCabinId="c1">
      <CockpitLayerStack>{children}</CockpitLayerStack>
    </CockpitStateProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getCabinWorktreeChanges.mockResolvedValue(DATA)
  api.getCabinWorktreeChangePatch.mockResolvedValue({
    patch: 'diff --git a/x b/x\n@@ -1,1 +1,2 @@\n-const a = 1\n+const a = 2\n+const b = 3',
    truncated: false,
  })
})

describe('CockpitChangesWindow · 本舱变更', () => {
  it('统计条 / 左树 / 干净仓脚注；默认开第一个改动文件并拉 patch', async () => {
    render(<Wrap><CockpitChangesWindow cabinId="c1" onClose={vi.fn()} /></Wrap>)

    await screen.findByTestId('cockpit-chgwin')
    const stats = await screen.findByTestId('cockpit-chg-stats')
    expect(stats.textContent).toContain('1 目录有改动')
    expect(stats.textContent).toContain('2 文件')
    expect(stats.textContent).toContain('+84')
    expect(stats.textContent).toContain('−21')
    expect(stats.textContent).toContain('1 未跟踪')

    const ledger = await screen.findByTestId('cockpit-chg-repo-ledger')
    expect(ledger.textContent).toContain('⎇ fix/reconcile')
    expect(screen.getByTestId('cockpit-chg-clean').textContent).toContain('edge')

    // 默认选中第一个文件 → patch 已拉，双行号 + 加删行渲染出来。
    await waitFor(() => {
      expect(api.getCabinWorktreeChangePatch).toHaveBeenCalledWith('c1', 'ledger', 'src/settlement/reconcile.ts', false)
    })
    const diff = await screen.findByTestId('cockpit-chg-diff')
    expect(diff.textContent).toContain('+const b = 3')
    expect(diff.textContent).toContain('-const a = 1')
  })

  it('点未跟踪文件 → 开 tab，按 untracked=1 拉 patch', async () => {
    render(<Wrap><CockpitChangesWindow cabinId="c1" onClose={vi.fn()} /></Wrap>)
    const row = await screen.findByTestId('cockpit-chg-file-ledger:src/ledger/post.ts')
    fireEvent.click(row)

    await waitFor(() => {
      expect(api.getCabinWorktreeChangePatch).toHaveBeenCalledWith('c1', 'ledger', 'src/ledger/post.ts', true)
    })
    expect(screen.getByTestId('cockpit-chg-tab-ledger:src/ledger/post.ts')).toBeTruthy()
  })

  it('刷新重读各目录；✕ 关窗', async () => {
    const onClose = vi.fn()
    render(<Wrap><CockpitChangesWindow cabinId="c1" onClose={onClose} /></Wrap>)
    await screen.findByTestId('cockpit-chg-stats')
    expect(api.getCabinWorktreeChanges).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('cockpit-chg-refresh'))
    await waitFor(() => expect(api.getCabinWorktreeChanges).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByTestId('cockpit-chgwin-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
