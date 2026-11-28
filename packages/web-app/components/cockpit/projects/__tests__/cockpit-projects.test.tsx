// 舱籍（projects）· 2026-11-15
// 纯模型 + 舱籍面 / 项目面 / 浮层：点项目看仓库（不是跳作业）、只看它的作业
// 只筛左栏不换面、空态诚实。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('@/lib/billing-currency', () => ({
  useBillingCurrency: () => ({ currency: 'CNY', rate: 7 }),
}))

vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return {
    ...actual,
    fetchCabinRepos: vi.fn(),
    listCabins: vi.fn(),
    getCabin: vi.fn(),
    listCabinJobs: vi.fn(),
    pullCabinRepo: vi.fn(),
    createRepoWorktree: vi.fn(),
    removeCabinRepo: vi.fn(),
    setCabinRepoMainline: vi.fn(),
    getRepoTree: vi.fn(),
    getRepoFile: vi.fn(),
    getRepoWorktreeChanges: vi.fn(),
    getRepoWorktreeChangePatch: vi.fn(),
  }
})
vi.mock('@/lib/tasks-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tasks-api')>()
  return { ...actual, listTasks: vi.fn(), getTask: vi.fn() }
})
vi.mock('@/lib/agent/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/api')>()
  return { ...actual, listRunningSessions: vi.fn() }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() } }))

import {
  fetchCabinRepos, getCabin, getRepoFile, getRepoTree, getRepoWorktreeChangePatch,
  getRepoWorktreeChanges, listCabins, listCabinJobs, setCabinRepoMainline,
  type CabinDetail, type CabinRepoEntry,
} from '@/lib/cabin-api'
import { formatDateTime } from '@/lib/format'
import { listTasks } from '@/lib/tasks-api'
import { listRunningSessions } from '@/lib/agent/api'
import { CockpitStateProvider, useCockpitState } from '../../state/CockpitStateProvider'
import { CockpitLayerStack } from '../../state/CockpitLayerStack'
import { CockpitFleetProvider } from '../../fleet/CockpitFleetProvider'
import type { CockpitRef } from '../../state/cockpit-state'
import { CockpitManifestFace } from '../CockpitManifestFace'
import { CockpitProjectFace } from '../CockpitProjectFace'
import { CockpitProjectsPopover } from '../CockpitProjectsPopover'
import { invalidateCabinProjects, useCabinProjects } from '../use-cabin-projects'
import {
  projectNameFromKey, projectRef, projectStats, rosterRef, rowProjectKeys,
} from '../project-model'
import { refInRows } from '../../entry/cockpit-candidates'

function cabin(id: string, name: string): CabinDetail {
  return {
    id, name, path: `/tmp/${id}`, workspace_id: `ws-${id}`, main_session_id: `s-${id}`,
    requirements: '', status: 'active', mainline_strategy: 'clean-main', org: null,
    version: 3,
    created_at: '2026-11-14T00:00:00.000Z', updated_at: '2026-11-14T00:00:00.000Z',
    last_active_at: null, archived_at: null,
  }
}

function repo(over: Partial<CabinRepoEntry> & { key: string; name: string }): CabinRepoEntry {
  return {
    source: 'org', org: 'XzhiF', group: 'XzhiF', repoName: over.name,
    main_path: `/repos/${over.name}`, local_path: null, external: false,
    mainline_branch: 'main', worktree_path: null, branch: null, worktrees: [],
    git: {
      branch: 'main', detached: false, commit: 'a91f3c2', msg: '对齐尾差',
      at: '2026-11-23T05:12:00.000Z', remote: 'git@x:ledger', dirty: true,
    },
    ...over,
  }
}

function Probe({ onState }: { onState: (s: ReturnType<typeof useCockpitState>) => void }) {
  const state = useCockpitState()
  useEffect(() => { onState(state) })
  return null
}

