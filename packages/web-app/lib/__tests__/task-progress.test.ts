import { describe, it, expect } from 'vitest'
import { deriveTaskProgress } from '../agent/task-progress'
import type { ToolCallRecord } from '@/lib/agent/types'

function tc(
  id: string,
  name: string,
  input: unknown,
  opts: { result?: unknown; status?: string } = {},
): ToolCallRecord {
  return { id, name, input, status: opts.status ?? 'result', result: opts.result }
}

const created = (id: string, subject: string) =>
  JSON.stringify({ task: { id, subject, description: subject } })

describe('deriveTaskProgress', () => {
  it('TaskCreate + TaskUpdate：算出总数/完成数/当前项', () => {
    const progress = deriveTaskProgress([
      tc('c1', 'TaskCreate', { subject: 'Inspect pages', activeForm: 'Inspecting pages' }, { result: created('1', 'Inspect pages') }),
      tc('c2', 'TaskCreate', { subject: 'Build pricing', activeForm: 'Building pricing' }, { result: created('2', 'Build pricing') }),
      tc('c3', 'TaskCreate', { subject: 'Verify', activeForm: 'Verifying' }, { result: created('3', 'Verify') }),
      tc('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      tc('u2', 'TaskUpdate', { taskId: '2', status: 'in_progress' }),
    ])

    expect(progress).not.toBeNull()
    expect(progress!.total).toBe(3)
    expect(progress!.done).toBe(1)
    expect(progress!.allDone).toBe(false)
    expect(progress!.active?.subject).toBe('Build pricing')
    // 行渲染用 activeForm，完成/待办用 subject
    expect(progress!.active?.activeForm).toBe('Building pricing')
    expect(progress!.items.map((i) => i.status)).toEqual(['completed', 'in_progress', 'pending'])
  })

  it('TaskUpdate 的 taskId 缺省/别名（id、task_id）也能命中', () => {
    const base = [
      tc('c1', 'TaskCreate', { subject: 'A' }, { result: created('1', 'A') }),
      tc('c2', 'TaskCreate', { subject: 'B' }, { result: created('2', 'B') }),
    ]
    expect(deriveTaskProgress([...base, tc('u', 'TaskUpdate', { id: '1', status: 'completed' })])!.done).toBe(1)
    expect(deriveTaskProgress([...base, tc('u', 'TaskUpdate', { task_id: '2', status: 'completed' })])!.done).toBe(1)
  })

  it('create 结果还没到：按创建顺序兜底匹配数字 taskId', () => {
    const progress = deriveTaskProgress([
      tc('c1', 'TaskCreate', { subject: 'A' }, { status: 'start' }),
      tc('c2', 'TaskCreate', { subject: 'B' }, { status: 'start' }),
      tc('u1', 'TaskUpdate', { taskId: '2', status: 'completed' }),
    ])
    expect(progress!.items.map((i) => i.status)).toEqual(['pending', 'completed'])
    expect(progress!.done).toBe(1)
  })

  it('deleted 状态移除任务', () => {
    const progress = deriveTaskProgress([
      tc('c1', 'TaskCreate', { subject: 'A' }, { result: created('1', 'A') }),
      tc('c2', 'TaskCreate', { subject: 'B' }, { result: created('2', 'B') }),
      tc('u1', 'TaskUpdate', { taskId: '1', status: 'deleted' }),
    ])
    expect(progress!.items.map((i) => i.subject)).toEqual(['B'])
    expect(progress!.total).toBe(1)
  })

  it('TodoWrite：后一次全量覆盖前一次，content 映射为 subject', () => {
    const progress = deriveTaskProgress([
      tc('t1', 'TodoWrite', {
        todos: [
          { content: 'A', status: 'in_progress', activeForm: 'Doing A' },
          { content: 'B', status: 'pending' },
        ],
      }),
      tc('t2', 'TodoWrite', {
        todos: [
          { content: 'A', status: 'completed', activeForm: 'Doing A' },
          { content: 'B', status: 'in_progress', activeForm: 'Doing B' },
          { content: 'C', status: 'pending' },
        ],
      }),
    ])
    expect(progress!.total).toBe(3)
    expect(progress!.done).toBe(1)
    expect(progress!.active?.activeForm).toBe('Doing B')
  })

  it('全部完成 → allDone', () => {
    const progress = deriveTaskProgress([
      tc('c1', 'TaskCreate', { subject: 'A' }, { result: created('1', 'A') }),
      tc('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
    ])
    expect(progress!.allDone).toBe(true)
    expect(progress!.done).toBe(1)
  })

  it('同一 tool_call id 重复出现只处理一次（live + 持久化重叠）', () => {
    const create = tc('c1', 'TaskCreate', { subject: 'A' }, { result: created('1', 'A') })
    const progress = deriveTaskProgress([create, create])
    expect(progress!.total).toBe(1)
  })

  it('失败的 TaskCreate 不入列', () => {
    expect(deriveTaskProgress([
      tc('c1', 'TaskCreate', { subject: 'A' }, { status: 'fail' }),
    ])).toBeNull()
  })

  it('没有任务工具 / TodoWrite 清空列表 → null（不渲染面板）', () => {
    expect(deriveTaskProgress([])).toBeNull()
    expect(deriveTaskProgress([tc('r', 'Read', { file_path: '/a' })])).toBeNull()
    expect(deriveTaskProgress([tc('t', 'TodoWrite', { todos: [] })])).toBeNull()
  })

  it('混合任务工具之外的工具不影响结果', () => {
    const progress = deriveTaskProgress([
      tc('r', 'Read', { file_path: '/a' }),
      tc('c1', 'TaskCreate', { subject: 'A' }, { result: created('1', 'A') }),
      tc('b', 'Bash', { command: 'ls' }),
      tc('u1', 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
    ])
    expect(progress!.active?.subject).toBe('A')
  })
})
