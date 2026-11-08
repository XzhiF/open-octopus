import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TaskProgressPanel } from '../task-progress-panel'
import { ChatArea } from '../ChatArea'
import type { TaskProgress, TaskProgressItem } from '@/lib/agent/task-progress'
import type { AgentMessage, ToolCallRecord } from '@/lib/agent/types'

const progressItems: TaskProgressItem[] = [
  { id: '1', subject: 'Inspect pages', activeForm: 'Inspecting pages', status: 'completed' },
  { id: '2', subject: 'Build pricing', activeForm: 'Building pricing', status: 'in_progress' },
  { id: '3', subject: 'Verify links', activeForm: 'Verifying links', status: 'pending' },
]
const progress: TaskProgress = {
  items: progressItems,
  total: 3,
  done: 1,
  active: progressItems[1],
  allDone: false,
}

const baseProps = {
  messages: [] as AgentMessage[],
  streaming: false,
  streamContent: '',
  streamThinking: '',
  isThinking: false,
  toolCalls: [] as ToolCallRecord[],
  pendingConfirm: null,
  error: null,
  statusMessage: '',
  onSend: vi.fn(),
  onStop: vi.fn(),
  onConfirm: vi.fn(),
  hasSession: true,
  currentModel: 'pro',
  onModelChange: vi.fn(),
  tui: true,
}

function taskCalls(): ToolCallRecord[] {
  const result = (id: string, subject: string) => JSON.stringify({ task: { id, subject } })
  return [
    { id: 'c1', name: 'TaskCreate', input: { subject: 'Inspect pages', activeForm: 'Inspecting pages' }, status: 'result', result: result('1', 'Inspect pages') },
    { id: 'c2', name: 'TaskCreate', input: { subject: 'Build pricing', activeForm: 'Building pricing' }, status: 'result', result: result('2', 'Build pricing') },
    { id: 'c3', name: 'TaskCreate', input: { subject: 'Verify links', activeForm: 'Verifying links' }, status: 'result', result: result('3', 'Verify links') },
    { id: 'u1', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' }, status: 'result' },
    { id: 'u2', name: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' }, status: 'result' },
  ]
}

function messageWithTasks(): AgentMessage {
  return {
    id: 'm1',
    session_id: 's1',
    role: 'assistant',
    content: '正在处理',
    tool_calls: taskCalls(),
    created_at: new Date().toISOString(),
    is_summary: false,
    is_compressed: false,
    is_edited: false,
  }
}

describe('TaskProgressPanel', () => {
  it('渲染总数/完成数、activeForm 与三类状态', () => {
    const { container } = render(<TaskProgressPanel progress={progress} />)
    expect(container.querySelector('[data-task-progress]')).toBeTruthy()
    expect(container.querySelector('[data-task-progress-count]')!.textContent).toBe('1/3')
    const items = [...container.querySelectorAll('[data-task-item]')] as HTMLElement[]
    expect(items.map((el) => el.getAttribute('data-task-status'))).toEqual(['completed', 'in_progress', 'pending'])
    // 进行中行显示 activeForm，完成/待办显示 subject
    expect(items[1].textContent).toContain('Building pricing')
    expect(items[0].textContent).toContain('Inspect pages')
    expect(container.textContent).toContain('当前：Building pricing')
  })

  it('可收起：只保留标题行与当前步骤', () => {
    const { container } = render(<TaskProgressPanel progress={progress} />)
    const toggle = container.querySelector('[data-task-progress-toggle]') as HTMLElement
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-task-progress-body]')).toBeNull()
    expect(container.textContent).toContain('进行中 · Building pricing')
  })

  it('全部完成时切绿并显示全部完成徽章', () => {
    const done: TaskProgress = {
      items: progress.items.map((item) => ({ ...item, status: 'completed' })),
      total: 3,
      done: 3,
      active: null,
      allDone: true,
    }
    const { container } = render(<TaskProgressPanel progress={done} />)
    expect(container.querySelector('[data-task-progress]')!.getAttribute('data-task-done')).toBe('true')
    expect(container.querySelector('[data-task-progress-count]')!.textContent).toBe('全部完成 3/3')
    expect(container.textContent).toContain('✓ 全部完成')
  })
})

describe('ChatArea 置顶任务清单', () => {
  it('历史消息里有任务工具 → composer 上方出现面板，且在输入框之前', () => {
    const { container } = render(<ChatArea {...baseProps} messages={[messageWithTasks()]} />)
    const panel = container.querySelector('[data-task-progress]') as HTMLElement | null
    const composer = container.querySelector('[data-composer-block]') as HTMLElement | null
    expect(panel).toBeTruthy()
    expect(composer).toBeTruthy()
    // DOCUMENT_POSITION_FOLLOWING：composer 在 panel 之后 = 面板在 composer 上方
    expect(panel!.compareDocumentPosition(composer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(panel!.textContent).toContain('1/3')
    expect(panel!.textContent).toContain('Building pricing')
  })

  it('当前流式的 toolCalls 也会实时驱动面板', () => {
    const { container } = render(
      <ChatArea {...baseProps} streaming streamContent="正在做" toolCalls={taskCalls()} />,
    )
    expect(container.querySelector('[data-task-progress]')!.textContent).toContain('1/3')
  })

  it('没有任务工具 → 不渲染面板', () => {
    const { container } = render(
      <ChatArea
        {...baseProps}
        messages={[{
          ...messageWithTasks(),
          tool_calls: [{ id: 'r1', name: 'Read', input: { file_path: '/a' }, status: 'result' }],
        }]}
      />,
    )
    expect(container.querySelector('[data-task-progress]')).toBeNull()
  })

  it('TodoWrite 全量数组同样生效', () => {
    const { container } = render(
      <ChatArea
        {...baseProps}
        messages={[{
          ...messageWithTasks(),
          tool_calls: [{
            id: 't1',
            name: 'TodoWrite',
            input: { todos: [
              { content: 'A', status: 'completed', activeForm: 'Doing A' },
              { content: 'B', status: 'in_progress', activeForm: 'Doing B' },
            ] },
            status: 'result',
          }],
        }]}
      />,
    )
    const panel = container.querySelector('[data-task-progress]')!
    expect(panel.textContent).toContain('1/2')
    expect(panel.textContent).toContain('Doing B')
  })

  it('非 TUI composer 同样挂在输入框上方', () => {
    const { container } = render(<ChatArea {...baseProps} tui={false} messages={[messageWithTasks()]} />)
    const panel = container.querySelector('[data-task-progress]') as HTMLElement | null
    const composer = container.querySelector('[data-composer-block]') as HTMLElement | null
    expect(panel).toBeTruthy()
    expect(composer).toBeTruthy()
    expect(panel!.compareDocumentPosition(composer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
