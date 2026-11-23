// v20（design 29 §3.2）线程行模型锁：主对话恒首 / 有会话才进列表 / 状态表情语义 /
// attention → 线程 key / 未读可见性规则（v22 #5：主台固定主对话，无线程切换）。

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

describe('identity — 独立 chat 窗的对话对象（v22 #5）', () => {
  it('主对话=汐音；草稿=作者，活态=执行者，终态回主 Agent；委派=执行者', () => {
    const threads = threadsFromRows([
      jobRow('1', { status: 'ready' }),
      jobRow('2', { status: 'draft' }),
      jobRow('3', { status: 'done', ended_at: '2026-11-17T01:00:00Z' }),
      delegationRow('7'),
    ], 'main-s')
    const identity = new Map(threads.map((t) => [t.key, t.identity] as const))
    expect(identity.get(MAIN_THREAD_KEY)).toBe('汐音')
    expect(identity.get('job:1')).toBe('执行者 · task-doer')
    expect(identity.get('job:2')).toBe('作者 · task-author')
    expect(identity.get('job:3')).toBe('主 Agent')
    expect(identity.get('delegation:7')).toBe('执行者 · task-doer')
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

describe('isThreadVisible — v22 #5 主通讯台固定主对话', () => {
  it('只有主线程算台内可见；作战线程只靠非最小化弹出窗', () => {
    const base = {
      chatWindow: { open: true, mini: false, docked: false },
      windows: [] as { threadKey: string; min: boolean }[],
    }
    expect(isThreadVisible(MAIN_THREAD_KEY, base)).toBe(true)
    expect(isThreadVisible(MAIN_THREAD_KEY, { ...base, chatWindow: { ...base.chatWindow, mini: true } })).toBe(false)
    expect(isThreadVisible(MAIN_THREAD_KEY, { ...base, chatWindow: { ...base.chatWindow, docked: true } })).toBe(false)
    // 主台不再「看」作战线程 —— 没有任何当前线程切换态。
    expect(isThreadVisible('job:1', base)).toBe(false)
    expect(isThreadVisible('job:1', { ...base, windows: [{ threadKey: 'job:1', min: false }] })).toBe(true)
    expect(isThreadVisible('job:1', { ...base, windows: [{ threadKey: 'job:1', min: true }] })).toBe(false)
  })
})
