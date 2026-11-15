import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CabinDetail } from '@/lib/cabin-api'
import { ChatSidebar } from '../chat-sidebar'

function cabin(id: string, name: string, status: CabinDetail['status']): CabinDetail {
  return {
    id, name, path: `/tmp/${id}`, workspace_id: 'ws', main_session_id: 'sess',
    requirements: '', status, mainline_strategy: 'clean-main', org: null,
    focused_job_id: null, version: 1, created_at: '', updated_at: '',
    last_active_at: null, archived_at: null,
  }
}

const baseProps = {
  tasks: [],
  tasksLoading: false,
  activeTaskId: null,
  onSelectTask: vi.fn(),
  sessions: [],
  sessionsLoading: false,
  activeSessionId: null,
  onSelectSession: vi.fn(),
  onCreateSession: vi.fn(),
  onCreateTask: vi.fn(),
  onRenameSession: vi.fn(),
  onDeleteSession: vi.fn(),
  searchOpen: false,
  onSearchOpenChange: vi.fn(),
}

describe('ChatSidebar — cabin section (prototype 三段左栏)', () => {
  it('keeps task/session sections and prepends the 作战舱 section', () => {
    render(
      <ChatSidebar
        {...baseProps}
        cabins={[cabin('c1', 'Aurora', 'active'), cabin('c2', 'Hermes', 'dormant')]}
        activeCabinId="c1"
        onSelectCabin={vi.fn()}
        onCreateCabin={vi.fn()}
      />,
    )
    expect(screen.getByTestId('cabin-section')).toBeInTheDocument()
    expect(screen.getByTestId('task-session-section')).toBeInTheDocument()
    expect(screen.getByText('作战舱')).toBeInTheDocument()
    expect(screen.getByText('任务')).toBeInTheDocument()
    expect(screen.getByText('会话')).toBeInTheDocument()
    expect(screen.getByText('Aurora')).toBeInTheDocument()
    expect(screen.getByText('Hermes')).toBeInTheDocument()
    expect(screen.getByTestId('cabin-section').querySelector('[data-cabin-row="c1"]')?.getAttribute('aria-current')).toBe('page')
  })

  it('clicking a cabin row routes to that cabin', () => {
    const onSelectCabin = vi.fn()
    render(
      <ChatSidebar
        {...baseProps}
        cabins={[cabin('c1', 'Aurora', 'active'), cabin('c2', 'Hermes', 'dormant')]}
        activeCabinId="c1"
        onSelectCabin={onSelectCabin}
      />,
    )
    fireEvent.click(screen.getByText('Hermes'))
    expect(onSelectCabin).toHaveBeenCalledWith('c2')
  })

  it('new-conversation menu carries the highlighted 新建作战舱 entry', async () => {
    const onCreateCabin = vi.fn()
    render(
      <ChatSidebar
        {...baseProps}
        cabins={[]}
        onCreateCabin={onCreateCabin}
      />,
    )
    await userEvent.click(screen.getByText('开启新对话'))
    const item = await screen.findByTestId('sidebar-new-cabin')
    expect(item).toBeInTheDocument()
    await userEvent.click(item)
    expect(onCreateCabin).toHaveBeenCalled()
  })

  it('作战舱段标题带「+」新建入口（空列表也能直接建）', () => {
    const onCreateCabin = vi.fn()
    render(
      <ChatSidebar
        {...baseProps}
        cabins={[]}
        onCreateCabin={onCreateCabin}
      />,
    )
    fireEvent.click(screen.getByTestId('cabin-section-new'))
    expect(onCreateCabin).toHaveBeenCalled()
  })

  it('desktop rendering without cabin props stays two-section (no cabin entry)', async () => {
    render(<ChatSidebar {...baseProps} />)
    expect(screen.queryByTestId('cabin-section')).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('开启新对话'))
    expect(screen.queryByTestId('sidebar-new-cabin')).not.toBeInTheDocument()
  })

  it('新建舱草稿行：呼吸点 + 草稿中 + 计数 +1；点它回新建页', () => {
    const onOpenDraft = vi.fn()
    render(
      <ChatSidebar
        {...baseProps}
        cabins={[cabin('c1', 'Aurora', 'active')]}
        onSelectCabin={vi.fn()}
        onCreateCabin={vi.fn()}
        pendingCabin={{ name: '未命名舱' }}
        activePendingCabin
        onOpenDraft={onOpenDraft}
        onCancelDraft={vi.fn()}
      />,
    )
    const row = screen.getByTestId('pending-cabin-item')
    expect(row).toHaveAttribute('aria-current', 'page')
    expect(row).toHaveTextContent('未命名舱')
    expect(row).toHaveTextContent('草稿中')
    // 计数 = 已有舱 1 + 草稿 1
    expect(screen.getByTestId('cabin-section')).toHaveTextContent('2')
    fireEvent.click(row)
    expect(onOpenDraft).toHaveBeenCalled()
  })

  it('悬停 × 丢弃草稿（零请求、无确认）', () => {
    const onCancelDraft = vi.fn()
    const onSelectCabin = vi.fn()
    render(
      <ChatSidebar
        {...baseProps}
        cabins={[]}
        onSelectCabin={onSelectCabin}
        onCreateCabin={vi.fn()}
        pendingCabin={{ name: '账本舱' }}
        onOpenDraft={vi.fn()}
        onCancelDraft={onCancelDraft}
      />,
    )
    fireEvent.click(screen.getByTestId('pending-cabin-cancel'))
    expect(onCancelDraft).toHaveBeenCalledTimes(1)
    expect(onSelectCabin).not.toHaveBeenCalled()
  })
})

