'use client'

// 知识中心窗（v22 #7 · 2026-11-23 用户）：HUD 左上「⚛ 知识中心」→ 舱内开窗。
//
// 设计口径：「classic 模式里 Octopus 菜单点开的知识中心，换皮搬进全舱」。
//   · 内容**不重做** —— 直接渲染 /knowledge 页面（classic 同一套左树 / 阅读 /
//     右栏 / 检索），composer 里没有第二份知识实现；
//   · 壳 = 目录窗 / 文档窗同一套 .ck12-treewin（✕ 左置 · 玻璃底 · 可拖）；
//   · 嵌入时页面自己的标题条让位（KnowledgePage embedded），窗口头给
//     「⚛ 知识中心 | GLOBAL WIKI · 只读」，不出现双标题；
//   · Esc 走层栈（67：压过作业面 / dossier，低于问答窗 75）。

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useCockpitState } from '../state/CockpitStateProvider'
import { CockpitFaceHead } from './CockpitFaceHead'

const OPEN_KC_EVENT = 'octopus:open-knowledge'
const KC_LAYER_ID = 'cockpit-knowledge-win'
/** 与目录窗 / 文档窗同档（68/69）之下：知识是浏览窗，先收它再收文档。 */
const KC_LAYER_PRIORITY = 67

/** 任意宿主（HUD chip / 快捷键）→ 打开知识窗。 */
export function openCockpitKnowledge(): void {
  window.dispatchEvent(new CustomEvent(OPEN_KC_EVENT))
}

const KnowledgePage = lazy(() => import('@/app/knowledge/page'))

interface KcGeo { x: number; y: number }

export function CockpitKnowledgeWindow() {
  const { layer } = useCockpitState()
  const [open, setOpen] = useState(false)
  const [geo, setGeo] = useState<KcGeo | null>(null)
  const winRef = useRef<HTMLDivElement | null>(null)

  const close = useCallback(() => {
    setOpen(false)
    setGeo(null)
  }, [])

  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(OPEN_KC_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_KC_EVENT, onOpen)
  }, [])

  useEffect(() => {
    if (!open) return
    return layer.register(KC_LAYER_ID, KC_LAYER_PRIORITY, close)
  }, [open, layer, close])

  /** 只拖标题栏；正文里的点选 / 滚动 / 选字不搬窗（与文档窗同一口径）。 */
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = winRef.current
    if (!el) return
    const target = event.target as HTMLElement
    if (target.closest('button, a, input, textarea, select')) return
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

  if (!open) return null

  const style: CSSProperties | undefined = geo
    ? { left: geo.x, top: geo.y, transform: 'none' }
    : undefined

  return (
    <div
      ref={winRef}
      className={`ck12-treewin ck12-kcwin${geo ? ' is-geo' : ''}`}
      style={style}
      data-testid="cockpit-knowledge-win"
      onPointerDownCapture={startDrag}
    >
      <CockpitFaceHead
        testId="cockpit-knowledge-head"
        closeTestId="cockpit-knowledge-close"
        glyph="⚛"
        title="知识中心"
        sub="GLOBAL WIKI · 只读 · 策展人维护"
        onClose={close}
        closeLabel="关闭知识中心"
      />

      <div className="ck12-kcwin-b" data-testid="cockpit-knowledge-body">
        <Suspense fallback={<div className="ck12-ckt-empty">载入知识中心…</div>}>
          <KnowledgePage embedded />
        </Suspense>
      </div>
    </div>
  )
}
