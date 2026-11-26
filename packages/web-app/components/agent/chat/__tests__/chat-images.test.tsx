// 对话图片缩略图（2026-11-26 用户 · 无工具版）：
//   正文里的图片绝对路径 → 消息下面出缩略图；点击开灯箱；设置开关关掉后不出图。
//   只认绝对路径（相对路径不猜），单条最多 4 张，加载失败静默收起。

import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import type { ReactNode } from 'react'
import {
  ChatImages, ChatMediaProvider, extractImagePaths, chatImageUrl,
} from '../chat-images'
import { TuiMessage } from '../TuiTranscript'
import type { AgentMessage } from '@/lib/agent/types'

const WIN = 'C:\\Users\\EDY\\.octopus\\chat-media\\s-1\\qr-login.png'
const POSIX = '/home/edy/shots/e2e-checkout.png'

function assistant(content: string): AgentMessage {
  return {
    id: 'm-img',
    session_id: 's-1',
    role: 'assistant',
    content,
    created_at: '2026-11-26T10:00:00.000Z',
    is_summary: false,
    is_compressed: false,
    is_edited: false,
  } as AgentMessage
}

function withScope(node: ReactNode) {
  return render(<ChatMediaProvider value={{ sessionId: 's-1' }}>{node}</ChatMediaProvider>)
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('extractImagePaths', () => {
  it('反引号 / markdown / 裸路径都能认出来，且去重', () => {
    const text = [
      `二维码：\`${WIN}\``,
      `截图：![checkout](${POSIX})`,
      `裸路径 ${POSIX} 和重复的 ${WIN}`,
    ].join('\n')
    expect(extractImagePaths(text).sort()).toEqual([WIN, POSIX].sort())
  })

  it('相对路径、非图片、URL 片段不误判', () => {
    const text = '看 ./shots/a.png 和 /api/schema.png，还有 `C:\\tools\\app.exe` 与 https://x.test/a.png'
    expect(extractImagePaths(text)).toEqual([])
  })

  it('单条最多 4 张', () => {
    const text = Array.from({ length: 6 }, (_, i) => `![](C:\\shots\\shot-${i}.png)`).join('\n')
    expect(extractImagePaths(text)).toHaveLength(4)
  })
})

describe('ChatImages', () => {
  it('默认开启：渲染缩略图，src 指向会话图片接口', () => {
    withScope(<ChatImages text={`登录二维码：\`${WIN}\``} />)
    const thumb = screen.getByTestId('chat-image-thumb')
    const img = thumb.querySelector('img') as HTMLImageElement
    expect(thumb.getAttribute('data-image-path')).toBe(WIN)
    expect(img.getAttribute('src')).toBe(chatImageUrl('s-1', WIN))
    expect(img.getAttribute('src')).toContain('/api/chat-media/s-1/image?path=')
  })

  it('设置关掉后不出图', () => {
    window.localStorage.setItem('octopus.ui.chatImageThumbs.v1', 'false')
    withScope(<ChatImages text={`登录二维码：\`${WIN}\``} />)
    expect(screen.queryByTestId('chat-images')).toBeNull()
  })

  it('没有会话上下文时不出图', () => {
    render(<ChatImages text={`登录二维码：\`${WIN}\``} />)
    expect(screen.queryByTestId('chat-images')).toBeNull()
  })

  it('点击缩略图开灯箱，Esc 关闭', () => {
    withScope(<ChatImages text={`登录二维码：\`${WIN}\``} />)
    fireEvent.click(screen.getByTestId('chat-image-thumb'))
    expect(screen.getByTestId('chat-image-lightbox')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('chat-image-lightbox')).toBeNull()
  })

  it('图片加载失败 → 这条缩略图收起', () => {
    withScope(<ChatImages text={`登录二维码：\`${WIN}\``} />)
    const img = screen.getByTestId('chat-image-thumb').querySelector('img') as HTMLImageElement
    fireEvent.error(img)
    expect(screen.queryByTestId('chat-images')).toBeNull()
  })

  it('接线：会话上下文里的 TuiMessage 自动带缩略图', () => {
    withScope(<TuiMessage message={assistant(`登录二维码：\`${WIN}\``)} />)
    expect(screen.getByTestId('chat-image-thumb').getAttribute('data-image-path')).toBe(WIN)
  })
})
