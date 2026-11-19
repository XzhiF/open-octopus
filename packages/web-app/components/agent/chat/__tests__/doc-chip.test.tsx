// 2026-11-19 用户 #4：正文里的产物绝对路径 → 可点文档 chip（点开座舱文档查看器）。
// 只在 docLinks 变体（cockpit）渲染；classic / 桌面转录不动。

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import type { AgentMessage } from '@/lib/agent/types'
import { TuiMessage } from '../TuiTranscript'

function assistant(content: string): AgentMessage {
  return {
    id: 'm-doc',
    session_id: 's-1',
    role: 'assistant',
    content,
    created_at: '2026-11-19T10:00:00.000Z',
    is_summary: false,
    is_compressed: false,
    is_edited: false,
  } as AgentMessage
}

const DOC = 'C:\\Users\\EDY\\.octopus\\workspaces\\cabin-1\\reports\\2026-11-19-验收报告.md'

describe('TuiMessage · 文档绝对路径 chip', () => {
  it('code 里的绝对路径：路径是纯文本，只有右侧 ↗ 按钮可点', () => {
    const seen: string[] = []
    const onOpen = (event: Event) => seen.push((event as CustomEvent<{ path: string }>).detail.path)
    window.addEventListener('octopus:open-doc', onOpen)
    render(<TuiMessage message={assistant(`报告已写入 \`${DOC}\`，点开看。`)} docLinks />)

    const open = screen.getByTestId('chat-doc-chip')
    const ref = open.closest('.doc-ref') as HTMLElement
    expect(ref.textContent).toBe(`📄${DOC}↗`)
    expect(ref.querySelector('.doc-ref-path')?.textContent).toBe(DOC)
    expect(ref.getAttribute('data-doc-path')).toBe(DOC)
    expect(open.textContent).toBe('↗')

    // 点路径纯文本不打开；只有 ↗ 按钮发事件。
    fireEvent.click(ref.querySelector('.doc-ref-path') as HTMLElement)
    expect(seen).toEqual([])

    fireEvent.click(open)
    expect(seen).toEqual([DOC])
    window.removeEventListener('octopus:open-doc', onOpen)
  })

  it('正文裸路径（无反引号）同样变路径 + 按钮', () => {
    render(<TuiMessage message={assistant(`产物：${DOC} 已完成。`)} docLinks />)
    const ref = screen.getByTestId('chat-doc-chip').closest('.doc-ref')
    expect(ref?.getAttribute('data-doc-path')).toBe(DOC)
  })

  it('非 docLinks 不渲染 chip（classic / 桌面逐字不变）', () => {
    render(<TuiMessage message={assistant(`报告已写入 \`${DOC}\``)} />)
    expect(screen.queryByTestId('chat-doc-chip')).toBeNull()
    expect(screen.getByText(/2026-11-19-验收报告\.md/)).toBeTruthy()
  })

  it('非文档扩展名不误判；/api/xxx.md 这类片段不误判', () => {
    render(
      <TuiMessage
        message={assistant('装好了 `C:\\tools\\app.exe`，接口见 `/api/schema.md`。另见 C:\\tmp\\a.log')}
        docLinks
      />,
    )
    const chips = screen.queryAllByTestId('chat-doc-chip')
    expect(chips).toHaveLength(1)
    expect(chips[0].closest('.doc-ref')?.getAttribute('data-doc-path')).toBe('C:\\tmp\\a.log')
  })
})
