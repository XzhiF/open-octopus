import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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