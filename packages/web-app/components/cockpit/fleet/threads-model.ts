// v20（design 29 §3.2）：多作战线程 tab 的行模型 —— 纯派生，不改入参。
//
// 线程 = 舱主对话 + 编队里「有会话可聊」的作战行（job / task / delegation）。
// 没有会话的行不进 tab（聊不了就不冒充线程）；状态表情复用编队分组语义，
// 不另造一套状态机。key 与编队行 key 同命名空间 —— 回传 flash / 未读 / 弹出窗
// 都拿它当唯一锚点。

import type { CockpitRef } from '../state/cockpit-state'
import { groupOf, sortRows, type CockpitRow } from './fleet-model'

export type CockpitThreadState = 'run' | 'wait' | 'blocked' | 'queue' | 'done'

export const THREAD_EMO: Record<CockpitThreadState, string> = {
  run: '⚡',
  wait: '❗',
  blocked: '💦',
  queue: '💤',
  done: '✅',
}

export const THREAD_STATE_LABEL: Record<CockpitThreadState, string> = {
  run: '作战中',
  wait: '等你答',
  blocked: '受阻',
  queue: '待命',
  // 完结 ≠ 归档（2026-11-25 用户）：线程跑完只代表结束，归档是人工闸。
  done: '已完成',
}

export interface CockpitThread {
  /** 'main' 或编队行 key（job: / task: / delegation:）。 */
  key: string
  kind: 'main' | 'job' | 'task' | 'delegation'
  sessionId: string | null
  taskId: string | null
  title: string
  /** tab / chip 上的短名（CSS 再 ellipsis 兜底）。 */
  short: string
  state: CockpitThreadState
  /** 独立 chat 窗里「跟谁说话」的身份标签（v22 #5 用户：身份要对应）——
   *  与 ChatPane 的任务身份派生同口径，只读、不可切。 */
  identity: string
  /** ▦ 详情目标；2026-11-25 起会话（delegation）也有详情面（六页签）。 */
  ref: CockpitRef | null
}

export const MAIN_THREAD_KEY = 'main'

/** 与 ChatPane identityDisplay 同口径：草稿期=作者，终态回主 Agent，其余=执行者。 */
const ENDED_TASK_STATUSES = new Set(['done', 'aborted', 'failed'])

function identityOfStatus(status: string | null | undefined): string {
  if (status === 'draft') return '作者 · task-author'
  if (status && ENDED_TASK_STATUSES.has(status)) return '主 Agent'
  return '执行者 · task-doer'
}

function shortOf(title: string): string {
  return title.length > 12 ? `${title.slice(0, 12)}…` : title
}

/** need 组里再分「受阻 / 等你答」：blocked / failed 是 💦，其余等人是 ❗。 */
export function threadStateOf(row: CockpitRow): CockpitThreadState {
  const group = groupOf(row)
  if (group === 'need') {
    if (row.kind === 'attention') return row.item.stage === 'blocked' ? 'blocked' : 'wait'
    if (row.kind === 'delegation') return row.delegation.state === 'failed' ? 'blocked' : 'wait'
    if (row.kind === 'job') {
      return row.job.status === 'blocked' || row.job.status === 'failed' ? 'blocked' : 'wait'
    }
    return 'wait'
  }
  if (group === 'run') return 'run'
  if (group === 'done') return 'done'
  return 'queue'
}

function threadOfRow(row: CockpitRow): CockpitThread | null {
  if (row.kind === 'job') {
    if (!row.job.session_id) return null
    return {
      key: row.key,
      kind: 'job',
      sessionId: row.job.session_id,
      taskId: row.job.kind === 'task' ? row.job.ref_id : null,
      title: row.job.title,
      short: shortOf(row.job.title),
      state: threadStateOf(row),
      identity: identityOfStatus(row.job.status),
      ref: { kind: 'job', cabinId: row.cabinId, id: row.job.id },
    }
  }
  if (row.kind === 'task') {
    const sessionId = row.task.doer_session_id ?? null
    if (!sessionId) return null
    return {
      key: row.key,
      kind: 'task',
      sessionId,
      taskId: row.task.id,
      title: row.task.name,
      short: shortOf(row.task.name),
      state: threadStateOf(row),
      identity: identityOfStatus(row.task.status),
      ref: { kind: 'task', cabinId: row.cabinId, id: row.task.id },
    }
  }
  if (row.kind === 'delegation') {
    if (!row.delegation.doer_session_id) return null
    return {
      key: row.key,
      kind: 'delegation',
      sessionId: row.delegation.doer_session_id,
      taskId: null,
      title: row.delegation.title,
      short: shortOf(row.delegation.handle ?? row.delegation.title),
      state: threadStateOf(row),
      identity: '执行者 · task-doer',
      ref: { kind: 'delegation', cabinId: row.cabinId, id: row.delegation.id },
    }
  }
  return null
}

/** 主对话恒在首位；作战线程按编队排序（need → run → queue → done），同会话去重。 */
export function threadsFromRows(
  rows: readonly CockpitRow[],
  mainSessionId: string | null,
): CockpitThread[] {
  const main: CockpitThread = {
    key: MAIN_THREAD_KEY,
    kind: 'main',
    sessionId: mainSessionId,
    taskId: null,
    title: '汐音 · 主对话',
    short: '主对话',
    state: 'queue',
    identity: '汐音',
    ref: null,
  }
  const seen = new Set<string>()
  if (mainSessionId) seen.add(mainSessionId)
  const rest: CockpitThread[] = []
  for (const row of sortRows(rows)) {
    const thread = threadOfRow(row)
    if (!thread || !thread.sessionId || seen.has(thread.sessionId)) continue
    seen.add(thread.sessionId)
    rest.push(thread)
  }
  return [main, ...rest]
}

/** attention → 线程 key：subject（design 25）优先，再 job_id / task_id 命中编队行。 */
export function threadKeyOfAttention(
  rows: readonly CockpitRow[],
  item: { job_id: string | null; task_id: string | null; subject?: { kind: 'task' | 'delegation'; id: string } },
): string | null {
  if (item.subject) {
    const key = `${item.subject.kind}:${item.subject.id}`
    if (rows.some((row) => row.key === key)) return key
  }
  if (item.job_id) {
    const hit = rows.find((row) => row.kind === 'job' && row.job.id === item.job_id)
    if (hit) return hit.key
  }
  if (item.task_id) {
    const hit = rows.find((row) => (
      (row.kind === 'task' && row.task.id === item.task_id)
      || (row.kind === 'job' && row.job.kind === 'task' && row.job.ref_id === item.task_id)
    ))
    if (hit) return hit.key
  }
  return null
}

export function threadKeyOfSession(
  threads: readonly CockpitThread[],
  sessionId: string | null,
): string | null {
  if (!sessionId) return null
  return threads.find((thread) => thread.sessionId === sessionId)?.key ?? null
}

/** v20 未读可见性规则（design 29 §3.3）：主通讯台永远钉在主对话上，所以只有主
 *  线程算「台内可见」；其余线程靠非最小化弹出窗开着才算可见，否则 unread++ / ping。
 *  v22 #5：主通讯台固定主对话 —— 这里不再有任何「当前线程」切换态。 */
export function isThreadVisible(
  key: string,
  view: {
    chatWindow: { open: boolean; mini: boolean; docked: boolean }
    windows: readonly { threadKey: string; min: boolean }[]
  },
): boolean {
  if (key === MAIN_THREAD_KEY && view.chatWindow.open && !view.chatWindow.mini && !view.chatWindow.docked) {
    return true
  }
  return view.windows.some((w) => w.threadKey === key && !w.min)
}
