import type { ToolCallRecord } from './types'

/** 任务清单行 —— 对应 SDK 的 TaskCreate / TaskUpdate（或旧版 TodoWrite）。 */
export type TaskProgressStatus = 'pending' | 'in_progress' | 'completed'

export interface TaskProgressItem {
  /** 内部稳定 key（TaskCreate 用 tool_use id，TodoWrite 用序号）。 */
  id: string
  subject: string
  /** 进行中时展示的动词短语（SDK 的 activeForm）。 */
  activeForm?: string
  status: TaskProgressStatus
}

export interface TaskProgress {
  items: TaskProgressItem[]
  total: number
  done: number
  /** 当前 in_progress 项（没有则 null）。 */
  active: TaskProgressItem | null
  allDone: boolean
}

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 工具结果在 SSE/持久化里是字符串；也兼容直接给对象。 */
function parseJsonish(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function normalizeStatus(value: unknown): TaskProgressStatus | null {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
    ? value
    : null
}

/** 文档提醒 TaskUpdate 的 key 可能被模型写成 id / task_id，一律防御性读取。 */
function readTaskId(input: Record<string, unknown>): string | null {
  for (const key of ['taskId', 'id', 'task_id'] as const) {
    const value = input[key]
    if (typeof value === 'string' && value) return value
    if (typeof value === 'number') return String(value)
  }
  return null
}

function readString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

/** TaskCreate 的 PostToolUse 结果：{ task: { id, subject, description } }。 */
function readCreatedTaskId(result: unknown): string | null {
  const parsed = asRecord(parseJsonish(result))
  const task = asRecord(parsed?.task)
  const id = task?.id
  if (typeof id === 'string' && id) return id
  if (typeof id === 'number') return String(id)
  return null
}

/** TodoWrite 每次重发完整数组：{ todos: [{ content, status, activeForm }] }。 */
function parseTodos(input: unknown): TaskProgressItem[] | null {
  const todos = asRecord(input)?.todos
  if (!Array.isArray(todos)) return null
  const items: TaskProgressItem[] = []
  for (const raw of todos) {
    const todo = asRecord(raw)
    if (!todo) continue
    const subject = readString(todo, 'content', 'subject')
    if (!subject) continue
    items.push({
      id: `todo-${items.length}`,
      subject,
      activeForm: readString(todo, 'activeForm', 'active_form'),
      status: normalizeStatus(todo.status) ?? 'pending',
    })
  }
  return items
}

/**
 * 从 tool_calls 时序还原「任务清单」。
 *
 * - TodoWrite：全量数组，后一次覆盖前一次；
 * - TaskCreate：追加，task id 从 tool result 的 `task.id` 解析；
 * - TaskUpdate：按 taskId 改状态，`deleted` 移除。
 *
 * 同一个 tool_call id 只处理一次（live 流与持久化消息可能重叠）。
 * 没有任何任务工具时返回 null —— 调用方据此不渲染面板。
 */
export function deriveTaskProgress(toolCalls: readonly ToolCallRecord[]): TaskProgress | null {
  let items: TaskProgressItem[] = []
  let hasTaskData = false
  const seen = new Set<string>()
  /** resolved task id → 内部稳定 key */
  const taskIdToItemKey = new Map<string, string>()
  /** TaskCreate 的创建顺序，TaskUpdate 带序号但 create 结果尚未到时兜底（服务端 id 从 1 递增）。 */
  const createdKeys: string[] = []

  for (const tc of toolCalls) {
    if (!tc || !TASK_TOOLS.has(tc.name)) continue
    if (tc.id && seen.has(tc.id)) continue
    if (tc.id) seen.add(tc.id)

    const input = asRecord(tc.input)

    if (tc.name === 'TodoWrite') {
      const todos = parseTodos(tc.input)
      if (todos) {
        items = todos
        hasTaskData = true
        taskIdToItemKey.clear()
        createdKeys.length = 0
      }
      continue
    }

    if (tc.name === 'TaskCreate') {
      if (!input || tc.status === 'fail') continue
      const subject = readString(input, 'subject')
      if (!subject) continue
      const resolvedId = readCreatedTaskId(tc.result)
      if (resolvedId) taskIdToItemKey.set(resolvedId, tc.id)
      createdKeys.push(tc.id)
      items = [...items, {
        id: tc.id,
        subject,
        activeForm: readString(input, 'activeForm', 'active_form'),
        status: 'pending',
      }]
      hasTaskData = true
      continue
    }

    // TaskUpdate
    if (!input) continue
    const taskId = readTaskId(input)
    if (!taskId) continue

    let key = taskIdToItemKey.get(taskId)
    // 兜底：TaskCreate 的结果还没到，但 id 是服务端递增序号（"1" 起步）。
    if (!key && /^\d+$/.test(taskId)) key = createdKeys[Number(taskId) - 1]
    if (!key && items.some((item) => item.id === taskId)) key = taskId
    if (!key) continue

    if (input.status === 'deleted') {
      items = items.filter((item) => item.id !== key)
      const pos = createdKeys.indexOf(key)
      if (pos >= 0) createdKeys.splice(pos, 1)
    } else {
      const status = normalizeStatus(input.status)
      const subject = readString(input, 'subject')
      const activeForm = readString(input, 'activeForm', 'active_form')
      items = items.map((item) =>
        item.id === key
          ? {
              ...item,
              status: status ?? item.status,
              subject: subject ?? item.subject,
              activeForm: activeForm ?? item.activeForm,
            }
          : item,
      )
    }
    hasTaskData = true
  }

  if (!hasTaskData || items.length === 0) return null

  const done = items.filter((item) => item.status === 'completed').length
  return {
    items,
    total: items.length,
    done,
    active: items.find((item) => item.status === 'in_progress') ?? null,
    allDone: done === items.length,
  }
}
