// packages/web-app/lib/agent/__tests__/message-error-metadata.test.ts
//
// P0-3: a failed turn persists `metadata.error`; the transcript reader must
// surface it so the failure survives a reload.

import { describe, it, expect } from 'vitest'
import { parseMessageMetadata } from '../api'

function row(metadata: string) {
  return {
    id: 'a-1',
    session_id: 's-1',
    role: 'assistant',
    content: '',
    created_at: new Date().toISOString(),
    metadata,
  }
}

describe('parseMessageMetadata — persisted turn error', () => {
  it('reads metadata.error into the message', () => {
    const parsed = parseMessageMetadata(row(JSON.stringify({
      error: { code: 'IDLE_TIMEOUT', message: '模型流已 300000ms 没有新事件', retryable: true },
    })))

    expect(parsed.error).toEqual({
      code: 'IDLE_TIMEOUT',
      message: '模型流已 300000ms 没有新事件',
      retryable: true,
    })
  })

  it('leaves error undefined on a normal row', () => {
    const parsed = parseMessageMetadata(row(JSON.stringify({ displayType: 'text' })))
    expect(parsed.error).toBeUndefined()
  })

  it('survives malformed metadata instead of throwing', () => {
    const parsed = parseMessageMetadata(row('{not json'))
    expect(parsed.error).toBeUndefined()
  })
})
