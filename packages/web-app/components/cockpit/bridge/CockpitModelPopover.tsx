'use client'

// S6 owns this file —— 心智 popover：直接复用 composer 的 ComposerModelPopover
// （同一份进程级 composer 设置：三个真别名 + 每个模型自己的思考强度 / 上下文预设）。
//
// 复用件的 open state 在组件内部，没有 onOpenChange prop；舰桥需要把「有弹层打开」
// 注册进 Esc 栈（plans §1.4 / 任务 S6-6）。这里只观察 Radix trigger 的
// `data-state`（公开 DOM 契约）来同步，关闭时点回 trigger —— Radix 的 toggle 语义，
// 不改复用件、不复制控件。
//
// Esc 本身由 CockpitLayerStack 在 window capture 阶段先截获并 stopPropagation，
// 所以 Radix 自己的 Escape 处理不会双触发；「仅影响对话 · 全局设置」的脚注由
// bridge.css 画在它的 portal 内容底部（同样因为不能给复用件加 prop）。

import { useCallback, useEffect, useRef, useState } from 'react'
import { ComposerModelPopover } from '@/components/agent/chat/composer-model-popover'
import { useCockpitState } from '../state/CockpitStateProvider'
import type { CockpitChatApi } from '../state/cockpit-state'

/** Esc 顺序：popover（90）→ 立绘控制条（75）→ 编队抽屉（70）→ 聊天浮窗（60）。 */
export const BRIDGE_POP_LAYER_PRIORITY = 90

export function CockpitModelPopover({ chat }: { chat: CockpitChatApi }) {
  const { layer } = useCockpitState()
  const hostRef = useRef<HTMLSpanElement | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const trigger = hostRef.current?.querySelector<HTMLElement>('[data-slot="popover-trigger"]')
    if (!trigger) return
    const sync = () => setOpen(trigger.getAttribute('data-state') === 'open')
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(trigger, { attributes: true, attributeFilter: ['data-state'] })
    return () => observer.disconnect()
  }, [])

  const close = useCallback(() => {
    hostRef.current?.querySelector<HTMLElement>('[data-slot="popover-trigger"]')?.click()
  }, [])

  useEffect(() => {
    if (!open) return
    return layer.register('bridge-pop', BRIDGE_POP_LAYER_PRIORITY, close)
  }, [open, layer, close])

  return (
    <span ref={hostRef} className="ck12-rig-model" data-testid="ck12-rig-model" title="⌘⇧M 循环模型">
      <ComposerModelPopover
        currentModel={chat.model}
        onModelChange={chat.setModel}
        effort={chat.effort}
        onEffortChange={chat.setEffort}
        context={chat.contextWindow}
        onContextChange={chat.setContext}
      />
    </span>
  )
}
