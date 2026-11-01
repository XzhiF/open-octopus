// packages/web-app/components/agent/chat/__tests__/chat-bubble-error.test.tsx
//
// P0-3: the persisted turn error renders in both transcript skins.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ChatBubble } from '../ChatBubble'
import { TuiMessage } from '../TuiTranscript'
import type { AgentMessage } from '@/lib/agent/types'

function failedMessage(): AgentMessage {
  return {
    id: 'a-err',
    session_id: 's-1',
    role: 'assistant',
    content: '',
    created_at: new Date().toISOString(),
    is_summary: false,
    is_compressed: false,
    is_edited: false,
    error: { code: 'IDLE_TIMEOUT', message: '模型流已 300000ms 没有新事件', retryable: true },
  }
}

describe('persisted turn error rendering', () => {
  it('ChatBubble shows the failure title, message and code', () => {
    const view = render(<ChatBubble message={failedMessage()} />)
    expect(screen.getByText('本轮运行失败')).toBeTruthy()
    expect(screen.getByText('模型流已 300000ms 没有新事件')).toBeTruthy()
    expect(screen.getByText('IDLE_TIMEOUT')).toBeTruthy()
    expect(view.container.querySelector('[data-chat-error="IDLE_TIMEOUT"]')).toBeTruthy()
  })

  it('TuiMessage shows the failure line with its code', () => {
    const view = render(<TuiMessage message={failedMessage()} />)
    expect(view.container.querySelector('[data-tui-error="IDLE_TIMEOUT"]')).toBeTruthy()
    expect(view.container.textContent).toContain('本轮运行失败')
  })

  it('a successful message renders no error row', () => {
    const ok = { ...failedMessage(), error: undefined, content: 'hello' }
    const view = render(<ChatBubble message={ok} />)
    expect(view.container.querySelector('[data-chat-error]')).toBeNull()
    expect(screen.queryByText('本轮运行失败')).toBeNull()
  })
})
