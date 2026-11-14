// S2：跨舱编队模型纯函数测试 —— 分组 / 排序 / attention 合并 / 三型行 /
// counts / duration / meta。全部手工 fixture，不打服务、不 mock 业务数据。

import { describe, expect, it } from 'vitest'
import type { CabinAttentionItem } from '@octopus/shared'
import type { CabinJobView } from '@/lib/cabin-api'
import type { CabinTaskRow } from '@/components/cabin/modules/ui'
import {
  buildCounts,
  durationLabel,
  groupOf,
  mergeAttention,
  metaLine,
  sortRows,
  statusLabel,
  type CockpitRow,
} from '../fleet-model'

function job(id: string, over: Partial<CabinJobView> = {}): CabinJobView {
  return {
    id,
    cabin_id: 'c1',
    kind: 'task',
    ref_id: 't1',
    session_id: null,
    iteration_id: null,
    title: `作业${id}`,
    mandate: null,
    prompt: null,
    priority: 0,
    created_at: '2026-11-14T00:00:00.000Z',
    ended_at: null,
    status: 'running',
    transport: 'task-thread',
    iteration_code: null,
    ...over,
  }
}

function jobRow(
  id: string,
  over: Partial<CabinJobView> = {},
  cabin: { cabinId: string; cabinName: string } = { cabinId: 'c1', cabinName: 'A舱' },
  pct: number | null = null,
): CockpitRow {
  return { key: `job:${id}`, kind: 'job', ...cabin, job: job(id, over), pct }
}

function taskRow(
  id: string,
  status = 'running',
  over: Record<string, unknown> = {},
): CockpitRow {
  const task = {
    id,
    name: `任务${id}`,
    status,
    repo_group: 'pay',
    created_at: '2026-11-14T00:00:00.000Z',
    updated_at: '2026-11-14T00:10:00.000Z',
    ...over,
  } as unknown as CabinTaskRow
  return { key: `task:${id}`, kind: 'task', cabinId: 'c1', cabinName: 'A舱', task, pct: 50 }
}

function attention(id: string, over: Partial<CabinAttentionItem> = {}): CabinAttentionItem {
  return {
    id,
    job_id: null,
    stage: 'answer',
    awaiting: 'person',
    title: `待办${id}`,
    task_id: null,
    repo: null,
    wt: null,
    deep_link: null,
    priority: 0,
    ...over,
  }
}

function attnRow(id: string, over: Partial<CabinAttentionItem> = {}): CockpitRow {
  return { key: `attn:${id}`, kind: 'attention', cabinId: 'c1', cabinName: 'A舱', item: attention(id, over) }
}

describe('groupOf', () => {
  it('job 状态：running→run；pending/ready→queue；ended→done；awaiting→need', () => {
    expect(groupOf(jobRow('j1', { status: 'running' }))).toBe('run')
    expect(groupOf(jobRow('j2', { status: 'pending' }))).toBe('queue')
    expect(groupOf(jobRow('j3', { status: 'ready' }))).toBe('queue')
    expect(groupOf(jobRow('j4', { status: 'paused' }))).toBe('queue')
    expect(groupOf(jobRow('j5', { status: 'done', ended_at: '2026-11-14T01:00:00.000Z' }))).toBe('done')
    expect(groupOf(jobRow('j6', { status: 'cancelled' }))).toBe('done')
    expect(groupOf(jobRow('j7', { status: 'awaiting_review' }))).toBe('need')
    expect(groupOf(jobRow('j8', { status: 'failed' }))).toBe('need')
  })

  it('job 缺 status：有 ended_at 归 done，否则归 queue（不冒充运行中）', () => {
    expect(groupOf(jobRow('j1', { status: undefined, ended_at: '2026-11-14T01:00:00.000Z' }))).toBe('done')
    expect(groupOf(jobRow('j2', { status: undefined, ended_at: null }))).toBe('queue')
  })

  it('job 挂上 attention：即使 running 也归 need', () => {
    const row = jobRow('j1', { status: 'running' })
    const [merged] = mergeAttention([row], [attention('a1', { job_id: 'j1', priority: 3 })], {
      cabinId: 'c1',
      cabinName: 'A舱',
    })
    expect(groupOf(merged)).toBe('need')
  })

  it('attention 行：person / blocked→need；working→run；idle/ended→done', () => {
    expect(groupOf(attnRow('a1'))).toBe('need')
    expect(groupOf(attnRow('a2', { awaiting: 'working', stage: 'blocked' }))).toBe('need')
    expect(groupOf(attnRow('a3', { awaiting: 'working', stage: 'review' }))).toBe('run')
    expect(groupOf(attnRow('a4', { awaiting: 'idle' }))).toBe('done')
    expect(groupOf(attnRow('a5', { awaiting: 'ended' }))).toBe('done')
  })

  it('task 行：running→run；awaiting_review→need；paused→queue；done→done', () => {
    expect(groupOf(taskRow('t1', 'running'))).toBe('run')
    expect(groupOf(taskRow('t2', 'awaiting_review'))).toBe('need')
    expect(groupOf(taskRow('t3', 'awaiting_archive'))).toBe('need')
    expect(groupOf(taskRow('t4', 'paused'))).toBe('queue')
    expect(groupOf(taskRow('t5', 'done'))).toBe('done')
  })
})

