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
  /** lucide 图标;会被包进一个黑边小方块 chip。 */
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
  /** 图标 chip 的底色 token（如 var(--pop-yellow-soft)）；缺省走 muted。 */
  iconTint?: string
  /** 活动态:左侧粉脊高亮（当前正在产出的区）。 */
  active?: boolean
  children?: ReactNode
}

/** 🎪 分组吊牌:SPEC / RUN / GATE 三色标签,微微歪的彩色贴纸。 */
export function SectionGroupLabel({
  tone = "var(--pop-yellow)",
  children,
  ...rest
}: ComponentPropsWithoutRef<"div"> & { tone?: string }) {
  return (
    <div
      {...rest}
      className={`pop-tilt-tag inline-flex items-center gap-1.5 self-start rounded-lg border-2 border-pop-bd px-2.5 py-0.5 text-[10px] font-black tracking-[0.12em] text-pop-ink shadow-[2px_2px_0_rgba(28,27,34,.16)] ${rest.className ?? ""}`}
      style={{ background: tone, ...(rest.style ?? {}) }}
    >
      {children}
    </div>
  )
}

export function SectionCard({
  icon,
  title,
  count,
  hint,
  action,
  storageKey,
  defaultOpen = true,
  iconTint,
  active = false,
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
      <div
        className={`relative shrink-0 overflow-hidden rounded-xl border-[2.5px] border-pop-bd bg-pop-paper shadow-pop-sm transition-shadow hover:shadow-pop ${
          active ? "shadow-pop" : ""
        } ${className}`}
        {...rest}
      >
        {active && (
          <span aria-hidden className="absolute left-0 top-3 bottom-3 w-[6px] rounded-r-full border-y-2 border-r-2 border-pop-bd bg-pop-pink" />
        )}
        <div className="flex items-center gap-2 py-2 pr-3 pl-3">
          {icon && (
            <span
              aria-hidden
              className="grid size-7 shrink-0 place-items-center rounded-[9px] border-2 border-pop-bd shadow-[2px_2px_0_rgba(28,27,34,.15)]"
              style={{ background: iconTint ?? "var(--pop-idle)" }}
            >
              {icon}
            </span>
          )}
          <CollapsibleTrigger
            className="flex min-w-0 flex-1 items-center gap-2 text-left font-black text-pop-ink"
            aria-expanded={open}
          >
            <span className="shrink-0 text-[13px]">{title}</span>
            {count != null && (
              <span className="rounded-full border-[1.5px] border-pop-bd bg-pop-bg px-1.5 text-[10px] font-black tabular-nums text-pop-dim">
                {count}
              </span>
            )}
            {hint && (
              <span className="min-w-0 truncate text-[10px] font-semibold text-pop-dim">{hint}</span>
            )}
            <ChevronRight className="ml-auto size-3 shrink-0 text-pop-dim transition-transform group-data-[state=open]/section:rotate-90" />
          </CollapsibleTrigger>
          {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
        </div>
        <CollapsibleContent>
          <div className="pop-dash px-3 py-2">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
