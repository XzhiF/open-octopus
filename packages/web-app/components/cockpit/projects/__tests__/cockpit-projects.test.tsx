// 舱籍（projects）· 2026-11-15
// 纯模型 + 舱籍面 / 项目面 / 浮层：点项目看仓库（不是跳作业）、只看它的作业
// 只筛左栏不换面、空态诚实。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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
  fetchCabinRepos, getCabin, listCabins, listCabinJobs, type CabinDetail, type CabinRepoEntry,
} from '@/lib/cabin-api'
import { listTasks } from '@/lib/tasks-api'
import { listRunningSessions } from '@/lib/agent/api'
import { CockpitStateProvider, useCockpitState } from '../../state/CockpitStateProvider'
import { CockpitLayerStack } from '../../state/CockpitLayerStack'
import { CockpitFleetProvider } from '../../fleet/CockpitFleetProvider'
import type { CockpitRef } from '../../state/cockpit-state'
import { CockpitManifestFace } from '../CockpitManifestFace'
import { CockpitProjectFace } from '../CockpitProjectFace'
import { CockpitProjectsPopover } from '../CockpitProjectsPopover'
import { invalidateCabinProjects } from '../use-cabin-projects'
import {
  projectNameFromKey, projectRef, projectStats, rosterRef, rowProjectKeys,
} from '../project-model'
import { refInRows } from '../../entry/cockpit-candidates'

function cabin(id: string, name: string): CabinDetail {
  return {
    id, name, path: `/tmp/${id}`, workspace_id: `ws-${id}`, main_session_id: `s-${id}`,
    requirements: '', status: 'active', mainline_strategy: 'clean-main', org: null,
    focused_job_id: null, version: 3,
    created_at: '2026-11-14T00:00:00.000Z', updated_at: '2026-11-14T00:00:00.000Z',
    last_active_at: null, archived_at: null,
  }
}

function repo(over: Partial<CabinRepoEntry> & { key: string; name: string }): CabinRepoEntry {
  return {
    source: 'org', org: 'XzhiF', group: 'XzhiF', repoName: over.name,
    main_path: `/repos/${over.name}`, local_path: null, external: false,
    mainline_branch: 'main', worktree_path: null, branch: null, worktrees: [],
    git: { branch: 'main', detached: false, commit: 'a91f3c2', msg: '对齐尾差', at: '09:12', remote: 'git@x:ledger' },
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
  vi.mocked(getCabin).mockImplementation(async (id: string) => ({ cabin: cabin(id, '账务中台'), view: {} as never }))
  vi.mocked(listCabinJobs).mockResolvedValue([
    {
      id: 'j1', cabin_id: 'c1', kind: 'task', ref_id: 't1', session_id: null,
      title: '对齐尾差', mandate: null, prompt: null, priority: 0,
      created_at: '2026-11-15T01:00:00.000Z', ended_at: null,
      status: 'running', transport: 'task-thread',
      project_keys: ['org:XzhiF/ledger'],
    },
    {
      id: 'j2', cabin_id: 'c1', kind: 'workflow', ref_id: null, session_id: null,
      title: '杂活', mandate: null, prompt: null, priority: 0,
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
      git: { branch: 'feat/console', detached: false, commit: 'b7c1d10', msg: 'console', at: '10:00', remote: null },
    }),
  ])
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
  it('展示仓库字段；「只看它的作业」只筛左栏，不换面', async () => {
    const stateRef: { current: ReturnType<typeof useCockpitState> | null } = { current: null }
    const initial = projectRef('c1', 'org:XzhiF/ledger')
    render(
      <Harness initial={initial} onState={(s) => { stateRef.current = s }}>
        <CockpitProjectFace cabinId="c1" projectKey="org:XzhiF/ledger" onClose={() => {}} />
      </Harness>,
    )
    expect(await screen.findByTestId('cockpit-project-face')).toBeInTheDocument()
    expect(screen.getAllByText('仓库').length).toBeGreaterThan(0)
    expect(screen.getByText('门槛')).toBeInTheDocument()
    expect(screen.getByText(/主仓只读/)).toBeInTheDocument()
    expect(screen.getByText('/repos/ledger')).toBeInTheDocument()
    // 项目上的作业
    expect(screen.getByText('对齐尾差')).toBeInTheDocument()
    // 未归属的作业不硬塞进来
    expect(screen.queryByText('杂活')).toBeNull()

    fireEvent.click(screen.getByTestId('project-only-jobs'))
    await waitFor(() => expect(stateRef.current?.projectFilter).toBe('org:XzhiF/ledger'))
    expect(stateRef.current?.selection).toEqual(initial)
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
    expect(screen.getByText(/本地 \/ 外部/)).toBeInTheDocument()
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
})