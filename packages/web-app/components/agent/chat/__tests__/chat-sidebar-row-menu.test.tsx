// 侧栏行「⋯」菜单（2026-11-14 用户反馈）：
//   · 顺序固定为 重命名 / 复制名称 / 删除
//   · 复制名称把行名写进剪贴板
//   · 重命名进入行内编辑并把焦点交给输入框（曾经点完没反应）

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ChatSidebar } from '../chat-sidebar'
import type { AgentSession } from '@/lib/agent/types'
import type { TaskView } from '@/lib/tasks-api'

const task = {
  id: 't1',
  repo_group: 'xzf',
  name: '用户昵称敏感词过滤',
  status: 'draft',
  version: 1,
  source_chat_session_id: null,
} as unknown as TaskView

const session = {
  id: 's1',
  title: 'FDE调研',
  org: 'xzf',
  clone_name: null,
  session_type: 'main',
  created_at: '2026-11-14T00:00:00Z',
  updated_at: '2026-11-14T00:00:00Z',
  last_message_at: null,
  is_active: true,
} as AgentSession

const noop = () => {}

function renderSidebar(overrides: Partial<Parameters<typeof ChatSidebar>[0]> = {}) {
  return render(
    <ChatSidebar
      tasks={[task]}
      tasksLoading={false}
      activeTaskId={null}
      onSelectTask={noop}
      sessions={[session]}
      sessionsLoading={false}
      activeSessionId={null}
      onSelectSession={noop}
      onCreateSession={noop}
      onCreateTask={noop}
      onRenameSession={noop}
      onDeleteSession={noop}
      searchOpen={false}
      onSearchOpenChange={noop}
      {...overrides}
    />,
  )
}

beforeAll(() => {
  // Radix DropdownMenu 在 jsdom 里需要这些 DOM API。
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

describe('ChatSidebar — 行菜单', () => {
  it('菜单顺序：重命名 / 复制名称 / 删除', async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByRole('button', { name: '会话操作 FDE调研' }))
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((item) => item.textContent?.trim())).toEqual(['重命名', '复制名称', '删除'])
  })

  it('复制名称写入剪贴板', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    renderSidebar()
    await user.click(screen.getByRole('button', { name: '会话操作 FDE调研' }))
    await user.click(await screen.findByRole('menuitem', { name: /复制名称/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('FDE调研'))
  })

  it('重命名：进入行内编辑、输入框拿到焦点、提交回写标题', async () => {
    const user = userEvent.setup()
    const onRenameSession = vi.fn().mockResolvedValue(undefined)
    const { container } = renderSidebar({ onRenameSession })
    await user.click(screen.getByRole('button', { name: '会话操作 FDE调研' }))
    await user.click(await screen.findByRole('menuitem', { name: /^重命名$/ }))
    const input = container.querySelector('[data-session-id="s1"] input') as HTMLInputElement
    expect(input).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(input))
    fireEvent.change(input, { target: { value: '改名后的会话' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onRenameSession).toHaveBeenCalledWith('s1', '改名后的会话'))
  })

  it('任务行菜单同样提供三个动作', async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByRole('button', { name: '任务操作 用户昵称敏感词过滤' }))
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((item) => item.textContent?.trim())).toEqual(['重命名', '复制名称', '删除'])
  })
})
