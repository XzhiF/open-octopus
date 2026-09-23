'use client'

// mac 文件夹缩放弹窗（2026-09-24 草稿工作台 TUI 改版）—— 卡片从触发元素
// （anchor）的位置/尺寸 scale 展开到宿主弹窗中央，关闭时缩回原处。弹性缓动
// cubic-bezier(.32,1.45,.55,1) 复刻原型 chat-tui.html 的 #zoom。
// 基于 Radix Dialog：借其层栈的 Escape 语义（嵌套时最内层先关）与 modal 下的
// pointer-events 放行；自定义动画走内联 transform（不用 keyframe 类，避免打架）。

import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useLayoutEffect, useRef, type ReactNode } from 'react'

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

function collapsedTransform(card: HTMLElement, anchor: Element | null): string {
  if (!anchor) return 'translate(-50%, -50%) scale(0.85)'
  const r = anchor.getBoundingClientRect()
  const c = card.getBoundingClientRect()
  const dx = r.left + r.width / 2 - (c.left + c.width / 2)
  const dy = r.top + r.height / 2 - (c.top + c.height / 2)
  const scale = Math.max(r.width / c.width, 0.08)
  return `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(${scale})`
}

export function ZoomDialog({ open, onClose, anchor, title, children, width = 440 }: ZoomDialogProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<Element | null>(null)
  if (anchor) anchorRef.current = anchor
  const closingRef = useRef(false)

  // 展开：挂载帧量 anchor rect 摆到位姿（transition none），双 rAF 后弹回中心。
  useLayoutEffect(() => {
    if (!open) return
    const card = cardRef.current
    if (!card) return
    card.style.transition = 'none'
    card.style.opacity = '0'
    card.style.transform = collapsedTransform(card, anchorRef.current)
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => {
      card.style.transition = 'transform .38s cubic-bezier(.32,1.45,.55,1), opacity .18s'
      card.style.transform = 'translate(-50%, -50%) scale(1)'
      card.style.opacity = '1'
    }))
    return () => cancelAnimationFrame(raf)
  }, [open])

  // 收起：先播回缩动画，动画结束再通知父级卸载（幂等闸）。
  const requestClose = () => {
    const card = cardRef.current
    if (!card || closingRef.current) return
    closingRef.current = true
    card.style.transition = 'transform .26s cubic-bezier(.5,0,.75,.4), opacity .22s'
    card.style.transform = collapsedTransform(card, anchorRef.current)
    card.style.opacity = '0'
    setTimeout(onClose, 270)
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
          style={{ width }}
        >
          <DialogPrimitive.Title className="mb-3 text-[13px] font-bold text-pop-pink">{title}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