describe('mergeAttention', () => {
  const cabin = { cabinId: 'c1', cabinName: 'A舱' }

  it('job_id 命中 → 挂到 job 行；同一 job 多条只留 priority 最高，不额外成行', () => {
    const rows = [jobRow('j1', { status: 'running' })]
    const merged = mergeAttention(
      rows,
      [
        attention('a-low', { job_id: 'j1', priority: 1 }),
        attention('a-high', { job_id: 'j1', priority: 9 }),
      ],
      cabin,
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].kind).toBe('job')
    if (merged[0].kind === 'job') expect(merged[0].attention?.id).toBe('a-high')
  })

  it('job_id 不存在 / job_id=null → 各自保留为 attn: 行', () => {
    const rows = [jobRow('j1')]
    const merged = mergeAttention(
      rows,
      [
        attention('orphan', { job_id: 'missing' }),
        attention('finding-1', { job_id: null, stage: 'adjudicate' }),
        attention('hit', { job_id: 'j1' }),
      ],
      cabin,
    )
    const keys = merged.map((row) => row.key)
    expect(keys).toContain('job:j1')
    expect(keys).toContain('attn:orphan')
    expect(keys).toContain('attn:finding-1')
    expect(keys).not.toContain('attn:hit')
    expect(merged).toHaveLength(3)
  })

  it('全空舱也能显式传入 cabin，未命中 attention 不丢', () => {
    const merged = mergeAttention([], [attention('finding-1')], cabin)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ kind: 'attention', cabinId: 'c1', cabinName: 'A舱' })
  })

  it('纯函数：入参数组与行对象不被修改', () => {
    const original = jobRow('j1')
    const rows = [original]
    const merged = mergeAttention(rows, [attention('a1', { job_id: 'j1' })], cabin)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toBe(original)
    expect((original as Extract<CockpitRow, { kind: 'job' }>).attention).toBeUndefined()
    expect(merged).not.toBe(rows)
  })
})

describe('sortRows', () => {
  it('组序 need → run → queue → done；need 里 job 行在纯 attention 行之前', () => {
    const rows = [
      jobRow('done', { status: 'done', ended_at: '2026-11-14T01:00:00.000Z' }),
      attnRow('a1', { priority: 99 }),
      jobRow('queue', { status: 'pending', created_at: '2026-11-14T00:00:00.000Z' }),
      jobRow('run', { status: 'running' }),
      jobRow('need-job', { status: 'awaiting_review' }),
    ]
    const sorted = sortRows(rows)
    expect(sorted.map((row) => row.key)).toEqual([
      'job:need-job',
      'attn:a1',
      'job:run',
      'job:queue',
      'job:done',
    ])
  })

  it('need 组内按 attention.priority 降序', () => {
    const rows = [
      jobRow('low', { status: 'awaiting_review' }),
      jobRow('high', { status: 'awaiting_review' }),
    ]
    const withAttention = mergeAttention(
      rows,
      [
        attention('a-low', { job_id: 'low', priority: 1 }),
        attention('a-high', { job_id: 'high', priority: 8 }),
      ],
      { cabinId: 'c1', cabinName: 'A舱' },
    )
    expect(sortRows(withAttention).map((row) => row.key)).toEqual(['job:high', 'job:low'])
  })

  it('run 按 priority 降序；queue FIFO；done 最近结束在前且只留 3 条', () => {
    const rows = [
      jobRow('r-low', { status: 'running', priority: 1 }),
      jobRow('r-high', { status: 'running', priority: 5 }),
      jobRow('q2', { status: 'pending', created_at: '2026-11-14T00:02:00.000Z' }),
      jobRow('q1', { status: 'pending', created_at: '2026-11-14T00:01:00.000Z' }),
      jobRow('d1', { status: 'done', ended_at: '2026-11-14T01:00:00.000Z' }),
      jobRow('d2', { status: 'done', ended_at: '2026-11-14T02:00:00.000Z' }),
      jobRow('d3', { status: 'done', ended_at: '2026-11-14T03:00:00.000Z' }),
      jobRow('d4', { status: 'done', ended_at: '2026-11-14T04:00:00.000Z' }),
    ]
    expect(sortRows(rows).map((row) => row.key)).toEqual([
      'job:r-high',
      'job:r-low',
      'job:q1',
      'job:q2',
      'job:d4',
      'job:d3',
      'job:d2',
    ])
  })

  it('纯函数：不改入参顺序', () => {
    const rows = [jobRow('b', { status: 'running', priority: 0 }), jobRow('a', { status: 'running', priority: 9 })]
    const before = rows.map((row) => row.key)
    sortRows(rows)
    expect(rows.map((row) => row.key)).toEqual(before)
  })
})

