// 对话日志数据模型：prompt 切轮 / TUI 摘要计数 / 统计条 / 关键词过滤。
import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@/lib/agent/types'
import type { TurnStats } from '@/lib/turn-stats'
import { buildLogTurns, filterLogTurns, logTotals } from '../log-model'

function stats(over: Partial<TurnStats> = {}): TurnStats {
  return {
    durationMs: 30_000,
    calls: 1,
    tokens: 1200,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheHitRate: null,
    costUsd: 0.02,
    costComplete: true,
    models: ['pro'],
    ...over,
  }
}

function msg(over: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'role'>): AgentMessage {
  return {
    session_id: 'sess-main',
    content: '',
    created_at: '2026-11-21T09:31:00',
    is_summary: false,
    is_compressed: false,
    is_edited: false,
    ...over,
  }
}

describe('buildLogTurns', () => {
  it('一条 prompt = 一个节点；只收真人 prompt（事件卡 / 代转达 / 角色切换不算）', () => {
    const turns = buildLogTurns([
      msg({ id: 'u1', role: 'user', content: 'M1 退款链路修一下' }),
      msg({ id: 'a1', role: 'assistant', content: '收到' }),
      msg({ id: 'ev', role: 'user', content: '[任务提问] 待回答', displayType: 'event' }),
      msg({ id: 'proxy', role: 'user', content: '[汐音 · 代用户转达] 任务「支付回调」' }),
      msg({ id: 'rs', role: 'user', content: '切换身份', roleSwitch: { kind: 'reset', id: null, displayName: null, revision: 1, card: '' } }),
      msg({ id: 'u2', role: 'user', content: '限流先压测' }),
    ])
    expect(turns.map((turn) => turn.id)).toEqual(['u1', 'u2'])
    expect(turns[0].status).toBe('done')
    expect(turns[1].status).toBe('pending')
  })

  it('过程计数照 TuiMeta：timeline 的 thinking / 命中 tool / text 各算一步', () => {
    const [turn] = buildLogTurns([
      msg({ id: 'u1', role: 'user', content: '定位对账差异' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '在跑',
        timeline: [
          { kind: 'thinking', text: '先看失败断言' },
          { kind: 'tool', id: 't1' },
          { kind: 'tool', id: 't-missing' },
          { kind: 'text', text: '结论' },
        ],
        tool_calls: [
          { id: 't1', name: 'Bash', input: {}, status: 'success' },
        ],
      }),
    ])
    expect(turn.steps).toBe(3)
    expect(turn.tools).toBe(1)
    expect(turn.thinks).toBe(1)
  })

  it('同一轮多条 assistant：token / 费用 / 步数相加；任一中断 = 已中断', () => {
    const [turn] = buildLogTurns([
      msg({ id: 'u1', role: 'user', content: '跑完整回归' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '第一段',
        thinking: '想一下',
        turnStats: stats(),
      }),
      msg({
        id: 'a2',
        role: 'assistant',
        content: '被截断',
        interrupted: true,
        tool_calls: [{ id: 't1', name: 'Bash', input: {}, status: 'fail' }],
        turnStats: stats({ tokens: 800, costUsd: null, costComplete: false, durationMs: 10_000 }),
      }),
    ])
    expect(turn.status).toBe('interrupted')
    expect(turn.steps).toBe(2)
    expect(turn.tools).toBe(1)
    expect(turn.thinks).toBe(1)
    expect(turn.tokens).toBe(2000)
    expect(turn.durationMs).toBe(40_000)
    expect(turn.costUsd).toBe(0.02)
    expect(turn.costComplete).toBe(false)
    expect(turn.hasStats).toBe(true)
  })

  it('代转达 / 角色切换也切轮：它后面的 assistant 不并入我的 prompt', () => {
    const turns = buildLogTurns([
      msg({ id: 'u1', role: 'user', content: '帮我派一个任务' }),
      msg({ id: 'a1', role: 'assistant', content: '已派', thinking: '派发' }),
      msg({ id: 'proxy', role: 'user', content: '[汐音 · 代用户转达] 任务「支付回调」' }),
      msg({ id: 'a2', role: 'assistant', content: '收到，开始', thinking: '执行' }),
      msg({ id: 'u2', role: 'user', content: '现在到哪一步了？' }),
    ])
    expect(turns.map((turn) => turn.id)).toEqual(['u1', 'u2'])
    expect(turns[0].steps).toBe(1)
    expect(turns[1].status).toBe('pending')
  })

  it('assistant 还在流式落库：状态为进行中', () => {
    const [turn] = buildLogTurns([
      msg({ id: 'u1', role: 'user', content: '在吗' }),
      msg({ id: 'a1', role: 'assistant', content: '在', streaming: true }),
    ])
    expect(turn.status).toBe('pending')
  })

  it('没有账本行：hasStats=false，不编耗时 / token', () => {
    const [turn] = buildLogTurns([
      msg({ id: 'u1', role: 'user', content: '在吗' }),
      msg({ id: 'a1', role: 'assistant', content: '在', thinking: '嗯' }),
    ])
    expect(turn.hasStats).toBe(false)
    expect(turn.durationMs).toBe(0)
    expect(turn.tokens).toBe(0)
    expect(turn.steps).toBe(1)
  })
})

describe('logTotals', () => {
  it('总 token / 最长单轮 / 总费用（任一轮未配价 → ≈）', () => {
    const turns = buildLogTurns([
      msg({ id: 'u1', role: 'user', content: '一' }),
      msg({ id: 'a1', role: 'assistant', content: 'x', thinking: 'x', turnStats: stats({ tokens: 1000, durationMs: 20_000, costUsd: 0.05 }) }),
      msg({ id: 'u2', role: 'user', content: '二' }),
      msg({ id: 'a2', role: 'assistant', content: 'y', thinking: 'y', turnStats: stats({ tokens: 500, durationMs: 90_000, costUsd: null, costComplete: false }) }),
    ])
    expect(logTotals(turns)).toEqual({
      count: 2,
      tokens: 1500,
      longestMs: 90_000,
      costUsd: 0.05,
      costComplete: false,
    })
  })

  it('空列表不焊假 0 费用', () => {
    expect(logTotals([])).toEqual({ count: 0, tokens: 0, longestMs: 0, costUsd: null, costComplete: true })
  })
})

describe('filterLogTurns', () => {
  it('大小写不敏感，只搜 prompt 原文；空查询返回全量', () => {
    const turns = buildLogTurns([
      msg({ id: 'u1', role: 'user', content: 'Fix Reconcile.test.ts' }),
      msg({ id: 'u2', role: 'user', content: '跑限流压测' }),
    ])
    expect(filterLogTurns(turns, 'RECONCILE').map((turn) => turn.id)).toEqual(['u1'])
    expect(filterLogTurns(turns, '  ').map((turn) => turn.id)).toEqual(['u1', 'u2'])
    expect(filterLogTurns(turns, '不存在')).toEqual([])
  })
})
