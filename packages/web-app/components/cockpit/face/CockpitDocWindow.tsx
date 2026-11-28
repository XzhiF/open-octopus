'use client'

// 文档查看器（2026-11-19 用户 #4）：通讯台正文里的产物绝对路径点开 → 只读窗。
//   · 壳 = 目录窗同一套（.ck12-treewin / .ck12-dh / .ck12-ckt-*）：✕ 左置、玻璃底、
//     顶部渐变发丝线、cwd 同款路径条、Markdown 同款排版；标题栏可拖。
//   · 单文件，没有标签页 —— 点开就是这份文档。
//   · 格式：md 渲染；json 美化；yaml / 文本 mono；html 按纯文本（不做页面渲染）；
//     图片 / 视频 / 音频直接预览；其余二进制只显示「无法查阅二进制文件」。
//   · 数据 = GET /api/cabins/:id/doc（文本）与 /doc-raw（媒体字节，支持 Range）。
//     服务端只放行本舱文档根（舱 cwd / 本舱任务 workspace），绝对路径是硬要求。

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { toast } from 'sonner'
import { cabinDocRawUrl, getCabinDoc, type CabinDocResult } from '@/lib/cabin-api'
import { OPEN_DOC_EVENT, openDoc, type OpenDocDetail } from '@/lib/open-doc'
import { useCockpitState } from '../state/CockpitStateProvider'
import { CockpitFaceHead } from './CockpitFaceHead'
import { MarkdownView } from '@/components/ui/markdown-view'

const DOC_LAYER_ID = 'cockpit-doc-win'
/** 高于目录窗（68）：Esc 先收文档窗；低于问答窗（75）。 */
const DOC_LAYER_PRIORITY = 69

export { OPEN_DOC_EVENT } from '@/lib/open-doc'
export type { OpenDocDetail } from '@/lib/open-doc'

