// 用户输入历史只收「我亲手打的字」：
//   · 任务事件卡（displayType='event'，含「[任务提问 · 待回答]」镜像卡）是
//     role='user'，但不是用户输入；
//   · 汐音代你转达的回执（proxyTurnOf）同样不是；
//   · 空正文不占一条短横。

import { describe, it, expect } from 'vitest'
import { userPromptTurns } from '../user-turns'
import type { AgentMessage } from '../types'

function msg(over: Partial<AgentMessage>): AgentMessage {
  return {
    id: 'm1',
    session_id: 's1',
    role: 'user',
    content: '帮我把渠道接进来',
    created_at: '2026-11-17T00:00:00.000Z',
    is_summary: false,
    is_compressed: false,
    is_edited: false,
    ...over,
  }
}

describe('userPromptTurns', () => {
  it('只留真人输入，事件卡/代述/空正文都排除', () => {
    const turns = userPromptTurns([
      msg({ id: 'u1', content: '帮我把渠道接进来' }),
      msg({
        id: 'ask1',
        displayType: 'event',
        content: '[任务提问 · 待回答] 支付回调 在问你\n用去重还是覆盖？',
      }),
      msg({ id: 'p1', content: '[汐音 · 代用户转达] 任务「支付回调」\n授权：explicit' }),
      msg({ id: 'p2', content: '[舱派发 · mandate=explicit] 任务「支付回调」' }),
      msg({ id: 'e1', content: '   ' }),
      msg({ id: 'a1', role: 'assistant', content: '收到' }),
      msg({ id: 'u2', content: '先跑测试' }),
    ])

    expect(turns).toEqual([
      { id: 'u1', text: '帮我把渠道接进来' },
      { id: 'u2', text: '先跑测试' },
    ])
  })

  it('人自己在主对话里做的决定（结构化 user 消息）仍算输入', () => {
    const turns = userPromptTurns([
      msg({ id: 'd1', content: '[决策] 选去重，别覆盖' }),
    ])
    expect(turns).toEqual([{ id: 'd1', text: '[决策] 选去重，别覆盖' }])
  })
})
