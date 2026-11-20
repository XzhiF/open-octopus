// clip-blob：片段字节先 fetch 成 blob URL（桌面端媒体 HTTP 管线慢，见实现注释）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetClipMediaCache, clipMediaUrl } from '../clip-blob'

const realCreate = URL.createObjectURL
const realRevoke = URL.revokeObjectURL

afterEach(() => {
  __resetClipMediaCache()
  vi.restoreAllMocks()
  URL.createObjectURL = realCreate
  URL.revokeObjectURL = realRevoke
})

describe('clip-blob · 片段字节 → blob URL', () => {
  it('环境没有 createObjectURL 时原样返回 URL（jsdom / 老路径）', async () => {
    // @ts-expect-error 故意摘掉
    URL.createObjectURL = undefined
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(clipMediaUrl('/clip.webm')).resolves.toBe('/clip.webm')
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('fetch 成功 → 返回 blob URL，同一支只抓一次', async () => {
    let n = 0
    URL.createObjectURL = vi.fn(() => `blob:test-${++n}`)
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'video/webm' })
    const fetchSpy = vi.fn(async () => new Response(blob, { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(clipMediaUrl('/a.webm')).resolves.toBe('blob:test-1')
    await expect(clipMediaUrl('/a.webm')).resolves.toBe('blob:test-1')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('fetch 失败 → 回退原始 URL', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:never')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    await expect(clipMediaUrl('/b.webm')).resolves.toBe('/b.webm')
    vi.unstubAllGlobals()
  })
})
