// 绑定项目面板（v22 原型 · 2026-11-24 用户 #2）
// 两个页签：ORG 注册项目 / 本地 Git 仓库；保存 = 与现有条目求差集。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/lib/server-config', () => ({ getServerUrl: () => 'http://localhost:3001' }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>()
  return { ...actual, fetchManifestRepos: vi.fn(), browseDirectories: vi.fn() }
})
vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return {
    ...actual,
    addCabinRepo: vi.fn(),
    removeCabinRepo: vi.fn(),
    scanLocalProjects: vi.fn(),
  }
})
vi.mock('@/hooks/useOrgs', () => ({
  useOrgs: () => ({
    orgs: [
      { id: 1, name: 'XzhiF', path: '/orgs/XzhiF' },
      { id: 2, name: 'octo-finance', path: '/orgs/octo-finance' },
    ],
    loading: false,
    error: null,
  }),
}))

import { browseDirectories, fetchManifestRepos } from '@/lib/api-client'
import {
  addCabinRepo, removeCabinRepo, scanLocalProjects, type CabinRepoEntry,
} from '@/lib/cabin-api'
import { toast } from 'sonner'
import { clearOrgReposCache } from '@/lib/org-repos'
import { CockpitBindPanel, clearLocalScanCache } from '../CockpitBindPanel'

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

function renderPanel(projects: CabinRepoEntry[] = []) {
  const onClose = vi.fn()
  const onSaved = vi.fn()
  render(
    <CockpitBindPanel
      cabinId="c1"
      cabinName="账务中台"
      cabinPath="/cab"
      projects={projects}
      onClose={onClose}
      onSaved={onSaved}
    />,
  )
  return { onClose, onSaved }
}

const orgRow = (name: string) => document.querySelector(`[data-org-row="${name}"]`) as HTMLElement
const localRow = (name: string) => document.querySelector(`[data-local-row="${name}"]`) as HTMLElement

beforeEach(() => {
  vi.clearAllMocks()
  clearOrgReposCache()
  clearLocalScanCache()
  vi.mocked(fetchManifestRepos).mockImplementation(async (org: string) => ({
    groups: {
      [org]: org === 'XzhiF'
        ? [{ name: 'ledger' }, { name: 'risk' }]
        : [{ name: 'billing' }],
    },
  }) as never)
  vi.mocked(browseDirectories).mockResolvedValue({
    path: '/cab',
    parent: '/',
    home: '/home/u',
    roots: [{ name: '/', path: '/' }],
    dirs: [{ name: 'apps', path: '/cab/apps' }],
    canSelect: true,
  })
  vi.mocked(scanLocalProjects).mockResolvedValue([
    { name: 'console', local_path: 'apps/console', branch: 'feat/console', dirty: false, remote: null },
  ])
  vi.mocked(addCabinRepo).mockResolvedValue(repo({ key: 'org:XzhiF/x', name: 'x' }))
  vi.mocked(removeCabinRepo).mockResolvedValue({ removed: true })
})

describe('CockpitBindPanel · ORG 页签', () => {
  it('按 org 分组列出注册仓库；已绑的行带 git 读数', async () => {
    renderPanel([repo({ key: 'org:XzhiF/ledger', name: 'ledger' })])
    expect(await screen.findByText('billing')).toBeInTheDocument()
    expect(screen.getByText('risk')).toBeInTheDocument()
    // 已绑标记 + 分支 / HEAD / 时间（yyyy-MM-dd HH:mm:ss）
    expect(orgRow('ledger').dataset.bound).toBe('true')
    expect(orgRow('ledger').dataset.on).toBe('true')
    expect(orgRow('ledger').textContent).toContain('已绑')
    expect(orgRow('ledger').textContent).toContain('⎇ main')
    expect(orgRow('ledger').textContent).toContain('a91f3c2')
    expect(orgRow('ledger').textContent).toContain('2026-11-23')
  })

  it('搜索过滤；勾选进已选、再点取消', async () => {
    renderPanel()
    expect(await screen.findByText('ledger')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('cockpit-bind-search'), { target: { value: 'risk' } })
    expect(orgRow('ledger')).toBeNull()
    expect(orgRow('risk')).not.toBeNull()

    fireEvent.click(orgRow('risk'))
    expect(screen.getByTestId('cockpit-bind-selected').textContent).toContain('risk')
    expect(orgRow('risk').dataset.on).toBe('true')

    fireEvent.click(orgRow('risk'))
    expect(screen.getByTestId('cockpit-bind-selected').textContent).not.toContain('risk')
  })
})

