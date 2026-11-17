// 舱归属范围（2026-11-17）：左栏默认只看当前舱；外部 / 全部可切。
//
// 钉住：
//   ① 当前舱范围：别的舱 + 舱外活动都不出现，底部给「另有 N 条舱外活动」出口；
//   ② 外部范围：只剩 cabin_id = NULL 的活动；
//   ③ 全部范围：都在，行上补舱 chip（含「外部」中性 chip）；
//   ④ 点出口 = 切到全部（不做静默隐藏）。

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { CabinDetail } from '@/lib/cabin-api'
import type { AgentSession } from '@/lib/agent/types'
import type { TaskView } from '@/lib/tasks-api'
import { ChatSidebar } from '../chat-sidebar'

function cabin(id: string, name: string): CabinDetail {
  return {
    id, name, path: `/tmp/${id}`, workspace_id: 'ws', main_session_id: 'sess',
    requirements: '', status: 'active', mainline_strategy: 'clean-main', org: null,
    version: 1, created_at: '', updated_at: '',
    last_active_at: null, archived_at: null,
  }
}

const task = (id: string, name: string, cabinId: string | null): TaskView => ({
  id,
  name,
  status: 'draft',
  cabin_id: cabinId,
  version: 1,
} as unknown as TaskView)

const session = (id: string, title: string, cabinId: string | null): AgentSession => ({
  id,
  title,
  clone_name: null,
  session_type: 'main',
  created_at: '2026-11-17T00:00:00Z',
  updated_at: '2026-11-17T00:00:00Z',
  last_message_at: null,
  is_active: true,
  cabin_id: cabinId,
})

const noop = () => {}

const tasks = [
  task('t-c1', '本舱任务', 'c1'),
  task('t-c2', '别舱任务', 'c2'),
  task('t-ext', '舱外任务', null),
]
const sessions = [
  session('s-c1', '本舱对话', 'c1'),
  session('s-c2', '别舱对话', 'c2'),
  session('s-ext', '舱外对话', null),
]

function renderInCabin() {
  return render(
    <ChatSidebar
      tasks={tasks}
      tasksLoading={false}
      activeTaskId={null}
      onSelectTask={noop}
      sessions={sessions}
      sessionsLoading={false}
      activeSessionId={null}
      onSelectSession={noop}
      onCreateSession={noop}
      onCreateTask={noop}
      onRenameSession={noop}
      onDeleteSession={noop}
      searchOpen={false}
      onSearchOpenChange={noop}
      cabins={[cabin('c1', 'Aurora'), cabin('c2', 'Hermes')]}
      activeCabinId="c1"
      onSelectCabin={noop}
      onCreateCabin={noop}
    />,
  )
}

describe('ChatSidebar — 舱归属范围', () => {
  it('默认只看当前舱；其它舱与舱外活动都折起来，并给出口', () => {
    renderInCabin()
    expect(screen.getByTestId('chat-scope-switch')).toBeInTheDocument()
    expect(screen.getByText('本舱任务')).toBeInTheDocument()
    expect(screen.getByText('本舱对话')).toBeInTheDocument()
    expect(screen.queryByText('别舱任务')).not.toBeInTheDocument()
    expect(screen.queryByText('舱外任务')).not.toBeInTheDocument()
    expect(screen.queryByText('别舱对话')).not.toBeInTheDocument()
    expect(screen.queryByText('舱外对话')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-scope-outside')).toHaveTextContent(/另有\s*4\s*条舱外活动/)
  })

  it('「外部」→ 只剩 cabin_id = NULL 的活动', () => {
    renderInCabin()
    fireEvent.click(screen.getByRole('button', { name: '外部' }))
    expect(screen.queryByText('本舱任务')).not.toBeInTheDocument()
    expect(screen.queryByText('别舱任务')).not.toBeInTheDocument()
    expect(screen.getByText('舱外任务')).toBeInTheDocument()
    expect(screen.queryByText('本舱对话')).not.toBeInTheDocument()
    expect(screen.getByText('舱外对话')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-scope-outside')).not.toBeInTheDocument()
  })

  it('「全部」→ 都在；行上补舱 chip（外部用中性 chip）', () => {
    renderInCabin()
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(screen.getByText('别舱任务')).toBeInTheDocument()
    expect(screen.getByText('舱外任务')).toBeInTheDocument()
    expect(screen.getByText('别舱对话')).toBeInTheDocument()
    expect(screen.getByText('舱外对话')).toBeInTheDocument()
    const chips = document.querySelectorAll('[data-cabin-chip]')
    expect(chips.length).toBe(4) // 2 任务 + 2 会话（舱外行不挂牌）
    expect(document.querySelector('[data-cabin-chip="c2"]')).toHaveTextContent('Hermes')
    expect(document.querySelector('[data-cabin-chip="external"]')).toBeNull()
  })

  it('点「另有 N 条舱外活动」= 切到全部（不静默隐藏）', () => {
    renderInCabin()
    fireEvent.click(screen.getByTestId('chat-scope-outside'))
    expect(screen.getByText('别舱任务')).toBeInTheDocument()
    expect(screen.getByText('舱外对话')).toBeInTheDocument()
  })

  it('桌面（无当前舱）不出现范围开关，列表不筛', () => {
    render(
      <ChatSidebar
        tasks={tasks}
        tasksLoading={false}
        activeTaskId={null}
        onSelectTask={noop}
        sessions={sessions}
        sessionsLoading={false}
        activeSessionId={null}
        onSelectSession={noop}
        onCreateSession={noop}
        onCreateTask={noop}
        onRenameSession={noop}
        onDeleteSession={noop}
        searchOpen={false}
        onSearchOpenChange={noop}
      />,
    )
    expect(screen.queryByTestId('chat-scope-switch')).not.toBeInTheDocument()
    expect(screen.getByText('别舱任务')).toBeInTheDocument()
    expect(screen.getByText('舱外对话')).toBeInTheDocument()
    expect(document.querySelector('[data-cabin-chip]')).toBeNull()
  })
})
