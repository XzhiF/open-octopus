// v20（design 29 §3.2）线程行模型锁：主对话恒首 / 有会话才进 tab / 状态表情语义 /
// attention → 线程 key / 关闭只隐藏 / 未读可见性规则。

import { describe, expect, it } from 'vitest'
import type { CabinAttentionItem } from '@octopus/shared'
import type { CockpitRow } from '../fleet-model'
import {
  isThreadVisible,
  MAIN_THREAD_KEY,
  THREAD_EMO,
  threadKeyOfAttention,
  threadKeyOfSession,
  threadsFromRows,
  threadStateOf,
  visibleThreads,
} from '../threads-model'

const cabin = { cabinId: 'c1', cabinName: '测试舱' }

function jobRow(id: string, over: Partial<Extract<CockpitRow, { kind: 'job' }>['job']> = {}): CockpitRow {
  return {
    key: `job:${id}`,
    kind: 'job',
    ...cabin,
    job: {
      id,
      cabin_id: 'c1',
      kind: 'task',
      ref_id: `t-${id}`,
      session_id: `s-${id}`,
      title: `作业 ${id}`,
      mandate: null,
      prompt: null,
      created_at: '2026-11-17T00:00:00Z',
      ended_at: null,
      status: 'running',
      transport: 'task',
      ...over,
    },
    pct: null,
  }
}

function delegationRow(id: string, state: 'running' | 'waiting_input' | 'done' = 'running'): CockpitRow {
  return {
    key: `delegation:${id}`,
    kind: 'delegation',
    ...cabin,
    delegation: {
      id,
      cabin_id: 'c1',
      title: `委派 ${id}`,
      intent_text: '',
      brief: null,
      autonomy: 'approve',
      state,
      doer_session_id: `d-${id}`,
      result_summary: null,
      created_at: '2026-11-17T00:00:00Z',
      updated_at: '2026-11-17T00:00:00Z',
      ended_at: null,
      handle: `D${id}`,
      color: null,
    },
    pct: null,
  }
}

function attention(over: Partial<CabinAttentionItem> = {}): CabinAttentionItem {
  return {
    id: 'a1',
    job_id: null,
    stage: 'answer',
    awaiting: 'person',
    title: '等你答',
    task_id: null,
    repo: null,
    wt: null,
    deep_link: null,
    ...over,
  }
}

describe('threadsFromRows', () => {
  it('主对话恒在首位；没有会话的行不进 tab', () => {
    const rows = [jobRow('1'), jobRow('2', { session_id: null })]
    const threads = threadsFromRows(rows, 'main-s')
    expect(threads[0].key).toBe(MAIN_THREAD_KEY)
    expect(threads[0].sessionId).toBe('main-s')
    expect(threads.map((t) => t.key)).toEqual([MAIN_THREAD_KEY, 'job:1'])
  })

  it('同一会话去重（job 与 delegation 共用 doer 会话时只留一条）', () => {
    const rows = [jobRow('1'), delegationRow('1')]
    const threads = threadsFromRows(rows, 'main-s')
    expect(threads.filter((t) => t.sessionId === 's-1')).toHaveLength(1)
  })

  it('need 组里 blocked/failed 是 💦，其余等人是 ❗；run ⚡ / queue 💤 / done ✅', () => {
    expect(threadStateOf(jobRow('1', { status: 'blocked' }))).toBe('blocked')
    expect(threadStateOf(jobRow('1', { status: 'awaiting_review' }))).toBe('wait')
    expect(threadStateOf(jobRow('1', { status: 'running' }))).toBe('run')
    expect(threadStateOf(jobRow('1', { status: 'queued' }))).toBe('queue')
    expect(threadStateOf(jobRow('1', { status: 'done', ended_at: '2026-11-17T01:00:00Z' }))).toBe('done')
    expect(threadStateOf(delegationRow('9', 'waiting_input'))).toBe('wait')
    expect(THREAD_EMO[threadStateOf(jobRow('1', { status: 'blocked' }))]).toBe('💦')
  })
})

describe('threadKeyOfAttention / threadKeyOfSession', () => {
  it('subject 优先，再 job_id / task_id 命中编队行', () => {
    const rows = [jobRow('1'), delegationRow('7')]
    expect(threadKeyOfAttention(rows, attention({ subject: { kind: 'delegation', id: '7' } }))).toBe('delegation:7')
    expect(threadKeyOfAttention(rows, attention({ job_id: '1' }))).toBe('job:1')
    expect(threadKeyOfAttention(rows, attention({ task_id: 't-1' }))).toBe('job:1')
    expect(threadKeyOfAttention(rows, attention())).toBeNull()
  })

  it('会话反查线程 key', () => {
    const threads = threadsFromRows([jobRow('1')], 'main-s')
    expect(threadKeyOfSession(threads, 's-1')).toBe('job:1')
    expect(threadKeyOfSession(threads, 'main-s')).toBe(MAIN_THREAD_KEY)
    expect(threadKeyOfSession(threads, null)).toBeNull()
  })
})

describe('visibleThreads / isThreadVisible', () => {
  it('关闭只隐藏：主对话不可关，closed 里的作战线程不出现在 tab 条', () => {
    const threads = threadsFromRows([jobRow('1'), jobRow('2')], 'main-s')
    const visible = visibleThreads(threads, ['job:1'])
    expect(visible.map((t) => t.key)).toEqual([MAIN_THREAD_KEY, 'job:2'])
  })

  it('主通讯台正在看 / 非最小化弹出窗开着 → 可见；否则不可见', () => {
    const base = {
      activeThread: 'job:1',
      chatWindow: { open: true, mini: false, docked: false },
      windows: [] as { threadKey: string; min: boolean }[],
    }
    expect(isThreadVisible('job:1', base)).toBe(true)
    expect(isThreadVisible('job:1', { ...base, chatWindow: { ...base.chatWindow, mini: true } })).toBe(false)
    expect(isThreadVisible('job:1', { ...base, chatWindow: { ...base.chatWindow, docked: true } })).toBe(false)
    expect(isThreadVisible('job:2', { ...base, windows: [{ threadKey: 'job:2', min: false }] })).toBe(true)
    expect(isThreadVisible('job:2', { ...base, windows: [{ threadKey: 'job:2', min: true }] })).toBe(false)
  })
})
