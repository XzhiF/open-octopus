// 绑定项目面板：搜索过滤/高亮、无结果、已选条移除、跨 org 累加（不清空）。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import type { CabinProjectRef } from '@/lib/cabin-draft'
import { fetchManifestRepos } from '@/lib/api-client'
import { scanLocalProjects } from '@/lib/cabin-api'

vi.mock('@/hooks/useOrgs', () => ({
  useOrgs: () => ({
    orgs: [{ id: 1, name: 'XzhiF', path: '' }, { id: 2, name: 'acme', path: '' }],
    loading: false,
    error: null,
  }),
}))

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>()
  return { ...actual, fetchManifestRepos: vi.fn() }
})

vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return { ...actual, scanLocalProjects: vi.fn() }
})

import { CabinProjectBinder } from '../CabinProjectBinder'

function Harness({ initial = [] as CabinProjectRef[] }) {
  const [selected, setSelected] = useState<CabinProjectRef[]>(initial)
  return <CabinProjectBinder selected={selected} onChange={setSelected} />
}

describe('CabinProjectBinder — 跨 org 关联', () => {
  beforeEach(() => {
    vi.mocked(scanLocalProjects).mockResolvedValue([])
    vi.mocked(fetchManifestRepos).mockImplementation(async (org: string) => {
      if (org === 'XzhiF') {
        return { groups: { XzhiF: [{ name: 'ledger' }, { name: 'engine' }, { name: 'web-app' }] } }
      }
      return { groups: { acme: [{ name: 'billing' }, { name: 'gateway' }] } }
    })
  })

  it('按 org 分组并带计数', async () => {
    render(<Harness />)
    await waitFor(() => expect(screen.getByText('ledger')).toBeInTheDocument())
    expect(screen.getByTestId('cabin-project-list')).toHaveTextContent('XzhiF')
    expect(screen.getByTestId('cabin-project-list')).toHaveTextContent('acme')
    expect(screen.getByTestId('cabin-project-list')).toHaveTextContent('billing')
  })

  it('搜索按项目名或 org 过滤，命中高亮；无结果给文案', async () => {
    render(<Harness />)
    await waitFor(() => expect(screen.getByText('ledger')).toBeInTheDocument())

    fireEvent.change(screen.getByTestId('cabin-project-search'), { target: { value: 'led' } })
    const list = screen.getByTestId('cabin-project-list')
    expect(list.textContent).toContain('ledger')
    expect(list.textContent).not.toContain('engine')
    expect(list.querySelector('mark')).toBeTruthy()

    fireEvent.change(screen.getByTestId('cabin-project-search'), { target: { value: 'acme' } })
    expect(screen.getByTestId('cabin-project-list').textContent).toContain('billing')
    expect(screen.getByTestId('cabin-project-list').textContent).not.toContain('ledger')

    fireEvent.change(screen.getByTestId('cabin-project-search'), { target: { value: 'zzz' } })
    expect(screen.getByTestId('cabin-project-list')).toHaveTextContent('没有匹配「zzz」的项目')
  })

  it('跨 org 勾选不清空；已选条可单个移除', async () => {
    render(<Harness />)
    await waitFor(() => expect(screen.getByText('ledger')).toBeInTheDocument())

    fireEvent.click(screen.getByText('ledger'))
    fireEvent.click(screen.getByText('billing'))
    await waitFor(() => expect(screen.getByTestId('cabin-project-selected')).toBeInTheDocument())
    expect(screen.getByTestId('cabin-project-selected').children).toHaveLength(2)

    fireEvent.click(screen.getByLabelText('移除 XzhiF/ledger'))
    expect(screen.getByTestId('cabin-project-selected').children).toHaveLength(1)
    expect(screen.getByTestId('cabin-project-selected')).toHaveTextContent('acme')
  })

  it('语义写在底部：项目是关联关系，不搬代码', async () => {
    render(<Harness />)
    await waitFor(() => expect(screen.getByText('ledger')).toBeInTheDocument())
    expect(screen.getByTestId('cabin-project-binder')).toHaveTextContent('项目是关联关系，不搬代码')
  })
})

