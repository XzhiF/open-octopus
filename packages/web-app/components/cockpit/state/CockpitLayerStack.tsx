'use client'

// 唯一的 Esc 监听（capture 阶段）。Radix 的 Popover/Dialog 必须
// onEscapeKeyDown={e => e.preventDefault()} 把 Esc 让给这里，否则会双触发。
//
// 顺序由各层注册时给的 priority 决定（plans §1.4）：
//   popover → 立绘控制条 → 任务模块窗 → 编队抽屉 → 聊天浮窗 → 作业面。
// 最外层（作业面）的 close 只收面，不退出路由。

import { useEffect, type ReactNode } from 'react'
import { escapeLayerCount, isRadixLayerOpen } from '@/lib/escape-stack'
import { useCockpitState } from './CockpitStateProvider'

export function CockpitLayerStack({ children }: { children: ReactNode }) {
  const { layer } = useCockpitState()

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // 外部浮层优先：任务模块窗（运行 / YAML / 子代理）走仓库共享的 escape-stack，
      // Radix 的 dialog/popover 自己处理。这里吞掉 Esc 会越过它们直接收作业面/浮窗，
      // 所以有人在上面时直接让行（各自的监听会 close + stopPropagation）。
      if (isRadixLayerOpen() || escapeLayerCount() > 0) return
      if (!layer.closeTop()) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [layer])

  return <>{children}</>
}