describe('CockpitBindPanel · 本地 Git 仓库页签', () => {
  it('从舱目录起步：浏览目录 + 扫描 .git；勾选进已选', async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('cockpit-bind-tab-local'))

    await waitFor(() => expect(browseDirectories).toHaveBeenCalledWith('/cab'))
    // 面包屑逐段渲染（盘符 / 根不重复）：/cab → 「cab」。
    expect(await screen.findByTestId('cockpit-bind-dir-path')).toHaveTextContent('cab')
    expect(screen.getByTestId('cockpit-bind-dirs').textContent).toContain('apps')

    await waitFor(() => expect(scanLocalProjects).toHaveBeenCalledWith('/cab'))
    const row = await waitFor(() => {
      const el = localRow('console')
      expect(el).not.toBeNull()
      return el
    })
    expect(row.textContent).toContain('⎇ feat/console')

    fireEvent.click(row)
    expect(screen.getByTestId('cockpit-bind-selected').textContent).toContain('console')
    expect(localRow('console').dataset.on).toBe('true')
  })

  it('目录被系统策略挡住 → 扫描照常可用（舱目录也能绑）', async () => {
    vi.mocked(browseDirectories).mockRejectedValue(new Error('系统敏感目录不能浏览: /cab'))
    renderPanel()
    fireEvent.click(screen.getByTestId('cockpit-bind-tab-local'))
    await waitFor(() => expect(scanLocalProjects).toHaveBeenCalledWith('/cab'))
    expect(await screen.findByText(/系统敏感目录不能浏览/)).toBeInTheDocument()
    const row = await waitFor(() => {
      const el = localRow('console')
      expect(el).not.toBeNull()
      return el
    })
    fireEvent.click(row)
    expect(screen.getByTestId('cockpit-bind-selected').textContent).toContain('console')
  })

  it('已绑的本地项目按 main_path 回显为已选（不会被当成新增）', async () => {
    renderPanel([repo({
      key: 'local:apps/console', name: 'console', source: 'local', org: null, group: null,
      local_path: 'apps/console', main_path: '/cab/apps/console', external: false,
      mainline_branch: 'feat/console',
      git: { branch: 'feat/console', detached: false, commit: 'b7c1d10', msg: 'console', at: '2026-11-23T06:00:00.000Z', remote: null },
    })])
    fireEvent.click(screen.getByTestId('cockpit-bind-tab-local'))
    const row = await waitFor(() => {
      const el = localRow('console')
      expect(el).not.toBeNull()
      return el
    })
    expect(row.dataset.bound).toBe('true')
    expect(row.dataset.on).toBe('true')
  })

  it('进入子目录 → 重新浏览 + 重新扫描', async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('cockpit-bind-tab-local'))
    await screen.findByTestId('cockpit-bind-dirs')

    vi.mocked(browseDirectories).mockResolvedValue({
      path: '/cab/apps',
      parent: '/cab',
      home: '/home/u',
      roots: [{ name: '/', path: '/' }],
      dirs: [],
      canSelect: true,
    })
    fireEvent.click(document.querySelector('[data-dir-entry="apps"]') as HTMLElement)
    await waitFor(() => expect(browseDirectories).toHaveBeenCalledWith('/cab/apps'))
    expect(await screen.findByTestId('cockpit-bind-dir-path')).toHaveTextContent('cab/apps')
    await waitFor(() => expect(scanLocalProjects).toHaveBeenCalledWith('/cab/apps'))
  })
})

describe('CockpitBindPanel · 保存（差集）', () => {
  it('新增 ORG + 本地；取消勾选的已绑项走解绑', async () => {
    const { onClose, onSaved } = renderPanel([
      repo({ key: 'org:XzhiF/ledger', name: 'ledger' }),
    ])
    // 已绑的 ledger 取消勾选 = 解绑
    await screen.findByText('risk')
    fireEvent.click(orgRow('ledger'))
    fireEvent.click(orgRow('risk'))

    // 本地新增 console
    fireEvent.click(screen.getByTestId('cockpit-bind-tab-local'))
    const row = await waitFor(() => {
      const el = localRow('console')
      expect(el).not.toBeNull()
      return el
    })
    fireEvent.click(row)

    fireEvent.click(screen.getByTestId('cockpit-bind-save'))

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(addCabinRepo).toHaveBeenCalledWith('c1', { source: 'org', name: 'risk', org: 'XzhiF' })
    expect(addCabinRepo).toHaveBeenCalledWith('c1', {
      source: 'local',
      name: 'console',
      absolutePath: '/cab/apps/console',
      external: true,
    })
    expect(removeCabinRepo).toHaveBeenCalledWith('c1', 'ledger')
    expect(toast.success).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('保存失败 → toast.error，不关面板', async () => {
    vi.mocked(addCabinRepo).mockRejectedValue(new Error('不是 git 仓库：/cab/apps/console'))
    const { onClose, onSaved } = renderPanel()
    await screen.findByText('risk')
    fireEvent.click(orgRow('risk'))
    fireEvent.click(screen.getByTestId('cockpit-bind-save'))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
