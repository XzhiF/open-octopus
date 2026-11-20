// 2026-11-19 用户 #4：座舱文档查看器 —— 聊天里的绝对路径点开 → 只读窗。
// 格式：md 渲染 / json 美化 / 文本 mono / 图片 / 视频 / 音频预览 / 二进制提示不可查阅。

import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'

const h = vi.hoisted(() => ({
  doc: vi.fn(),
  rawUrl: vi.fn((_id: string, p: string) => `raw://${p}`),
}))

vi.mock('@/lib/cabin-api', () => ({
  getCabinDoc: h.doc,
  cabinDocRawUrl: h.rawUrl,
}))

import { CockpitStateProvider } from '../../state/CockpitStateProvider'
import { CockpitDocWindow, openCockpitDoc } from '../CockpitDocWindow'

const PATH = 'C:\\Users\\EDY\\.octopus\\workspaces\\cabin-1\\reports\\2026-11-19-验收报告.md'

function renderWindow() {
  return render(
    <CockpitStateProvider entryCabinId="cabin-1">
      <CockpitDocWindow />
    </CockpitStateProvider>,
  )
}

describe('CockpitDocWindow — 聊天产物的只读查看器', () => {
  beforeEach(() => {
    h.doc.mockReset()
    h.rawUrl.mockClear()
  })

  it('md → Markdown 渲染；头部文件名 + 绝对路径 + 只读', async () => {
    h.doc.mockResolvedValue({
      path: PATH, ext: '.md', size: 128, kind: 'text',
      content: '# 验收报告\n\n- 3/3 通过',
    })
    renderWindow()
    act(() => openCockpitDoc(PATH))

    await waitFor(() => expect(screen.getByText('验收报告')).toBeTruthy())
    expect(screen.getByTestId('cockpit-docwin')).toBeTruthy()
    expect(screen.getAllByText(/2026-11-19-验收报告\.md/).length).toBeGreaterThan(0)
    expect(screen.getByTestId('cockpit-doc-pathbar').textContent).toContain(PATH)
    expect(h.doc).toHaveBeenCalledWith('cabin-1', PATH)
  })

  it('json → 美化；yaml / html 走 mono 文本', async () => {
    h.doc.mockResolvedValue({
      path: 'C:\\x\\data.json', ext: '.json', size: 10, kind: 'text', content: '{"a":1}',
    })
    renderWindow()
    act(() => openCockpitDoc('C:\\x\\data.json'))
    await waitFor(() => expect(screen.getByText(/"a": 1/)).toBeTruthy())
  })

  it('图片 / 视频走 doc-raw（<img> / <video>），不读文本内容', async () => {
    h.doc.mockResolvedValue({
      path: 'C:\\x\\shot.png', ext: '.png', size: 99, kind: 'image', mime: 'image/png',
    })
    renderWindow()
    act(() => openCockpitDoc('C:\\x\\shot.png'))
    const img = await screen.findByTestId('cockpit-doc-image')
    expect(img.getAttribute('src')).toBe('raw://C:\\x\\shot.png')

    h.doc.mockResolvedValue({
      path: 'C:\\x\\clip.mp4', ext: '.mp4', size: 4096, kind: 'video', mime: 'video/mp4',
    })
    act(() => openCockpitDoc('C:\\x\\clip.mp4'))
    const video = await screen.findByTestId('cockpit-doc-video')
    expect(video.getAttribute('src')).toBe('raw://C:\\x\\clip.mp4')
  })

  it('二进制 → 「无法查阅二进制文件」，不给内容', async () => {
    h.doc.mockResolvedValue({
      path: 'C:\\x\\blob.bin', ext: '.bin', size: 2048, kind: 'binary',
    })
    renderWindow()
    act(() => openCockpitDoc('C:\\x\\blob.bin'))
    const binary = await screen.findByTestId('cockpit-doc-binary')
    expect(binary.textContent).toContain('无法查阅二进制文件')
  })

  it('读取失败 → 错误直出；关闭后窗消失', async () => {
    h.doc.mockRejectedValue(new Error('path outside this cabin\'s docs'))
    renderWindow()
    act(() => openCockpitDoc('C:\\other\\x.md'))
    const err = await screen.findByTestId('cockpit-doc-error')
    expect(err.textContent).toContain('path outside')

    act(() => {
      screen.getByTestId('cockpit-doc-close').click()
    })
    expect(screen.queryByTestId('cockpit-docwin')).toBeNull()
  })
})