/** 任意宿主（聊天 chip / 后续其他入口）→ 打开文档窗。 */
export function openCockpitDoc(path: string): void {
  openDoc(path)
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${n}B`
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function extOf(p: string): string {
  const i = p.lastIndexOf('.')
  return i < 0 ? '' : p.slice(i).toLowerCase()
}

const KIND_LABEL: Record<CabinDocResult['kind'], string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
  binary: '二进制',
}

/** 文本类怎么显示：md 渲染 / json 美化 / 其余 mono（html 也只做纯文本）。 */
function DocBody({ doc, cabinId }: { doc: CabinDocResult; cabinId: string }) {
  const ext = doc.ext || extOf(doc.path)
  if (doc.kind === 'binary') {
    return (
      <div className="ck12-ckt-empty" data-testid="cockpit-doc-binary">
        无法查阅二进制文件
        <span>该文件是二进制（{ext || '无扩展名'} · {formatBytes(doc.size)}），座舱只读文本 / 图片 / 视频 / 音频。</span>
      </div>
    )
  }
  if (doc.kind === 'image') {
    const src = cabinDocRawUrl(cabinId, doc.path)
    return (
      <div className="ck12-ckt-imgwrap">
        <img className="ck12-ckt-img" src={src} alt={basename(doc.path)} data-testid="cockpit-doc-image" />
      </div>
    )
  }
  if (doc.kind === 'video') {
    const src = cabinDocRawUrl(cabinId, doc.path)
    return <video className="ck12-doc-media" src={src} controls preload="metadata" data-testid="cockpit-doc-video" />
  }
  if (doc.kind === 'audio') {
    const src = cabinDocRawUrl(cabinId, doc.path)
    return <audio className="ck12-doc-audio" src={src} controls preload="metadata" data-testid="cockpit-doc-audio" />
  }
  const content = doc.content ?? ''
  if (ext === '.md' || ext === '.markdown' || ext === '.mdx') {
    return <div className="ck12-ckt-doc"><MarkdownView src={content} /></div>
  }
  let text = content
  if (ext === '.json' || ext === '.jsonc') {
    try { text = JSON.stringify(JSON.parse(content), null, 2) } catch { text = content }
  }
  return <pre className="ck12-ckt-code">{text}</pre>
}

interface DocGeo { x: number; y: number }

export function CockpitDocWindow() {
  const { entryCabinId, layer } = useCockpitState()
  const [target, setTarget] = useState<string | null>(null)
  const [doc, setDoc] = useState<CabinDocResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [geo, setGeo] = useState<DocGeo | null>(null)
  const winRef = useRef<HTMLDivElement | null>(null)

  const close = useCallback(() => {
    setTarget(null)
    setDoc(null)
    setError(null)
    setGeo(null)
  }, [])

  // 聊天 chip（或任何宿主）发事件 → 开窗。
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenDocDetail>).detail
      if (!detail?.path) return
      setTarget(detail.path)
      setGeo(null)
    }
    window.addEventListener(OPEN_DOC_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_DOC_EVENT, onOpen)
  }, [])

  // Esc：走层栈（68 目录窗 / 69 本窗 / 75 问答窗）。
  useEffect(() => {
    if (!target) return
    return layer.register(DOC_LAYER_ID, DOC_LAYER_PRIORITY, close)
  }, [target, layer, close])

  useEffect(() => {
    if (!target) return
    let alive = true
    setLoading(true)
    setDoc(null)
    setError(null)
    getCabinDoc(entryCabinId, target)
      .then((result) => { if (alive) setDoc(result) })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : '读取文档失败') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [entryCabinId, target])

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

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = winRef.current
    if (!el) return
    const target = event.target as HTMLElement
    if (target.closest('button, a, input, textarea, select, video, audio')) return
    // 只拖标题栏：正文里按下/选字不搬窗（与目录窗同一口径）。
    if (!target.closest('.ck12-dh')) return
    const rect = el.getBoundingClientRect()
    const sx = event.clientX
    const sy = event.clientY
    const onMove = (ev: PointerEvent) => {
      setGeo({
        x: Math.max(4, Math.min(rect.left + ev.clientX - sx, Math.max(4, window.innerWidth - rect.width - 4))),
        y: Math.max(52, Math.min(rect.top + ev.clientY - sy, Math.max(52, window.innerHeight - rect.height - 4))),
      })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    event.preventDefault()
  }

  if (!target) return null

  const name = basename(target)
  const ext = doc?.ext || extOf(target)
  const style: CSSProperties | undefined = geo
    ? { left: geo.x, top: geo.y, transform: 'none' }
    : undefined

  return (
    <div
      ref={winRef}
      className={`ck12-treewin ck12-docwin${geo ? ' is-geo' : ''}`}
      style={style}
      data-testid="cockpit-docwin"
      onPointerDownCapture={startDrag}
    >
      <CockpitFaceHead
        testId="cockpit-docwin-head"
        closeTestId="cockpit-doc-close"
        glyph="▤"
        title={name}
        sub={`文档 · 只读 · ${doc ? KIND_LABEL[doc.kind] : error ? '读取失败' : '读取中'}${ext ? ` · ${ext}` : ''}`}
        onClose={close}
        closeLabel="关闭文档"
      />

      <div className="ck12-docwin-b">
        <div className="ck12-ckt-cwd" data-testid="cockpit-doc-pathbar">
          <span className="ck12-ckt-cwd-k">📄 文档</span>
          <span className="ck12-ckt-cwd-p" title={target}>{target}</span>
          {doc && <span className="ck12-ckt-ro">{formatBytes(doc.size)}</span>}
          <span className="ck12-ckt-ro">只读</span>
          <button type="button" className="ck12-ckt-ib" onClick={() => void copyPath()} title="复制完整路径">
            ⧉ 复制路径
          </button>
          <button type="button" className="ck12-ckt-ib" onClick={revealPath} title="桌面壳：在资源管理器中定位">
            ▦ 资源管理器
          </button>
        </div>

        <div className="ck12-docwin-main">
          <div className="ck12-docwin-view">
            {loading && <div className="ck12-ckt-empty">读文件…</div>}
            {error && <div className="ck12-ckt-empty is-err" data-testid="cockpit-doc-error">{error}</div>}
            {doc && <DocBody doc={doc} cabinId={entryCabinId} />}
          </div>
        </div>
      </div>
    </div>
  )
}
