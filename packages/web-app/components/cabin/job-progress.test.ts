// S2：taskPct 快照 —— 与 CabinFleet.tsx 搬出前的行为逐项一致。
// 三种分支：无 phases（按任务状态 100/50/0）、全 accepted（100）、有 rounds（按轮次比例）。
// 数据只用最小 fixture 构造，只读函数行为，不打服务。

import { describe, expect, it } from 'vitest'
import { pctFromPhases, taskPct } from './job-progress'
import type { CabinTaskRow } from './modules/ui'
import type { TaskPhaseView } from '@/lib/tasks-api'

function task(over: Record<string, unknown> = {}): CabinTaskRow {
  return {
    id: 't1',
    name: '任务',
    status: 'running',
    repo_group: null,
    task_spec: { goal: '', ac: [] },
    authoring_resources: [],
    resources: [],
    skills: [],
    project_ids: [],
    version: 1,
    deleted_at: null,
    trigger_mode: 'manual',
    trigger_at: null,
    cron_expression: null,
    cron_timezone: 'Asia/Shanghai',
    trigger_enabled: true,
    next_fire_at: null,
    last_fired_at: null,
    created_at: '2026-11-14T00:00:00.000Z',
    updated_at: '2026-11-14T00:10:00.000Z',
    ...over,
  } as unknown as CabinTaskRow
}

function phase(status: string, rounds = 0, currentRound: number | null = null) {
  return {
    index: 1,
    name: 'p',
    slug: 'p',
    workflowRef: 'w',
    status,
    rounds: Array.from({ length: rounds }, (_, i) => ({ roundIndex: i + 1 })),
    currentRound,
    acceptedRound: status === 'accepted' ? currentRound : null,
    awaitingRound: null,
  }
}

describe('pctFromPhases', () => {
  it('没有 phase 视图 → null（调用方省略，不写 0/--）', () => {
    expect(pctFromPhases([])).toBeNull()
  })

  it('与 taskPct 同一套规则：accepted 数 + 当前 phase 轮次比例', () => {
    const phases = [phase('accepted', 2, 2), phase('running', 4, 3)] as unknown as TaskPhaseView[]
    expect(pctFromPhases(phases)).toBe(75)
    expect(pctFromPhases([phase('accepted', 1, 1)] as unknown as TaskPhaseView[])).toBe(100)
  })
})

describe('taskPct', () => {
  it('无 phases：按任务显示状态给 100 / 50 / 0；task 缺失为 0', () => {
    expect(taskPct(undefined)).toBe(0)
    expect(taskPct(task({ status: 'running' }))).toBe(50)
    expect(taskPct(task({ status: 'done' }))).toBe(100)
    expect(taskPct(task({ status: 'paused' }))).toBe(0)
    expect(taskPct(task({ status: 'awaiting_review' }))).toBe(0)
  })

  it('全 accepted：100（即使任务还没走到 done）', () => {
    const t = task({
      status: 'running',
      derived: { taskStatus: 'running', isV4: true, phaseViews: [phase('accepted', 2, 2), phase('accepted', 1, 1)] },
    })
    expect(taskPct(t)).toBe(100)
  })

  it('有 rounds：accepted 数 + 当前 phase 轮次比例', () => {
    // 1/2 accepted + 当前 phase 4 轮里完成 2 轮（currentRound=3）→ (1 + 0.5) / 2 = 75
    const mid = task({
      derived: {
        taskStatus: 'running',
        isV4: true,
        phaseViews: [phase('accepted', 2, 2), phase('running', 4, 3)],
      },
    })
    expect(taskPct(mid)).toBe(75)

    // 当前 phase 只跑了 1 轮（currentRound=1，doneRounds=0）→ 1/2 = 50
    const fresh = task({
      derived: {
        taskStatus: 'running',
        isV4: true,
        phaseViews: [phase('accepted', 2, 2), phase('running', 4, 1)],
      },
    })
    expect(taskPct(fresh)).toBe(50)

    // currentRound 超出总轮数：比例夹到 1 → 100
    const capped = task({
      derived: {
        taskStatus: 'running',
        isV4: true,
        phaseViews: [phase('accepted', 2, 2), phase('running', 4, 5)],
      },
    })
    expect(taskPct(capped)).toBe(100)

    // 当前 phase 还没开跑（rounds=0, currentRound=null）→ 不猜，按 0 轮算
    const notStarted = task({
      derived: {
        taskStatus: 'ready',
        isV4: true,
        phaseViews: [phase('accepted', 2, 2), phase('pending', 0, null)],
      },
    })
    expect(taskPct(notStarted)).toBe(50)
  })

  it('快照：三组分支的输出固定', () => {
    const cases = [
      taskPct(task({ status: 'running' })),
      taskPct(task({
        status: 'running',
        derived: { taskStatus: 'running', isV4: true, phaseViews: [phase('accepted', 1, 1), phase('accepted', 1, 1)] },
      })),
      taskPct(task({
        derived: {
          taskStatus: 'running',
          isV4: true,
          phaseViews: [phase('accepted', 2, 2), phase('running', 4, 3)],
        },
      })),
    ]
    expect(cases).toMatchInlineSnapshot(`
      [
        50,
        100,
        75,
      ]
    `)
  })
})
