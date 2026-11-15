// 新建作战舱 v5 页（CabinCreateHero）—— 锁 7 条硬规则：
// 需求唯一必填 / 一屏走完（提交即建，没有提案页和完成页）/ 舱名可选 /
// 一目录一舱拦住只打开 / 提交前零请求 / create 后直接进舱再 init / 失败可重试。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useState } from 'react'
import type { CabinDetail } from '@/lib/cabin-api'
import { createCabinWithResult, initCabin } from '@/lib/cabin-api'
import { emptyCabinDraft, type CabinDraft } from '@/lib/cabin-draft'

vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return {
    ...actual,
    createCabinWithResult: vi.fn(),
    initCabin: vi.fn(),
  }
})

vi.mock('@/components/cabin/CabinProjectBinder', () => ({
  CabinProjectBinder: ({ selected, onChange }: { selected: { org: string; repo: string }[]; onChange: (n: { org: string; repo: string }[]) => void }) => (
    <div data-testid="project-binder-probe">
      <span data-testid="project-binder-count">{selected.length}</span>
      <button type="button" data-testid="add-project" onClick={() => onChange([...selected, { org: 'acme', repo: 'billing' }])}>add-project</button>
    </div>
  ),
}))

import { CabinCreateHero } from '../CabinCreateHero'

function cabin(id: string, name: string, path: string): CabinDetail {
  return {
    id, name, path, workspace_id: 'ws', main_session_id: 'sess',
    requirements: '', status: 'active', mainline_strategy: 'clean-main', org: null,
    focused_job_id: null, version: 1, created_at: '', updated_at: '',
    last_active_at: null, archived_at: null,
  }
}

function Harness({
  initial,
  cabins = [],
  onCancel = vi.fn(),
  onCreated = vi.fn(),
}: {
  initial: CabinDraft
  cabins?: CabinDetail[]
  onCancel?: () => void
  onCreated?: (id: string) => void
}) {
  const [draft, setDraft] = useState(initial)
  return (
    <CabinCreateHero
      draft={draft}
      cabins={cabins}
      onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
      onCancel={onCancel}
      onCreated={onCreated}
    />
  )
}

const base = { ...emptyCabinDraft(), updatedAt: Date.now() }

