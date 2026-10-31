'use client'

// 输入框控件条上的「当前身份」贴纸（2026-10-30 用户定稿）。
//
//   · 任务线程：身份由任务状态自动派生（草稿=作者 → 执行/验收=执行者 →
//     终态=主 Agent），用户不能主动切身份，所以只读（锁形图标，无清除钮）；
//   · 普通会话：显示当前分身身份，鼠标悬停露出 ✕，点掉即回到主身份。
//
// 紫幽兰（pop-purple）是平台的身份色，与 ＋ 面板 / 分身名册 / hero 选择器同源；
// 基础身份用虚线弱化，但仍保持紫幽兰，避免变成第二套配色。

import { Lock, UserRound, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ComposerIdentityDisplay {
  /** 展示名（分身名 / 作者 / 执行者 / 主 Agent）。 */
  label: string
  /** true = 分身或任务角色；false = 基础身份（主 Agent）。 */
  active: boolean
  /** 任务线程：只读展示，不渲染清除钮。 */
  readOnly?: boolean
  /** 清除回主身份（仅 active && !readOnly 时露出 ✕）。 */
  onClear?: () => void
  title?: string
}

export function ComposerIdentityChip({ display }: { display: ComposerIdentityDisplay }) {
  const { label, active, readOnly, onClear, title } = display
  const clearable = !!active && !readOnly && !!onClear

  return (
    <span
      data-testid="composer-identity-chip"
      data-identity-mode={readOnly ? 'readonly' : active ? 'active' : 'base'}
      title={title}
      className={cn(
        'group flex h-[22px] max-w-[200px] shrink-0 items-center gap-1 rounded-[7px] border px-1.5 font-mono text-[10.5px] leading-none',
        active || readOnly
          ? 'border-pop-purple/50 bg-pop-purple-soft text-pop-purple'
          : 'border-dashed border-pop-purple/35 bg-pop-purple-soft/50 text-pop-purple/85',
      )}
    >
      <UserRound className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
      {readOnly ? (
        <Lock className="ml-0.5 size-2.5 shrink-0 opacity-60" aria-hidden data-identity-lock />
      ) : clearable ? (
        <button
          type="button"
          aria-label="清除身份，回到主身份"
          title="清除身份，回到主身份"
          onClick={onClear}
          data-testid="composer-identity-clear"
          className="ml-0.5 grid size-3 shrink-0 place-items-center rounded-full opacity-0 transition-opacity hover:bg-pop-purple/15 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
        >
          <X className="size-2.5" />
        </button>
      ) : null}
    </span>
  )
}