function Harness({
  children,
  initial,
  onState,
}: {
  children: ReactNode
  initial?: CockpitRef
  onState?: (s: ReturnType<typeof useCockpitState>) => void
}) {
  return (
    <CockpitStateProvider entryCabinId="c1">
      <CockpitLayerStack>
        <CockpitFleetProvider>
          {initial && <Seed initial={initial} />}
          {onState && <Probe onState={onState} />}
          {children}
        </CockpitFleetProvider>
      </CockpitLayerStack>
    </CockpitStateProvider>
  )
}

function Seed({ initial }: { initial: CockpitRef }) {
  const { select } = useCockpitState()
  useEffect(() => { select(initial) }, [select, initial])
  return null
}

beforeEach(() => {
  vi.clearAllMocks()
  invalidateCabinProjects('c1')
  vi.mocked(listCabins).mockResolvedValue([cabin('c1', '账务中台')])
  vi.mocked(getCabin).mockImplementation(async (id: string) => ({ cabin: cabin(id, '账务中台'), view: { attention: [] } as never }))
  vi.mocked(listCabinJobs).mockResolvedValue([
    {
      id: 'j1', cabin_id: 'c1', kind: 'task', ref_id: 't1', session_id: null,
      title: '对齐尾差', mandate: null, prompt: null,
      created_at: '2026-11-15T01:00:00.000Z', ended_at: null,
      status: 'running', transport: 'task-thread',
      project_keys: ['org:XzhiF/ledger'],
    },
    {
      id: 'j2', cabin_id: 'c1', kind: 'workflow', ref_id: null, session_id: null,
      title: '杂活', mandate: null, prompt: null,
      created_at: '2026-11-15T01:00:00.000Z', ended_at: null,
      status: 'pending', transport: 'workflow-engine',
      project_keys: [],
    },
  ])
  vi.mocked(listTasks).mockResolvedValue([] as never)
  vi.mocked(listRunningSessions).mockResolvedValue([] as never)
  vi.mocked(fetchCabinRepos).mockResolvedValue([
    repo({ key: 'org:XzhiF/ledger', name: 'ledger' }),
    repo({
      key: 'local:apps/console', name: 'console', source: 'local', org: null,
      group: null, local_path: 'apps/console', main_path: '/tmp/c1/apps/console',
      mainline_branch: 'feat/console',
      git: { branch: 'feat/console', detached: false, commit: 'b7c1d10', msg: 'console', at: '2026-11-23T06:00:00.000Z', remote: null },
    }),
  ])
  vi.mocked(getRepoTree).mockResolvedValue({
    dir: '/repos/ledger',
    entries: [
      { path: 'src/', type: 'dir', bytes: 0 },
      { path: 'src/reconcile.ts', type: 'file', bytes: 120 },
      { path: 'README.md', type: 'file', bytes: 40 },
    ],
  })
  vi.mocked(getRepoFile).mockImplementation(async (_id, _name, relPath) => ({
    path: relPath,
    content: relPath === 'src/reconcile.ts' ? 'export const a = 1\n' : '# ledger\n',
  }))
  vi.mocked(getRepoWorktreeChanges).mockResolvedValue({
    dir: '/repos/ledger',
    repos: [{
      name: 'ledger', dir: '/repos/ledger', branch: 'main', head: 'a91f3c2',
      error: null, truncated: false,
      files: [
        { path: 'src/reconcile.ts', status: 'M', adds: 2, dels: 1 },
        { path: 'src/audit/chain/probe.ts', status: 'A', adds: 3, dels: 0 },
      ],
    }],
  })
  vi.mocked(getRepoWorktreeChangePatch).mockResolvedValue({
    patch: [
      'diff --git a/src/reconcile.ts b/src/reconcile.ts',
      '@@ -1,1 +1,2 @@',
      '-export const a = 1',
      '+export const a = 2',
      '+export const b = 3',
    ].join('\n'),
    truncated: false,
  })
})

