// 事项投递来源（2026-11-24）：user message metadata {via:'items', items:[...]}
// 解析成 AgentMessage.via / .items —— 转录来源签与回执卡据此渲染。

import { describe, expect, it } from 'vitest'
import { parseMessageMetadata } from '../api'

function row(metadata: string) {
  return {
    id: 'm1',
    session_id: 's1',
    role: 'user',
    content: '处理这几条事项：',
    created_at: '2026-11-24T03:00:00.000Z',
    is_summary: 0,
    is_compressed: 0,
    is_edited: 0,
    metadata,
  }
}

describe('parseMessageMetadata — 事项投递来源', () => {
  it('via=items + items 列表透传到顶层', () => {
    const parsed = parseMessageMetadata(row(JSON.stringify({ via: 'items', items: ['ci-1', 'ci-2'] })))
    expect(parsed.via).toBe('items')
    expect(parsed.items).toEqual(['ci-1', 'ci-2'])
  })

  it('普通消息不带 via / items', () => {
    const parsed = parseMessageMetadata(row(JSON.stringify({ displayType: 'text' })))
    expect(parsed.via).toBeUndefined()
    expect(parsed.items).toBeUndefined()
  })
})
