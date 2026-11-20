// 片段字节 → blob URL（2026-11-20 用户 #15）。
//
// 现象：桌面端（Electron）里个别动作的立绘一直透明，背景正常。实测真机：
// 同一支 3MB webm，`fetch` 只要 ~0.3s，但交给 <video src> 走 Chromium 的媒体
// HTTP 管线要 ~18s 才 readyState 4 —— 换段节奏 5–8s，等于永远起不来，视频层
// 停在 opacity:0，人就「没了」。
//
// 解法：先 fetch 成 Blob 再挂 blob URL，媒体解码走本地内存（实测 <20ms）。
// 按 src 缓存，同一支只抓一次；任何一步失败都回退原始 URL（老路径）。
// jsdom 等没有 createObjectURL 的环境直接返回原 URL，行为不变。

const cache = new Map<string, Promise<string>>()

export function clipMediaUrl(src: string): Promise<string> {
  if (
    typeof fetch !== 'function' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return Promise.resolve(src)
  }
  const hit = cache.get(src)
  if (hit) return hit
  const task = fetch(src, { cache: 'force-cache' })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.blob()
    })
    .then((blob) => URL.createObjectURL(blob))
    .catch(() => src)
  cache.set(src, task)
  return task
}

/** 仅测试用：清空缓存（模块级缓存会跨用例保留）。 */
export function __resetClipMediaCache(): void {
  cache.clear()
}