// 2026-11-15 用户要求：舱行跟任务行一样，悬停「⋯」→ 重命名 / 删除；
// 删除走确认弹框，**默认不勾**「同时删除本地文件」，勾上才连目录一起删。
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

describe('ChatSidebar — 作战舱行菜单与弹框', () => {
  const withActions = (overrides: Partial<Parameters<typeof ChatSidebar>[0]> = {}) => render(
    <ChatSidebar
      {...baseProps}
      cabins={[cabin('c1', 'Aurora', 'active')]}
      activeCabinId="c1"
      onSelectCabin={vi.fn()}
      onRenameCabin={vi.fn().mockResolvedValue(undefined)}
      onDeleteCabin={vi.fn().mockResolvedValue(undefined)}
      {...overrides}
    />,
  )

  it('舱行「⋯」菜单：重命名 / 复制名称 / 删除', async () => {
    const user = userEvent.setup()
    withActions()
    await user.click(screen.getByRole('button', { name: '作战舱操作 Aurora' }))
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((item) => item.textContent?.trim())).toEqual(['重命名', '复制名称', '删除'])
  })

  it('重命名弹框：改名后回写 onRenameCabin(cabin, 新名)', async () => {
    const user = userEvent.setup()
    const onRenameCabin = vi.fn().mockResolvedValue(undefined)
    withActions({ onRenameCabin })
    await user.click(screen.getByRole('button', { name: '作战舱操作 Aurora' }))
    await user.click(await screen.findByRole('menuitem', { name: /^重命名$/ }))
    const input = await screen.findByTestId('cabin-rename-input')
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('Aurora'))
    fireEvent.change(input, { target: { value: '结算舱' } })
    await user.click(screen.getByTestId('cabin-rename-save'))
    await waitFor(() => expect(onRenameCabin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1' }), '结算舱',
    ))
    await waitFor(() => expect(screen.queryByTestId('cabin-rename-dialog')).toBeNull())
  })

  it('删除弹框：默认不勾「同时删除本地文件」→ deleteFiles:false', async () => {
    const user = userEvent.setup()
    const onDeleteCabin = vi.fn().mockResolvedValue(undefined)
    withActions({ onDeleteCabin })
    await user.click(screen.getByRole('button', { name: '作战舱操作 Aurora' }))
    await user.click(await screen.findByRole('menuitem', { name: /^删除$/ }))
    const dialog = await screen.findByTestId('cabin-delete-dialog')
    expect(dialog).toHaveTextContent('软删除')
    expect(dialog).toHaveTextContent('/tmp/c1') // 目录摆出来给人看
    expect(screen.getByTestId('cabin-delete-files')).toHaveAttribute('aria-checked', 'false')
    await user.click(screen.getByTestId('cabin-delete-confirm'))
    await waitFor(() => expect(onDeleteCabin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1' }), { deleteFiles: false },
    ))
  })

  it('删除弹框：勾上「同时删除本地文件」→ deleteFiles:true', async () => {
    const user = userEvent.setup()
    const onDeleteCabin = vi.fn().mockResolvedValue(undefined)
    withActions({ onDeleteCabin })
    await user.click(screen.getByRole('button', { name: '作战舱操作 Aurora' }))
    await user.click(await screen.findByRole('menuitem', { name: /^删除$/ }))
    await user.click(await screen.findByTestId('cabin-delete-files'))
    await waitFor(() => expect(screen.getByTestId('cabin-delete-files')).toHaveAttribute('aria-checked', 'true'))
    await user.click(screen.getByTestId('cabin-delete-confirm'))
    await waitFor(() => expect(onDeleteCabin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1' }), { deleteFiles: true },
    ))
  })

  it('没接回调（桌面普通对话）时舱行不出「⋯」', () => {
    render(
      <ChatSidebar
        {...baseProps}
        cabins={[cabin('c1', 'Aurora', 'active')]}
        onSelectCabin={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('cabin-row-menu')).toBeNull()
  })
})