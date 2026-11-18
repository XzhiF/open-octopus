// 项目页签 + 目录树窗口（v21 六轮）：
//   · 项目页签一行一个项目（名称 / 分支 / 完整路径 / 只读），只列本作战项目；
//   · 点行 → 在 dossier 之上弹目录树窗口：chips 只列本作战项目、左树筛选 + 独立滚动、
//     右内容独立滚动；完整路径以 tree 接口的绝对 dir 为准；Esc 先收树窗。
// 真数据源全部 mock：/repos?enrich=1、/repos/:name/tree、/repos/:name/file。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return {
    ...actual,
    fetchCabinRepos: vi.fn(),
    getRepoTree: vi.fn(),
    getRepoFile: vi.fn(),
  }
})

import {
  fetchCabinRepos, getRepoFile, getRepoTree,
  type CabinRepoEntry,
} from '@/lib/cabin-api'
import { CockpitStateProvider } from '../../state/CockpitStateProvider'
import { CockpitLayerStack } from '../../state/CockpitLayerStack'
import { invalidateCabinProjects } from '../../projects/use-cabin-projects'
import { CockpitTreeContext, type CockpitTreeScope } from '../tree-window'
import { CockpitJobProject } from '../CockpitJobProject'
import { CockpitTreeWindow } from '../CockpitTreeWindow'

function repo(over: Partial<CabinRepoEntry> & { key: string; name: string }): CabinRepoEntry {
  return {
    source: 'org',
    org: 'XzhiF',
    group: 'XzhiF',
    repoName: over.name,
    main_path: `D:/repos/${over.name}`,
    local_path: null,
    external: false,
    mainline_branch: 'main',
    worktree_path: `D:/ws/cabin/projects/${over.name}`,
    branch: `feat/${over.name}`,
    worktrees: [],
    git: { branch: `feat/${over.name}`, detached: false, commit: 'a91f3c2' },
    ...over,
  }
}

const REPOS: CabinRepoEntry[] = [
  repo({ key: 'org:XzhiF/ledger', name: 'ledger', git: { branch: 'fix/reconcile', detached: false, commit: 'a91f3c2' } }),
  repo({ key: 'org:XzhiF/risk', name: 'risk' }),
  repo({ key: 'org:XzhiF/stray', name: 'stray' }),
]

const SCOPE: CockpitTreeScope = {
  cabinId: 'c1',
  projects: ['org:XzhiF/ledger', 'risk'],
  active: 'org:XzhiF/ledger',
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
  invalidateCabinProjects('c1')
  vi.mocked(fetchCabinRepos).mockResolvedValue(REPOS)
  vi.mocked(getRepoTree).mockImplementation(async (_id: string, name: string) => ({
    dir: `D:/ws/cabin/projects/${name}`,
    entries: [
      { path: 'src/', type: 'dir', bytes: 0 },
      { path: 'src/reconcile.ts', type: 'file', bytes: 1204 },
      { path: 'README.md', type: 'file', bytes: 30 },
    ],
  }))
  vi.mocked(getRepoFile).mockResolvedValue({ path: 'src/reconcile.ts', content: 'export const reconcile = 1' })
})

describe('CockpitJobProject · 项目页签', () => {
  it('一行一个项目，只列本作战项目，给完整路径 + 分支，点行把 scope 交给树窗', async () => {
    const open = vi.fn()
    render(
      <Wrap>
        <CockpitTreeContext.Provider value={{ open }}>
          <CockpitJobProject cabinId="c1" projects={SCOPE.projects} branch={null} />
        </CockpitTreeContext.Provider>
      </Wrap>,
    )

    const row = await screen.findByTestId('cabin-job-project-row-ledger')
    expect(row.textContent).toContain('fix/reconcile')
    expect(row.textContent).toContain('D:/ws/cabin/projects/ledger')
    expect(row.textContent).toContain('只读')
    // scope 只有两个项目 —— 舱籍里多出来的 stray 不上页签。
    expect(screen.getByTestId('cabin-job-project-row-risk')).toBeInTheDocument()
    expect(screen.queryByTestId('cabin-job-project-row-stray')).toBeNull()

    fireEvent.click(row)
    expect(open).toHaveBeenCalledWith({
      cabinId: 'c1',
      projects: ['org:XzhiF/ledger', 'risk'],
      active: 'org:XzhiF/ledger',
    })
  })
})

describe('CockpitTreeWindow · 目录树窗口', () => {
  it('头部给分支与完整路径；chips 只列本作战项目；左树筛选 + 点文件看内容', async () => {
    const onClose = vi.fn()
    render(
      <Wrap>
        <CockpitTreeWindow scope={SCOPE} onClose={onClose} />
      </Wrap>,
    )

    await waitFor(() => expect(getRepoTree).toHaveBeenCalledWith('c1', 'ledger'))
    const head = screen.getByTestId('cockpit-treewin-head')
    expect(head.textContent).toContain('目录树 · ledger')
    expect(head.textContent).toContain('fix/reconcile')
    expect(head.textContent).toContain('D:/ws/cabin/projects/ledger')

    // chips：只有本作战的两个项目。
    const chips = screen.getByTestId('cockpit-treewin-chips')
    expect(chips.querySelectorAll('button')).toHaveLength(2)
    expect(chips.textContent).not.toContain('stray')

    // 树与预览（完整路径以接口 dir 为准）。
    expect(await screen.findByText('reconcile.ts')).toBeInTheDocument()
    expect(screen.getByTestId('cockpit-treewin-dir').textContent).toBe('D:/ws/cabin/projects/ledger')

    fireEvent.click(screen.getByText('reconcile.ts'))
    await waitFor(() => expect(getRepoFile).toHaveBeenCalledWith('c1', 'ledger', 'src/reconcile.ts'))
    expect(await screen.findByText('export const reconcile = 1')).toBeInTheDocument()

    // 筛选：只留匹配文件（自动展开祖先链）。
    fireEvent.change(screen.getByLabelText('筛选工作树文件'), { target: { value: 'readme' } })
    await waitFor(() => expect(screen.queryByText('reconcile.ts')).toBeNull())
    expect(screen.getByText('README.md')).toBeInTheDocument()
  })

  it('切 chip → 换项目的树；Esc 只收树窗', async () => {
    const onClose = vi.fn()
    render(
      <Wrap>
        <CockpitTreeWindow scope={SCOPE} onClose={onClose} />
      </Wrap>,
    )

    await waitFor(() => expect(getRepoTree).toHaveBeenCalledWith('c1', 'ledger'))
    fireEvent.click(screen.getByTestId('cockpit-treewin-chip-risk'))
    await waitFor(() => expect(getRepoTree).toHaveBeenCalledWith('c1', 'risk'))
    expect(screen.getByTestId('cockpit-treewin-head').textContent).toContain('目录树 · risk')

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('⛶ 全屏 / 还原（dossier 同一套六角钮）', async () => {
    const onClose = vi.fn()
    render(
      <Wrap>
        <CockpitTreeWindow scope={SCOPE} onClose={onClose} />
      </Wrap>,
    )
    const win = screen.getByTestId('cockpit-treewin')
    await screen.findByText('reconcile.ts')
    expect(win.getAttribute('data-maximized')).toBeNull()
    fireEvent.click(screen.getByTestId('cockpit-dossier-max'))
    expect(win.getAttribute('data-maximized')).toBe('1')
    fireEvent.click(screen.getByTestId('cockpit-dossier-max'))
    expect(win.getAttribute('data-maximized')).toBeNull()
  })
})
