'use client'

// 桌面 / 经典舱的文档查看窗（2026-11-26 用户）：
//   聊天正文里的产物绝对路径 chip（📄 路径 ↗）点开 → 只读窗。
//   全舱已有 CockpitDocWindow；这里补非全舱表面，数据走会话级
//   GET /api/chat-media/:sessionId/doc 与 /raw（白名单按会话解析）。
//   壳沿用全站 Dialog（左上关闭灯），正文把 md / json / 媒体分开显示。

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog, DialogContent, DialogDescription, DialogTitle,
} from '@/components/ui/dialog'
import { MarkdownView } from '@/components/ui/markdown-view'
import { chatDocRawUrl, getChatDoc, type ChatDocResult } from '@/lib/chat-media-api'
import { OPEN_DOC_EVENT, type OpenDocDetail } from '@/lib/open-doc'
import './chat-doc-window.css'

const KIND_LABEL: Record<ChatDocResult['kind'], string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
  binary: '二进制',
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function extOf(p: string): string {
  const i = p.lastIndexOf('.')
  return i < 0 ? '' : p.slice(i).toLowerCase()
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${n}B`
}

function DocBody({ doc, sessionId }: { doc: ChatDocResult; sessionId: string }) {
  const ext = doc.ext || extOf(doc.path)
  if (doc.kind === 'binary') {
    return (
      <div className="chat-doc-empty" data-testid="chat-doc-binary">
        无法查阅二进制文件
        <span>该文件是二进制（{ext || '无扩展名'} · {formatBytes(doc.size)}），聊天文档窗只读文本 / 图片 / 视频 / 音频。</span>
      </div>
    )
  }
  if (doc.kind === 'image') {
    return (
      <div className="chat-doc-imgwrap">
        <img
          className="chat-doc-img"
          src={chatDocRawUrl(sessionId, doc.path)}
          alt={basename(doc.path)}
          data-testid="chat-doc-image"
        />
      </div>
    )
  }
  if (doc.kind === 'video') {
    return <video className="chat-doc-media" src={chatDocRawUrl(sessionId, doc.path)} controls preload="metadata" data-testid="chat-doc-video" />
  }
  if (doc.kind === 'audio') {
    return <audio className="chat-doc-media" src={chatDocRawUrl(sessionId, doc.path)} controls preload="metadata" data-testid="chat-doc-audio" />
  }
  const content = doc.content ?? ''
  if (ext === '.md' || ext === '.markdown' || ext === '.mdx') {
    return <div className="chat-doc-md"><MarkdownView src={content} /></div>
  }
  let text = content
  if (ext === '.json' || ext === '.jsonc') {
    try { text = JSON.stringify(JSON.parse(content), null, 2) } catch { text = content }
  }
  return <pre className="chat-doc-code">{text}</pre>
}

/**
 * 挂在 ChatPane（非全舱变体）：监听聊天 chip 的 open-doc 事件。
 * 只有 detail.sessionId 与自己的会话一致才开窗 —— 分屏两栏互不抢事件。
 */
export function ChatDocWindow({ sessionId }: { sessionId: string | null }) {
  const [target, setTarget] = useState<string | null>(null)
  const [doc, setDoc] = useState<ChatDocResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const close = useCallback(() => {
    setTarget(null)
    setDoc(null)
    setError(null)
  }, [])

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenDocDetail>).detail
      if (!detail?.path || !sessionId) return
      if (detail.sessionId && detail.sessionId !== sessionId) return
      setTarget(detail.path)
    }
    window.addEventListener(OPEN_DOC_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_DOC_EVENT, onOpen)
  }, [sessionId])

  useEffect(() => {
    if (!target || !sessionId) return
    let alive = true
    setLoading(true)
    setDoc(null)
    setError(null)
    getChatDoc(sessionId, target)
      .then((result) => { if (alive) setDoc(result) })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : '读取文档失败') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [target, sessionId])

  const copyPath = useCallback(async () => {
    if (!target) return
    try {
      await navigator.clipboard.writeText(target)
      toast(`已复制 · ${target}`)
    } catch {
      toast('复制失败 · 请手动选择路径')
    }
  }, [target])

  const revealPath = useCallback(() => {
    if (!target) return
    const desktop = (window as unknown as {
      octopusDesktop?: { revealPath?: (path: string) => unknown }
    }).octopusDesktop
    if (desktop?.revealPath) void desktop.revealPath(target)
    else toast('在资源管理器打开 · 仅桌面端可用')
  }, [target])

  if (!target || !sessionId) return null
  const name = basename(target)
  const ext = doc?.ext || extOf(target)

  return (
    <Dialog open onOpenChange={(next) => { if (!next) close() }}>
      <DialogContent
        className="chat-docwin flex h-[min(680px,86vh)] w-[min(920px,94vw)] max-w-none flex-col gap-0 overflow-hidden px-0 pb-0"
        data-testid="chat-docwin"
      >
        <DialogTitle className="sr-only">文档 · {name}</DialogTitle>
        <DialogDescription className="sr-only">只读查看聊天产物文件</DialogDescription>

        <div className="chat-docwin-head">
          <span className="chat-docwin-glyph" aria-hidden="true">▤</span>
          <span className="chat-docwin-title">
            <b>{name}</b>
            <span>
              文档 · 只读 · {doc ? KIND_LABEL[doc.kind] : error ? '读取失败' : '读取中'}
              {ext ? ` · ${ext}` : ''}{doc ? ` · ${formatBytes(doc.size)}` : ''}
            </span>
          </span>
        </div>

        <div className="chat-docwin-pathbar">
          <span className="chat-docwin-path" title={target} data-testid="chat-doc-path">{target}</span>
          <button type="button" className="chat-docwin-btn" onClick={() => void copyPath()} title="复制完整路径">
            ⧉ 复制路径
          </button>
          <button type="button" className="chat-docwin-btn" onClick={revealPath} title="桌面壳：在资源管理器中定位">
            ▦ 资源管理器
          </button>
        </div>

        <div className="chat-docwin-body">
          {loading && <div className="chat-doc-empty">读文件…</div>}
          {error && <div className="chat-doc-empty is-err" data-testid="chat-doc-error">{error}</div>}
          {doc && <DocBody doc={doc} sessionId={sessionId} />}
        </div>
      </DialogContent>
    </Dialog>
  )
}