describe('CabinProjectBinder — 本地目录映射（舱籍第三轮）', () => {
  beforeEach(() => {
    vi.mocked(fetchManifestRepos).mockResolvedValue({
      groups: { XzhiF: [{ name: 'ledger' }] },
    })
    vi.mocked(scanLocalProjects).mockResolvedValue([
      { name: 'console', local_path: 'console', branch: 'feat/console', dirty: false, remote: null },
      { name: 'scripts', local_path: 'tools/scripts', branch: 'main', dirty: true, remote: null },
    ])
  })

  it('本地组置顶、带路径与来源标；深度 1 默认勾上', async () => {
    const seen: CabinProjectRef[][] = []
    function LocalHarness() {
      const [selected, setSelected] = useState<CabinProjectRef[]>([])
      return (
        <CabinProjectBinder
          selected={selected}
          onChange={(next) => { seen.push(next); setSelected(next) }}
          dirPath="/w/aurora"
        />
      )
    }
    render(<LocalHarness />)
    await waitFor(() => expect(screen.getByTestId('cabin-project-local-group')).toBeInTheDocument())
    const list = screen.getByTestId('cabin-project-list')
    // 本地组在 ORG 组之前
    expect(list.textContent?.indexOf('本地目录')).toBeLessThan(list.textContent?.indexOf('XzhiF') ?? -1)
    expect(screen.getByTestId('cabin-project-list').textContent).toContain('console')
    expect(screen.getAllByText('本地').length).toBeGreaterThan(0)
    // 深度 1 默认选中；深度 2 不默认选
    await waitFor(() => expect(seen.at(-1)?.map((p) => p.repo)).toEqual(['console']))
    expect(seen.at(-1)?.[0]).toMatchObject({ source: 'local', localPath: 'console' })
  })

  it('点深度 2 项目 → 选择里带 localPath；再点取消', async () => {
    const seen: CabinProjectRef[][] = []
    function LocalHarness() {
      const [selected, setSelected] = useState<CabinProjectRef[]>([])
      return (
        <CabinProjectBinder
          selected={selected}
          onChange={(next) => { seen.push(next); setSelected(next) }}
          dirPath="/w/aurora"
        />
      )
    }
    render(<LocalHarness />)
    await waitFor(() => expect(screen.getByTestId('cabin-project-list').textContent).toContain('scripts'))
    const list = () => screen.getByTestId('cabin-project-list')
    fireEvent.click(within(list()).getByText('scripts'))
    await waitFor(() => expect(seen.at(-1)?.some((p) => p.repo === 'scripts')).toBe(true))
    fireEvent.click(within(list()).getByText('scripts'))
    await waitFor(() => expect(seen.at(-1)?.some((p) => p.repo === 'scripts')).toBe(false))
  })

  it('舱外目录显式登记 → absolutePath + external', async () => {
    const seen: CabinProjectRef[][] = []
    function LocalHarness() {
      const [selected, setSelected] = useState<CabinProjectRef[]>([])
      return (
        <CabinProjectBinder
          selected={selected}
          onChange={(next) => { seen.push(next); setSelected(next) }}
          dirPath="/w/aurora"
        />
      )
    }
    render(<LocalHarness />)
    await waitFor(() => expect(screen.getByTestId('cabin-project-external-open')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('cabin-project-external-open'))
    fireEvent.change(screen.getByTestId('cabin-project-external-input'), {
      target: { value: '/shared/gateway' },
    })
    fireEvent.click(screen.getByText('登记'))
    await waitFor(() => {
      const added = seen.at(-1)?.find((p) => p.repo === 'gateway')
      expect(added).toMatchObject({ source: 'local', absolutePath: '/shared/gateway', external: true })
    })
  })
})