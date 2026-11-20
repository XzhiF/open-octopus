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
    getCabinTree: vi.fn(),
    getCabinFile: vi.fn(),
    cabinRawUrl: vi.fn(),
  }
})

import {
  fetchCabinRepos, getCabinFile, getCabinTree, getRepoFile, getRepoTree, cabinRawUrl,
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
  vi.mocked(getCabinTree).mockResolvedValue({
    dir: 'D:/ws/cabin',
    entries: [
      { path: 'docs/', type: 'dir', bytes: 0 },
      { path: 'docs/接口约定.md', type: 'file', bytes: 46 },
      { path: 'docs/架构总览.png', type: 'file', bytes: 999 },
      { path: 'projects/', type: 'dir', bytes: 0 },
      { path: 'projects/ledger/', type: 'dir', bytes: 0 },
      { path: 'projects/ledger/src.ts', type: 'file', bytes: 10 },
      { path: 'cabin.md', type: 'file', bytes: 18 },
    ],
  })
  vi.mocked(getCabinFile).mockImplementation(async (_id: string, relPath: string) => ({
    path: relPath,
    content: relPath === 'cabin.md' ? '# 本舱\n\n- 只读\n' : '# 接口约定\n\n## 退款\n- 幂等\n',
  }))
  vi.mocked(cabinRawUrl).mockImplementation((_id: string, relPath: string) => `http://raw/${relPath}`)
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

// ── v22 九轮：右栏「目录」= 本舱 cwd 只读树 + 多标签查看器（不编辑） ──
const CABIN_SCOPE: CockpitTreeScope = { cabinId: 'c1', projects: [], active: '', mode: 'cabin' }

describe('CockpitTreeWindow · 本舱目录（cabin 模式）', () => {
  it('cwd 绝对路径常显；默认开 cabin.md 并按 Markdown 渲染；不出 chips/分支', async () => {
    render(
      <Wrap>
        <CockpitTreeWindow scope={CABIN_SCOPE} onClose={vi.fn()} />
      </Wrap>,
    )

    await waitFor(() => expect(getCabinTree).toHaveBeenCalledWith('c1'))
    expect(screen.getByTestId('cockpit-cabin-cwd').textContent).toContain('D:/ws/cabin')
    const head = screen.getByTestId('cockpit-treewin-head')
    expect(head.textContent).toContain('本舱目录')
    expect(head.textContent).toContain('D:/ws/cabin')
    expect(screen.queryByTestId('cockpit-treewin-chips')).toBeNull()

    // 默认标签 = cabin.md；md 渲染成标题 + 列表。
    expect(await screen.findByRole('heading', { level: 1, name: '本舱' })).toBeInTheDocument()
    expect(screen.getByRole('list').textContent).toContain('只读')
    expect(screen.getAllByRole('tab')).toHaveLength(1)
  })

  it('点文件开新标签（Markdown 渲染）；✕ 关标签回落到相邻；图片走 /raw', async () => {
    render(
      <Wrap>
        <CockpitTreeWindow scope={CABIN_SCOPE} onClose={vi.fn()} />
      </Wrap>,
    )
    await screen.findByRole('heading', { level: 1, name: '本舱' })

    fireEvent.click(screen.getByText('接口约定.md'))
    await waitFor(() => expect(getCabinFile).toHaveBeenCalledWith('c1', 'docs/接口约定.md'))
    expect(await screen.findByRole('heading', { level: 2, name: '退款' })).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(2)

    fireEvent.click(screen.getByText('架构总览.png'))
    const img = await screen.findByAltText('docs/架构总览.png')
    expect(img.getAttribute('src')).toBe('http://raw/docs/架构总览.png')
    expect(getCabinFile).not.toHaveBeenCalledWith('c1', 'docs/架构总览.png')
    expect(screen.getAllByRole('tab')).toHaveLength(3)

    fireEvent.click(screen.getByLabelText('关闭 架构总览.png'))
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2))
    expect(screen.queryByAltText('docs/架构总览.png')).toBeNull()
    // 关闭活动标签 → 回落到相邻（接口约定.md）。
    expect(await screen.findByRole('heading', { level: 2, name: '退款' })).toBeInTheDocument()
  })

  it('全展 / 全收 + 深层筛选（自动展开祖先链）', async () => {
    render(
      <Wrap>
        <CockpitTreeWindow scope={CABIN_SCOPE} onClose={vi.fn()} />
      </Wrap>,
    )
    await screen.findByRole('heading', { level: 1, name: '本舱' })
    const treeBox = screen.getByRole('tree', { name: '本舱目录树' })

    // 默认只展开顶层目录：projects/ledger/src.ts 还收着。
    expect(treeBox.textContent).toContain('projects/')
    expect(treeBox.textContent).not.toContain('src.ts')

    fireEvent.click(screen.getByLabelText('全部展开'))
    expect(treeBox.textContent).toContain('src.ts')
    fireEvent.click(screen.getByLabelText('全部收起'))
    await waitFor(() => expect(screen.getByRole('tree', { name: '本舱目录树' }).textContent).not.toContain('src.ts'))

    fireEvent.change(screen.getByLabelText('筛选本舱文件'), { target: { value: 'src.ts' } })
    await waitFor(() => expect(screen.getByRole('tree', { name: '本舱目录树' }).textContent).toContain('src.ts'))
    expect(screen.getByRole('tree', { name: '本舱目录树' }).textContent).not.toContain('cabin.md')
  })
})