describe('buildCounts', () => {
  it('三型行 + 跨舱：need/run/queue/done/perCabin/jobs/sessions', () => {
    const rows: CockpitRow[] = [
      jobRow('j1', { status: 'running' }, { cabinId: 'c1', cabinName: 'A舱' }),
      jobRow('j2', { status: 'awaiting_review' }, { cabinId: 'c1', cabinName: 'A舱' }),
      jobRow('j3', { status: 'pending' }, { cabinId: 'c2', cabinName: 'B舱' }),
      jobRow('j4', { status: 'done' }, { cabinId: 'c2', cabinName: 'B舱' }),
      taskRow('t1', 'running'),
      attnRow('a1', { priority: 2 }),
    ]
    expect(buildCounts(rows, 4)).toEqual({
      need: 2, // j2 + attn
      run: 2, // j1 + t1 task
      queue: 1,
      done: 1,
      perCabin: { c1: 4, c2: 2 },
      jobs: 5, // 纯 attention 行不算作业
      sessions: 4,
    })
  })

  it('空编队：全 0，sessions 原样透传（null 不冒充 0）', () => {
    expect(buildCounts([], null)).toEqual({
      need: 0,
      run: 0,
      queue: 0,
      done: 0,
      perCabin: {},
      jobs: 0,
      sessions: null,
    })
  })
})

describe('三型行 + duration / meta', () => {
  it('job 行：时长 created_at → ended_at；meta = 舱名 · iteration · transport', () => {
    const row = jobRow('j1', {
      status: 'done',
      created_at: '2026-11-14T00:00:00.000Z',
      ended_at: '2026-11-14T00:01:30.000Z',
      transport: 'task-thread',
      iteration_code: 'I1',
    })
    expect(row.kind).toBe('job')
    expect(durationLabel(row, Date.parse('2026-11-14T05:00:00.000Z'))).toBe('1m')
    expect(metaLine(row)).toBe('A舱 · I1 · task-thread')
    expect(statusLabel(row)).toBe('已完成')
  })

  it('job 行：活态时长用 now，不读缺失的 ended_at', () => {
    const row = jobRow('j1', {
      status: 'running',
      created_at: '2026-11-14T00:00:00.000Z',
      ended_at: null,
    })
    expect(durationLabel(row, Date.parse('2026-11-14T02:05:00.000Z'))).toBe('2h05m')
    expect(statusLabel(row)).toBe('运行中')
  })

  it('task 行：pct 用 taskPct 结果；meta = 舱名 · repo_group', () => {
    const row = taskRow('t1', 'awaiting_review')
    expect(row.kind).toBe('task')
    expect(row.kind === 'task' ? row.pct : null).toBe(50)
    expect(metaLine(row)).toBe('A舱 · pay')
    expect(statusLabel(row)).toBe('待验收')
  })

  it('attention 行：没有时长；meta 只拼真实 repo', () => {
    const row = attnRow('a1', { repo: 'octopus' })
    expect(durationLabel(row, Date.now())).toBeNull()
    expect(metaLine(row)).toBe('A舱 · octopus')
    expect(statusLabel(row)).toBe('待回答')
  })

  it('duration：缺 created_at / 非法时间 → null（省略，不写占位）', () => {
    expect(durationLabel(jobRow('j1', { created_at: '' }), Date.now())).toBeNull()
    expect(durationLabel(jobRow('j2', { created_at: 'not-a-date' }), Date.now())).toBeNull()
    expect(durationLabel(taskRow('t1', 'running', { created_at: '' }), Date.now())).toBeNull()
  })

  it('duration：超过 24h 用 d/h；task 已结束用 updated_at', () => {
    const job = jobRow('j1', {
      status: 'done',
      created_at: '2026-11-13T00:00:00.000Z',
      ended_at: '2026-11-14T02:00:00.000Z',
    })
    expect(durationLabel(job, 0)).toBe('1d2h')
    const task = taskRow('t1', 'done', {
      created_at: '2026-11-14T00:00:00.000Z',
      updated_at: '2026-11-14T01:00:00.000Z',
    })
    expect(durationLabel(task, Date.parse('2026-11-14T09:00:00.000Z'))).toBe('1h00m')
  })
})
