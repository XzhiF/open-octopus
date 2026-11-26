// 桌面 / 经典舱文档窗（2026-11-26 用户）：
//   chat chip 的 open-doc 事件 → 按 sessionId 认领 → 会话级 doc 接口 → 只读正文。
//   Radix Dialog 在测试里换成普通 div（与 repo-edit-dialog 同一做法），只验数据流与渲染。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div data-testid="dialog">{children}</div>,
  DialogContent: ({ children, ...rest }: { children: ReactNode } & Record<string, unknown>) =>
    <div {...rest}>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}))

import { ChatDocWindow } from '../chat-doc-window'
import { openDoc } from '@/lib/open-doc'

const DOC = 'C:\\Users\\EDY\\.octopus\\workspaces\\cabin-1126-101034-c1b12f\\docs\\接口文档.md'
const PNG = 'C:\\Users\\EDY\\.octopus\\workspaces\\cabin-1126-101034-c1b12f\\shots\\qr.png'

function stubFetch(body: unknown, status = 200) {
  const fn = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ChatDocWindow', () => {
  it('同会话事件 → 拉会话级 doc 并渲染 md', async () => {
    const fetchMock = stubFetch({
      path: DOC, ext: '.md', size: 42, kind: 'text', content: '# 接口文档\n\n- 令牌桶限流',
    })
    render(<ChatDocWindow sessionId="s-1" />)

    act(() => openDoc(DOC, 's-1'))

    expect(await screen.findByTestId('chat-docwin')).toBeTruthy()
    expect(await screen.findByText('接口文档')).toBeTruthy()
    expect(screen.getByText('令牌桶限流')).toBeTruthy()
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/chat-media/s-1/doc?path=')
  })

  it('别的会话的事件不认领，也不发请求', () => {
    const fetchMock = stubFetch({})
    render(<ChatDocWindow sessionId="s-1" />)

    act(() => openDoc(DOC, 's-2'))

    expect(screen.queryByTestId('chat-docwin')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('媒体类走 raw 地址（图片预览）', async () => {
    stubFetch({ path: PNG, ext: '.png', size: 10, kind: 'image', mime: 'image/png' })
    render(<ChatDocWindow sessionId="s-1" />)

    act(() => openDoc(PNG, 's-1'))

    const img = await screen.findByTestId('chat-doc-image') as HTMLImageElement
    expect(img.getAttribute('src')).toContain('/api/chat-media/s-1/raw?path=')
  })

  it('服务端拒绝（白名单外）→ 显示错误文案', async () => {
    stubFetch({ error: "path outside this chat's media roots" }, 403)
    render(<ChatDocWindow sessionId="s-1" />)

    act(() => openDoc(DOC, 's-1'))

    expect(await screen.findByTestId('chat-doc-error')).toBeTruthy()
    expect(screen.getByText(/path outside this chat's media roots/)).toBeTruthy()
  })
})
