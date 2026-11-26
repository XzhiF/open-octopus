"use client"

// 对话里的图片缩略图（2026-11-26 用户 · 无工具版）：
//   助手正文里出现图片绝对路径（反引号 / markdown ![]() / 裸路径）时，在消息
//   下面直接渲染缩略图；点开是灯箱大图。开关在 设置 → 外观（默认打开）。
//
// 口径：
//   · 只认绝对路径（盘符 / 常见 POSIX 根），相对路径不猜 cwd；
//   · 图片字节走 /api/agent/sessions/:id/image，白名单由服务端按会话解析；
//   · 加载失败（文件被删 / 不在白名单）就静默收起，不占位、不弹错。
//   · 这是纯渲染层：agent 不需要任何新工具，路径写在正文里即可。

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { getServerUrl } from "@/lib/server-config"
import { useChatImageThumbs } from "@/hooks/use-chat-image-thumbs"

export interface ChatMediaScope {
  /** 会话 id —— 图片接口按会话解析允许的目录根。 */
  sessionId?: string | null
}

const ChatMediaContext = createContext<ChatMediaScope | null>(null)

export function ChatMediaProvider({ value, children }: { value: ChatMediaScope; children: ReactNode }) {
  return <ChatMediaContext.Provider value={value}>{children}</ChatMediaContext.Provider>
}

export function useChatMediaScope(): ChatMediaScope | null {
  return useContext(ChatMediaContext)
}

/** 单条消息最多出几张缩略图 —— 防止一张报告里几十个路径把转录铺满。 */
const MAX_THUMBS = 4

const IMG_EXT = "png|jpe?g|gif|webp|avif|svg|bmp|ico"

/** markdown 图片：`![alt](path)` / `![alt](path "title")`。 */
const MD_IMG_RE = new RegExp(
  `!\\[[^\\]\\n]*\\]\\(([^)\\s]+?\\.(?:${IMG_EXT}))(?:\\s+"[^"]*")?\\)`,
  "gi",
)

/** 反引号里的图片路径：`` `C:\…\a.png` ``。 */
const CODE_IMG_RE = new RegExp(`\`([^\`\\n]+?\\.(?:${IMG_EXT}))\``, "gi")

/** 正文里的裸图片路径：只认盘符 / 常见 POSIX 根，`/api/x.png` 这类片段不误判。 */
const BARE_IMG_RE = new RegExp(
  `((?:[A-Za-z]:[\\\\/]|\\/(?:Users|home|tmp|var|opt|mnt|media|root|Volumes)\\/)`
  + `[^\\s\`<>"']+?\\.(?:${IMG_EXT}))(?=$|[\\s，。；：、)\\]】"'\`])`,
  "gi",
)

/** 服务端只放行这两类绝对路径；其余形状直接忽略，避免空图闪烁。 */
function isServableImagePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path)
    || /^\/(?:Users|home|tmp|var|opt|mnt|media|root|Volumes)\//.test(path)
}

/** 从正文里抽图片绝对路径（去重，最多 MAX_THUMBS 条）。 */
export function extractImagePaths(text: string): string[] {
  if (!text) return []
  // 先把 URL 整段抹掉：否则 `https://x/a.png` 里的 `s:/` 会被当成盘符路径。
  const body = text.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g, " ")
  const found: string[] = []
  const push = (raw: string | undefined) => {
    if (!raw) return
    const path = raw.trim()
    if (!isServableImagePath(path)) return
    if (found.includes(path)) return
    if (found.length >= MAX_THUMBS) return
    found.push(path)
  }
  for (const m of body.matchAll(MD_IMG_RE)) push(m[1])
  for (const m of body.matchAll(CODE_IMG_RE)) push(m[1])
  for (const m of body.matchAll(BARE_IMG_RE)) push(m[1])
  return found
}

/** 图片字节流地址（服务端按会话白名单校验；<img> 带不了 Authorization，故不走 /api/agent）。 */
export function chatImageUrl(sessionId: string, absPath: string): string {
  return `${getServerUrl()}/api/chat-media/${encodeURIComponent(sessionId)}/image`
    + `?path=${encodeURIComponent(absPath)}`
}

function ImageLightbox({ sessionId, path, onClose }: {
  sessionId: string
  path: string
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  if (typeof document === "undefined") return null
  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex flex-col bg-black/85 backdrop-blur-sm"
      data-testid="chat-image-lightbox"
      onClick={onClose}
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-2.5">
        <span className="truncate font-mono text-[11px] text-pop-ink/80" title={path}>{path}</span>
        <span className="ml-auto shrink-0 text-[10.5px] text-pop-dim/70">点击任意处 / Esc 关闭</span>
        <button
          type="button"
          className="shrink-0 rounded border border-white/15 px-2 py-0.5 text-[11px] text-pop-dim transition-colors hover:border-pop-cyan/60 hover:text-pop-ink"
          onClick={(event) => { event.stopPropagation(); onClose() }}
          data-testid="chat-image-lightbox-close"
        >
          ✕
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img
          src={chatImageUrl(sessionId, path)}
          alt={path.split(/[\\/]/).pop() ?? path}
          className="max-h-full max-w-full rounded-md border border-white/10 bg-pop-paper object-contain"
          onClick={(event) => event.stopPropagation()}
        />
      </div>
    </div>,
    document.body,
  )
}

/** 助手消息下面的缩略图条；开关关闭 / 非会话上下文 / 没有图片路径时什么都不渲染。 */
export function ChatImages({ text }: { text: string }) {
  const enabled = useChatImageThumbs()
  const scope = useChatMediaScope()
  const [zoom, setZoom] = useState<string | null>(null)
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set())

  const paths = useMemo(
    () => (enabled ? extractImagePaths(text) : []),
    [enabled, text],
  )
  const sessionId = scope?.sessionId ?? null
  const visible = paths.filter((path) => !failed.has(path))

  if (!sessionId || visible.length === 0) return null

  const markFailed = (path: string) => {
    setFailed((prev) => {
      if (prev.has(path)) return prev
      const next = new Set(prev)
      next.add(path)
      return next
    })
  }

  return (
    <>
      <div className="mt-1.5 flex flex-wrap items-start gap-2" data-testid="chat-images">
        {visible.map((path) => (
          <button
            key={path}
            type="button"
            className="group relative shrink-0 overflow-hidden rounded-md border border-pop-bd/40 bg-pop-paper/40 transition-colors hover:border-pop-cyan/70"
            title={`点击放大 · ${path}`}
            data-testid="chat-image-thumb"
            data-image-path={path}
            onClick={() => setZoom(path)}
          >
            <img
              src={chatImageUrl(sessionId, path)}
              alt={path.split(/[\\/]/).pop() ?? path}
              loading="lazy"
              className="block max-h-[190px] max-w-[320px] object-contain"
              onError={() => markFailed(path)}
            />
          </button>
        ))}
      </div>
      {zoom && (
        <ImageLightbox sessionId={sessionId} path={zoom} onClose={() => setZoom(null)} />
      )}
    </>
  )
}