describe('project-model', () => {
  it('key → 展示名', () => {
    expect(projectNameFromKey('org:XzhiF/ledger')).toBe('ledger')
    expect(projectNameFromKey('local:apps/console')).toBe('console')
    expect(projectNameFromKey('local:console')).toBe('console')
  })

  it('项目 ref：roster / project / refInRows 放行', () => {
    expect(rosterRef('c1')).toEqual({ kind: 'project', cabinId: 'c1', id: '__roster__' })
    expect(projectRef('c1', 'org:X/ledger').id).toBe('org:X/ledger')
    expect(refInRows(projectRef('c1', 'org:X/ledger'), [])).toBe(true)
  })

  it('projectStats 按 cabinId + 锚点计数（未归属不计）', () => {
    const rows = [
      {
        key: 'job:j1', kind: 'job', cabinId: 'c1', cabinName: '账务中台',
        job: { status: 'running', project_keys: ['org:XzhiF/ledger'], title: '对齐尾差' },
        pct: null,
      },
      {
        key: 'job:j2', kind: 'job', cabinId: 'c1', cabinName: '账务中台',
        job: { status: 'pending', project_keys: [], title: '杂活' },
        pct: null,
      },
      {
        key: 'job:j3', kind: 'job', cabinId: 'c2', cabinName: '别的舱',
        job: { status: 'running', project_keys: ['org:XzhiF/ledger'], title: '别人的' },
        pct: null,
      },
    ] as never
    expect(rowProjectKeys(rows[0])).toEqual(['org:XzhiF/ledger'])
    const stats = projectStats('c1', repo({ key: 'org:XzhiF/ledger', name: 'ledger' }), rows)
    expect(stats.jobs).toBe(1)
    expect(stats.running).toBe(1)
    expect(stats.worktrees).toBe(0)
  })
})

describe('CockpitManifestFace · 舱籍面', () => {
  it('ORG 分列 + 本地条；点项目 → 项目面 ref', async () => {
    const stateRef: { current: ReturnType<typeof useCockpitState> | null } = { current: null }
    render(
      <Harness onState={(s) => { stateRef.current = s }}>
        <CockpitManifestFace cabinId="c1" onClose={() => {}} />
      </Harness>,
    )
    expect(await screen.findByText('ledger')).toBeInTheDocument()
    expect(screen.getByText('console')).toBeInTheDocument()
    expect(screen.getByTestId('cockpit-manifest')).toBeDefined()

    fireEvent.click(screen.getByText('ledger'))
    await waitFor(() => expect(stateRef.current?.selection).toEqual(projectRef('c1', 'org:XzhiF/ledger')))
  })

  it('0 项目 → 空态 + 绑定入口（不画假列）', async () => {
    vi.mocked(fetchCabinRepos).mockResolvedValue([])
    render(
      <Harness>
        <CockpitManifestFace cabinId="c1" onClose={() => {}} />
      </Harness>,
    )
    expect(await screen.findByTestId('cockpit-manifest-empty')).toBeInTheDocument()
    expect(screen.getByText('这个舱还没绑项目')).toBeInTheDocument()
  })
})

