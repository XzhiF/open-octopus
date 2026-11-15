// 绑定项目面板：搜索过滤/高亮、无结果、已选条移除、跨 org 累加（不清空）。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useState } from 'react'
import type { CabinProjectRef } from '@/lib/cabin-draft'
import { fetchManifestRepos } from '@/lib/api-client'

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

import { CabinProjectBinder } from '../CabinProjectBinder'

function Harness({ initial = [] as CabinProjectRef[] }) {
  const [selected, setSelected] = useState<CabinProjectRef[]>(initial)
  return <CabinProjectBinder selected={selected} onChange={setSelected} />
}

describe('CabinProjectBinder — 跨 org 关联', () => {
  beforeEach(() => {
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