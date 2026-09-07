// packages/web-app/components/tasks/authoring/section-card.tsx
//
// 右栏产出面板的统一「分区卡」设计语言 —— 把 Phase 计划 / 草稿批次 / 执行产物 /
// 工作流运行记录 / 决策备忘 / 入队清单六类区头收敛成同一形态：
//   [icon] 标题 (count) hint …… [action] ⌄      ← 折叠触发整行
//   body (px-3 py-2，可用 -mx-3 -my-2 全出血)
//
// 折叠纪律（勿动）：Radix CollapsibleContent 收起即**卸载子树**，而 e2e/jsdom
// 在首渲染就查询 [data-phase-binding-list] / [data-checklist-v4=…] 等选择器 —
// 故 defaultOpen 恒 true，且持久化折叠态只在 mount 后读 localStorage（SSR /
// jsdom / 全新 Playwright profile 首渲染全展开）。
// rest props 转发到根 div：各区的 data-* testid 原样落在卡根。

"use client"

import { useEffect, useState, type ComponentPropsWithoutRef, type ReactNode } from "react"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import { ChevronRight } from "lucide-react"

export interface SectionCardProps extends ComponentPropsWithoutRef<"div"> {
  /** lucide 图标，建议 `size-3.5 text-muted-foreground`。 */
  icon?: ReactNode
  title: string
  /** 标题右侧计数 pill（区卡统一用数字，不再把计数混进 title 文本）。 */
  count?: number | string
  /** 头部弱化辅助说明（"磁盘直扫" 一类）。 */
  hint?: string
  /** 头部右侧动作槽（refresh 按钮等）——置于 trigger 之外，避免 button-in-button。 */
  action?: ReactNode
  /** 折叠态持久化键（octopus:section:<key>）；缺省不持久化。 */
  storageKey?: string
  /** 恒默认 true — 收起会卸载子树内的测试选择器，勿在信息区关闭。 */
  defaultOpen?: boolean
  children?: ReactNode
}

export function SectionCard({
  icon,
  title,
  count,
  hint,
  action,
  storageKey,
  defaultOpen = true,
  className = "",
  children,
  ...rest
}: SectionCardProps) {
  const [open, setOpen] = useState(defaultOpen)

  // mount 后才恢复持久化折叠态（见文件头折叠纪律）。
  useEffect(() => {
    if (!storageKey) return
    try {
      const v = window.localStorage.getItem(`octopus:section:${storageKey}`)
      if (v === "0") setOpen(false)
      else if (v === "1") setOpen(true)
    } catch {
      /* storage 不可用（无痕等）→ 维持 defaultOpen */
    }
  }, [storageKey])

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (storageKey) {
      try {
        window.localStorage.setItem(`octopus:section:${storageKey}`, next ? "1" : "0")
      } catch {
        /* ignore */
      }
    }
  }

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange} className="group/section shrink-0">
      <div className={`shrink-0 rounded-lg border bg-background ${className}`} {...rest}>
        <div className="flex items-center gap-1 px-3 py-2">
          <CollapsibleTrigger
            className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-medium"
            aria-expanded={open}
          >
            {icon}
            <span className="shrink-0">{title}</span>
            {count != null && (
              <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
                {count}
              </span>
            )}
            {hint && (
              <span className="min-w-0 truncate text-[10px] font-normal text-muted-foreground">{hint}</span>
            )}
            <ChevronRight className="ml-auto size-3 shrink-0 text-muted-foreground/70 transition-transform group-data-[state=open]/section:rotate-90" />
          </CollapsibleTrigger>
          {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
        </div>
        <CollapsibleContent>
          <div className="px-3 py-2">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