describe('CockpitProjectFace · 点项目看仓库', () => {
  it('分支信息一行 + 文件浏览器 / git 变更两页签；← 舱籍总览回总览', async () => {
    const stateRef: { current: ReturnType<typeof useCockpitState> | null } = { current: null }
    const initial = projectRef('c1', 'org:XzhiF/ledger')
    render(
      <Harness initial={initial} onState={(s) => { stateRef.current = s }}>
        <CockpitProjectFace cabinId="c1" projectKey="org:XzhiF/ledger" onClose={() => {}} />
      </Harness>,
    )
    // 舱籍拉回来之后才出项目面（先「载入项目…」，拿到项目再切身体）。
    expect(await screen.findByText('⎇ main')).toBeInTheDocument()
    expect(screen.getByTestId('cockpit-project-face')).toBeInTheDocument()

    // 分支信息压成一行：分支 / HEAD / dirty / 提交时间（yyyy-MM-dd HH:mm:ss）。
    expect(screen.getByText(/主仓只读/)).toBeInTheDocument()
    expect(screen.getByText('⎇ main')).toBeInTheDocument()
    expect(screen.getByText('HEAD a91f3c2')).toBeInTheDocument()
    expect(screen.getByText('dirty')).toBeInTheDocument()
    expect(screen.getByText(formatDateTime('2026-11-23T05:12:00.000Z'))).toBeInTheDocument()

    // 文件浏览器：默认展开顶层 + 选中根层第一个文件并出内容（2026-11-24 收敛默认展开）。
    expect(await screen.findByText('# ledger')).toBeInTheDocument()

    // git 变更：目录树按单链缩一级（src 下 src/audit/chain 单链 ⇒ 一行 audit/chain）
    // + diff 预览（点开才拉 patch）。
    fireEvent.click(screen.getByTestId('project-tab-changes'))
    expect(await screen.findByTestId('project-chg-file-src/reconcile.ts')).toBeInTheDocument()
    expect(screen.getByText('audit/chain/')).toBeInTheDocument()
    await waitFor(() => expect(getRepoWorktreeChangePatch).toHaveBeenCalled())
    expect(await screen.findByText(/\+export const b = 3/)).toBeInTheDocument()

    // 头部的返回按钮 = 回舱籍总览（不是关面）。
    fireEvent.click(screen.getByTestId('project-back-roster'))
    await waitFor(() => expect(stateRef.current?.selection).toEqual(rosterRef('c1')))
  })

  it('项目不在舱里 → 明确说明，不是空面', async () => {
    vi.mocked(fetchCabinRepos).mockResolvedValue([])
    render(
      <Harness initial={projectRef('c1', 'org:Xzz/nope')}>
        <CockpitProjectFace cabinId="c1" projectKey="org:Xzz/nope" onClose={() => {}} />
      </Harness>,
    )
    expect(await screen.findByTestId('cockpit-project-missing')).toBeInTheDocument()
  })

  it('落点分支芯片：展示 mainline_branch，✎ 编辑保存走 PATCH，留空 = 显式清空', async () => {
    vi.mocked(setCabinRepoMainline).mockResolvedValue(
      repo({ key: 'org:XzhiF/ledger', name: 'ledger', mainline_branch: 'feat/landing' }),
    )
    render(
      <Harness initial={projectRef('c1', 'org:XzhiF/ledger')}>
        <CockpitProjectFace cabinId="c1" projectKey="org:XzhiF/ledger" onClose={() => {}} />
      </Harness>,
    )
    // 默认展示舱籍登记的落点分支（ledger = main）。
    const chip = await screen.findByTestId('project-mainline')
    expect(chip.textContent).toContain('落点')
    expect(chip.textContent).toContain('main')

    fireEvent.click(screen.getByTestId('project-mainline-edit'))
    const input = screen.getByTestId('project-mainline-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'feat/landing' } })
    fireEvent.click(screen.getByTestId('project-mainline-save'))
    await waitFor(() => expect(setCabinRepoMainline).toHaveBeenCalledWith('c1', 'ledger', 'feat/landing'))

    // 再编辑 → 留空保存 = null（清空回「按仓库默认分支探测」）。
    fireEvent.click(await screen.findByTestId('project-mainline-edit'))
    fireEvent.change(screen.getByTestId('project-mainline-input'), { target: { value: '  ' } })
    fireEvent.click(screen.getByTestId('project-mainline-save'))
    await waitFor(() => expect(setCabinRepoMainline).toHaveBeenLastCalledWith('c1', 'ledger', null))
  })

  it('落点分支保存失败 → 原地显示错误，不退出编辑', async () => {
    vi.mocked(setCabinRepoMainline).mockRejectedValue(new Error("落点分支 'feat/x' 在本地与 origin 上都不存在：ledger"))
    render(
      <Harness initial={projectRef('c1', 'org:XzhiF/ledger')}>
        <CockpitProjectFace cabinId="c1" projectKey="org:XzhiF/ledger" onClose={() => {}} />
      </Harness>,
    )
    fireEvent.click(await screen.findByTestId('project-mainline-edit'))
    fireEvent.change(screen.getByTestId('project-mainline-input'), { target: { value: 'feat/x' } })
    fireEvent.click(screen.getByTestId('project-mainline-save'))
    expect(await screen.findByTestId('project-mainline-err')).toHaveTextContent('都不存在')
    expect(screen.getByTestId('project-mainline-editor')).toBeInTheDocument()
  })
})

describe('CockpitProjectsPopover · HUD 读数', () => {
  it('读数显示项目数；浮层按来源分组', async () => {
    const projects = [
      repo({ key: 'org:XzhiF/ledger', name: 'ledger' }),
      repo({ key: 'local:apps/console', name: 'console', source: 'local', org: null, group: null, local_path: 'apps/console' }),
    ]
    render(
      <Harness>
        <CockpitProjectsPopover
          cabinId="c1"
          cabinName="账务中台"
          projects={projects}
          loading={false}
          error={null}
          onRefetch={() => {}}
          onBind={() => {}}
        />
      </Harness>,
    )
    const btn = screen.getByTestId('cockpit-projects-btn')
    expect(btn.textContent).toContain('账务中台')
    expect(btn.textContent).toContain('2')
    fireEvent.click(btn)
    expect(await screen.findByTestId('cockpit-projects-pop')).toBeInTheDocument()
    expect(screen.getByText(/ORG 注册项目/)).toBeInTheDocument()
    expect(screen.getByText(/本地 Git 仓库/)).toBeInTheDocument()
  })

  it('0 项目 → 读数写「＋ 绑定项目」；浮层空态', async () => {
    render(
      <Harness>
        <CockpitProjectsPopover
          cabinId="c1"
          cabinName="沙盒舱"
          projects={[]}
          loading={false}
          error={null}
          onRefetch={() => {}}
          onBind={() => {}}
        />
      </Harness>,
    )
    expect(screen.getByTestId('cockpit-projects-btn').textContent).toContain('＋ 绑定项目')
    fireEvent.click(screen.getByTestId('cockpit-projects-btn'))
    expect(await screen.findByTestId('cockpit-projects-empty')).toBeInTheDocument()
  })

  // 2026-11-19 用户 #5：别处（对话里让汐音绑 / 另一个窗口）绑了项目 —— 打开浮层即补拉。
  it('打开浮层触发一次 onRefetch', async () => {
    const onRefetch = vi.fn()
    render(
      <Harness>
        <CockpitProjectsPopover
          cabinId="c1"
          cabinName="账务中台"
          projects={[]}
          loading={false}
          error={null}
          onRefetch={onRefetch}
          onBind={() => {}}
        />
      </Harness>,
    )
    fireEvent.click(screen.getByTestId('cockpit-projects-btn'))
    expect(await screen.findByTestId('cockpit-projects-pop')).toBeInTheDocument()
    expect(onRefetch).toHaveBeenCalledTimes(1)
  })
})

describe('useCabinProjects · 外部绑定后自动补拉', () => {
  function ProjectsProbe({ sink }: { sink: (p: CabinRepoEntry[]) => void }) {
    const { projects } = useCabinProjects('c1')
    useEffect(() => { sink(projects) }, [projects, sink])
    return null
  }

  it('缓存过期后窗口重新获得焦点 → 重拉 /repos（不用整页刷新）', async () => {
    let latest: CabinRepoEntry[] = []
    render(<ProjectsProbe sink={(p) => { latest = p }} />)
    await waitFor(() => expect(latest).toHaveLength(2))
    expect(fetchCabinRepos).toHaveBeenCalledTimes(1)

    // 汐音在对话里绑了新项目（服务端已落盘），本地缓存仍是旧的。
    vi.mocked(fetchCabinRepos).mockResolvedValue([
      repo({ key: 'org:XzhiF/ledger', name: 'ledger' }),
      repo({ key: 'org:XzhiF/risk', name: 'risk' }),
      repo({
        key: 'local:apps/console', name: 'console', source: 'local', org: null,
        group: null, local_path: 'apps/console', main_path: '/tmp/c1/apps/console',
      }),
    ])
    // 把「现在」拨过 TTL —— focus 只在缓存过期时补拉（/repos?enrich=1 会跑 git）。
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
    act(() => { window.dispatchEvent(new Event('focus')) })
    spy.mockRestore()

    await waitFor(() => expect(latest.map((p) => p.name)).toContain('risk'))
    expect(fetchCabinRepos).toHaveBeenCalledTimes(2)
  })
})