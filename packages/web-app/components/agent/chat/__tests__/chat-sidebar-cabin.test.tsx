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
  it('keeps task/session sections and prepends the 工作舱 section', () => {
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
    expect(screen.getByText('工作舱')).toBeInTheDocument()
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

  it('new-conversation menu carries the highlighted 新建工作舱 entry', async () => {
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

  it('工作舱段标题带「+」新建入口（空列表也能直接建）', () => {
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
})