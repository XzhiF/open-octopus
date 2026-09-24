'use client'

// mac 文件夹缩放弹窗（2026-09-24 草稿工作台 TUI 改版）—— 卡片从触发元素
// （anchor）的位置/尺寸 scale 展开到宿主弹窗中央，关闭时缩回原处。弹性缓动
// cubic-bezier(.32,1.45,.55,1) 复刻原型 chat-tui.html 的 #zoom。
// 基于 Radix Dialog：借其层栈的 Escape 语义（嵌套时最内层先关）与 modal 下的
// pointer-events 放行。
//
// 2026-09-24 修复「弹窗不居中」：旧实现用命令式 card.style.transform 写动画，
// Radix 层注册后的一次 re-render 会整体替换 style 属性（MutationObserver 实锤：
// 挂载 ~290ms 后 style 只剩 pointer-events; width），命令式写全部丢失 →
// 定中的 translate(-50%,-50%) 没了，弹窗左上角钉在视口中心。动画位姿改为
// React style prop 状态驱动：任何 re-render 都不会再弄丢 transform。

import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

interface ZoomDialogProps {
  open: boolean
  /** 父组件置 false（含 Esc/点遮罩）即触发缩回动画，动画结束才真正卸载。 */
  onClose: () => void
  /** 缩放锚点（点击的按钮/卡片）。缺省 = 中心 0.85 缩放淡入。 */
  anchor?: Element | null
  title: ReactNode
  children: ReactNode
  width?: number
}

const CENTERED = 'translate(-50%, -50%) scale(1)'

/** 收拢位姿：卡片中心恒 = 视口中心（left/top 50%），所以只需把 anchor 中心
 *  相对视口中心的偏移写进 translate。纯 anchor rect + width prop 计算，不量
 *  卡片自身 —— 才能安全放进 React style prop。 */
function collapsedTransform(anchor: Element | null, width: number): string {
  if (!anchor) return 'translate(-50%, -50%) scale(0.85)'
  const r = anchor.getBoundingClientRect()
  const dx = r.left + r.width / 2 - window.innerWidth / 2
  const dy = r.top + r.height / 2 - window.innerHeight / 2
  const scale = Math.max(r.width / width, 0.08)
  return `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(${scale})`
}

export function ZoomDialog({ open, onClose, anchor, title, children, width = 440 }: ZoomDialogProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<Element | null>(null)
  if (anchor) anchorRef.current = anchor
  const [phase, setPhase] = useState<'collapsed' | 'open' | 'closing'>('collapsed')
  const [collapsedTf, setCollapsedTf] = useState('translate(-50%, -50%) scale(0.85)')

  // 展开：先按 anchor 位姿挂帧（transition none），双 rAF 后弹回中心。
  useEffect(() => {
    if (!open) { setPhase('collapsed'); return }
    setCollapsedTf(collapsedTransform(anchorRef.current, width))
    setPhase('collapsed')
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setPhase('open')))
    return () => cancelAnimationFrame(raf)
  }, [open, width])

  // 收起：先播回缩动画，动画结束再通知父级卸载（幂等闸）。
  const requestClose = () => {
    if (phase === 'closing') return
    setCollapsedTf(collapsedTransform(anchorRef.current, width))
    setPhase('closing')
    setTimeout(onClose, 270)
  }

  const style: CSSProperties = {
    width,
    transform: phase === 'open' ? CENTERED : collapsedTf,
    opacity: phase === 'open' ? 1 : 0,
    transition:
      phase === 'open' ? 'transform .38s cubic-bezier(.32,1.45,.55,1), opacity .18s'
      : phase === 'closing' ? 'transform .26s cubic-bezier(.5,0,.75,.4), opacity .22s'
      : 'none',
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) requestClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-zoom-overlay className="fixed inset-0 z-[65] bg-black/55" />
        <DialogPrimitive.Content
          ref={cardRef}
          data-zoom-dialog
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => { e.preventDefault(); requestClose() }}
          onInteractOutside={(e) => { e.preventDefault(); requestClose() }}
          onOpenAutoFocus={(e) => {
            const first = cardRef.current?.querySelector<HTMLElement>('input:not([disabled]),select,textarea')
            if (first) { e.preventDefault(); setTimeout(() => first.focus(), 380) }
          }}
          className="fixed left-[50%] top-[50%] z-[70] rounded-xl border border-pop-bd bg-pop-paper p-4 shadow-pop-lg outline-none"
          style={style}
        >
          <DialogPrimitive.Title className="mb-3 text-[13px] font-bold text-pop-pink">{title}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