describe('CabinCreateHero — 一屏说完，直接进初始化', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.mocked(createCabinWithResult).mockReset()
    vi.mocked(initCabin).mockReset()
  })

  it('需求为空 → 不可提交；舱名是可选的第三颗控件；目录默认新建工作空间', () => {
    render(<Harness initial={base} />)
    expect(screen.getByTestId('cabin-create-submit')).toBeDisabled()
    expect(screen.getByTestId('cabin-name-input')).toHaveAttribute('placeholder', '舱名（可选）')
    expect(screen.getByTestId('cabin-dir-chip-text')).toHaveTextContent('新建工作空间')
  })

  it('不填舱名 → 提交只发一次 create（不带 name），直接进舱再 init；没有中间页', async () => {
    vi.mocked(createCabinWithResult).mockResolvedValue({
      cabin: cabin('c9', '未命名舱', '/tmp/cabin'),
      created: true,
    })
    vi.mocked(initCabin).mockResolvedValue(cabin('c9', '未命名舱', '/tmp/cabin'))
    const onCreated = vi.fn()
    render(<Harness initial={{ ...base, requirements: '做一个电商后台' }} onCreated={onCreated} />)

    fireEvent.click(screen.getByTestId('cabin-create-submit'))

    await waitFor(() => expect(createCabinWithResult).toHaveBeenCalledTimes(1))
    expect(createCabinWithResult).toHaveBeenCalledWith({ requirements: '做一个电商后台' })
    // 一屏走完：没有提案页 / 完成页，直接进舱
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('c9'))
    expect(screen.queryByTestId('cabin-proposal')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cabin-created')).not.toBeInTheDocument()
    await waitFor(() => expect(initCabin).toHaveBeenCalledWith('c9'))
  })

  it('填了舱名 → create 带上它', async () => {
    vi.mocked(createCabinWithResult).mockResolvedValue({
      cabin: cabin('c9', '小卖部', '/tmp/cabin'),
      created: true,
    })
    vi.mocked(initCabin).mockResolvedValue(cabin('c9', '小卖部', '/tmp/cabin'))
    render(<Harness initial={base} />)

    fireEvent.change(screen.getByTestId('cabin-req-input'), { target: { value: '做一个电商后台' } })
    fireEvent.change(screen.getByTestId('cabin-name-input'), { target: { value: '小卖部' } })
    fireEvent.click(screen.getByTestId('cabin-create-submit'))

    await waitFor(() => expect(createCabinWithResult).toHaveBeenCalledWith({
      name: '小卖部',
      requirements: '做一个电商后台',
    }))
  })

  it('目录 + 项目一起带上（跨 org 关联）', async () => {
    vi.mocked(createCabinWithResult).mockResolvedValue({
      cabin: cabin('c9', '账本舱', '/tmp/ledger'),
      created: true,
    })
    vi.mocked(initCabin).mockResolvedValue(cabin('c9', '账本舱', '/tmp/ledger'))
    render(<Harness initial={{ ...base, path: '/tmp/ledger', requirements: '长期盯对账' }} />)

    fireEvent.click(screen.getByTestId('cabin-project-chip'))
    fireEvent.click(screen.getByTestId('add-project'))
    fireEvent.click(screen.getByTestId('cabin-create-submit'))

    await waitFor(() => expect(createCabinWithResult).toHaveBeenCalledWith({
      requirements: '长期盯对账',
      path: '/tmp/ledger',
      projects: [{ org: 'acme', repo: 'billing' }],
    }))
  })

  it('一个目录只能有一个舱：选中已有舱的目录 → 拦住，主按钮变「打开」', () => {
    const existing = cabin('c1', '八爪舱', '/tmp/octopus')
    render(<Harness initial={{ ...base, path: '/tmp/octopus' }} cabins={[existing]} />)

    expect(screen.getByTestId('cabin-conflict')).toHaveTextContent('一个目录只能有一个舱')
    const submit = screen.getByTestId('cabin-create-submit')
    expect(submit).toHaveTextContent('打开「八爪舱」')
    // 需求为空也能点 —— 打开不需要需求。
    expect(submit).toBeEnabled()
  })

  it('点「打开」→ 只进已有舱，零写请求', async () => {
    const onCreated = vi.fn()
    render(
      <Harness
        initial={{ ...base, path: '/tmp/octopus' }}
        cabins={[cabin('c1', '八爪舱', '/tmp/octopus')]}
        onCreated={onCreated}
      />,
    )
    fireEvent.click(screen.getByTestId('cabin-create-submit'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('c1'))
    expect(createCabinWithResult).not.toHaveBeenCalled()
    expect(initCabin).not.toHaveBeenCalled()
  })

  it('created:false（目录在这期间成了舱）→ 不 init，直接打开', async () => {
    vi.mocked(createCabinWithResult).mockResolvedValue({
      cabin: cabin('c1', '八爪舱', '/tmp/octopus'),
      created: false,
    })
    const onCreated = vi.fn()
    render(
      <Harness
        initial={{ ...base, path: '/tmp/octopus', requirements: '重开一个' }}
        onCreated={onCreated}
      />,
    )
    fireEvent.click(screen.getByTestId('cabin-create-submit'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('c1'))
    expect(initCabin).not.toHaveBeenCalled()
  })

  it('create 失败 → 留在这一屏、原文还在、还能再点', async () => {
    vi.mocked(createCabinWithResult).mockRejectedValueOnce(new Error('boom'))
    const onCreated = vi.fn()
    render(<Harness initial={{ ...base, requirements: '做一个电商后台' }} onCreated={onCreated} />)

    fireEvent.click(screen.getByTestId('cabin-create-submit'))
    await waitFor(() => expect(createCabinWithResult).toHaveBeenCalledTimes(1))
    expect(onCreated).not.toHaveBeenCalled()
    expect(screen.getByTestId('cabin-req-input')).toHaveValue('做一个电商后台')
    expect(screen.getByTestId('cabin-create-submit')).toBeEnabled()
  })

  it('目录弹层：默认档「新建工作空间」/ 已有舱 / 选择目录…', () => {
    const existing = cabin('c1', '八爪舱', '/tmp/octopus')
    render(<Harness initial={base} cabins={[existing]} />)
    fireEvent.click(screen.getByTestId('cabin-dir-chip'))
    expect(screen.getByTestId('cabin-dir-default')).toHaveTextContent('新建工作空间')
    expect(screen.getByTestId('cabin-dir-pop')).toHaveTextContent('已经有的舱')
    expect(screen.getByTestId('cabin-dir-browse')).toHaveTextContent('选择目录…')
  })

  it('× 丢弃草稿（不弹确认）', () => {
    const onCancel = vi.fn()
    render(<Harness initial={base} onCancel={onCancel} />)
    fireEvent.click(screen.getByTestId('cabin-create-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})