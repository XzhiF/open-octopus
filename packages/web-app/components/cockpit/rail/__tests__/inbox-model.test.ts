// v21（design 31 §3.1/§3.2）纯模型：编队排序 + inbox 分组。

import { describe, it, expect } from 'vitest'
import type { CabinAttentionItem } from '@octopus/shared'
import type { CabinJobView } from '@/lib/cabin-api'
import { sortFleet, type CockpitRow } from '../../fleet/fleet-model'
import {
  canAnswerInline,
  collectInbox,
  groupedInbox,
  inboxCounts,
  inboxGroupOf,
} from '../inbox-model'

function job(id: string, over: Partial<CabinJobView> = {}, pct: number | null = null): Extract<CockpitRow, { kind: 'job' }> {
  return {
    key: `job:${id}`,
    kind: 'job',
    cabinId: 'c1',
    cabinName: '舱一',
    job: {
      id,
      cabin_id: 'c1',
      kind: 'task',
      ref_id: null,
      session_id: null,
      title: `作业 ${id}`,
      mandate: null,
      prompt: null,
      created_at: '2026-11-14T09:00:00.000Z',
      ended_at: null,
      status: 'running',
      transport: 'task-thread',
      ...over,
    },
    pct,
  }
}

function attn(id: string, over: Partial<CabinAttentionItem> = {}): CabinAttentionItem {
  return {
    id,
    job_id: null,
    stage: 'review',
    awaiting: 'person',
    title: `事项 ${id}`,
    task_id: null,
    repo: null,
    wt: null,
    deep_link: null,
    ...over,
  }
}

function attnRow(id: string, over: Partial<CabinAttentionItem> = {}): CockpitRow {
  return { key: `attn:${id}`, kind: 'attention', cabinId: 'c1', cabinName: '舱一', item: attn(id, over) }
}

describe('sortFleet（v21 左栏排序）', () => {
  it('状态 rank 优先，同状态按创建时间升序；attention-only 剔除', () => {
    const rows = [
      attnRow('a1'),
      job('done', { status: 'done', created_at: '2026-11-14T08:00:00.000Z' }),
      job('queue', { status: 'pending', created_at: '2026-11-14T09:00:00.000Z' }),
      job('run-new', { status: 'running', created_at: '2026-11-14T11:00:00.000Z' }),
      job('run-old', { status: 'running', created_at: '2026-11-14T10:00:00.000Z' }),
      job('wait', { status: 'awaiting_review', created_at: '2026-11-14T12:00:00.000Z' }),
      job('blocked', { status: 'blocked', created_at: '2026-11-14T13:00:00.000Z' }),
    ]
    expect(sortFleet(rows).map((row) => row.key)).toEqual([
      'job:blocked',
      'job:wait',
      'job:run-old',
      'job:run-new',
      'job:queue',
      'job:done',
    ])
  })
})

describe('inbox-model', () => {
  it('分组：受阻 / 待验收 / 待你定；机器在跑的不收', () => {
    expect(inboxGroupOf(attn('a', { stage: 'blocked' }))).toBe('blk')
    expect(inboxGroupOf(attn('b', { stage: 'review' }))).toBe('rev')
    expect(inboxGroupOf(attn('c', { stage: 'answer' }))).toBe('ask')
    expect(inboxGroupOf(attn('d', { stage: 'adjudicate' }))).toBe('ask')

    const rows: CockpitRow[] = [
      job('j1', { status: 'awaiting_review' }, 100),
      attnRow('a1', { stage: 'answer' }),
      attnRow('a2', { stage: 'blocked' }),
      attnRow('a3', { stage: 'review', awaiting: 'working' }),
    ]
    // job 行上挂 attention 的情况由 fleet 合并；这里单独测纯 attention 行。
    const entries = collectInbox(rows)
    expect(entries.map((entry) => entry.item.id)).toEqual(['a1', 'a2'])
    expect(inboxCounts(entries)).toEqual({ total: 2, ask: 1, rev: 0, blk: 1 })
    expect(groupedInbox(entries).map((group) => group.group)).toEqual(['ask', 'blk'])
  })

  it('job 行上的 attention 优先取 job 面作为「去处理」目标', () => {
    const row = { ...job('j1'), attention: attn('a1', { job_id: 'j1', stage: 'answer' }) } as Extract<CockpitRow, { kind: 'job' }>
    const [entry] = collectInbox([row])
    expect(entry.item.id).toBe('a1')
    expect(entry.ref).toEqual({ kind: 'job', cabinId: 'c1', id: 'j1' })
  })

  it('同一条 attention 只出现一次', () => {
    const item = attn('a1')
    expect(collectInbox([attnRow('a1'), attnRow('a1', { stage: 'answer' })]).length).toBe(1)
    expect(item.id).toBe('a1')
  })

  it('有决策信封且有选项才可就地作答', () => {
    expect(canAnswerInline(attn('a1', {
      stage: 'answer',
      ask: { ask_id: 'a1', message_id: 'm1', author_session_id: 's1', decision: '选哪个', options: [{ label: 'A' }] },
    }))).toBe(true)
    expect(canAnswerInline(attn('a2', { stage: 'review' }))).toBe(false)
  })
})
