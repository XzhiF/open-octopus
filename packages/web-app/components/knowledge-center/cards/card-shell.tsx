'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 卡片外壳（原型 Tab④ vcard 形制：边框贴纸 + 头部「图标 卡名 · 状态」+ 行 + 钮行）。
 * 暗色 TUI pop-* token；票13 新卡类直接复用。
 */
export function CardShell({
  testId,
  title,
  status,
  tone,
  children,
}: {
  testId: string
  title: ReactNode
  status?: ReactNode
  tone?: 'default' | 'warn' | 'ok' | 'danger'
  children: ReactNode
}) {
  return (
    <div
      data-testid={`kc-card-${testId}`}
      className={cn(
        'my-1 rounded-lg border-[1.5px] bg-pop-paper p-2.5 text-xs shadow-[inset_0_0_0_1px_rgba(0,0,0,0.2)]',
        tone === 'warn' ? 'border-pop-amber' : tone === 'danger' ? 'border-pop-red' : tone === 'ok' ? 'border-pop-green' : 'border-pop-bd',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-black text-pop-ink">
        <span>{title}</span>
        {status !== undefined && (
          <span
            data-testid={`kc-card-${testId}-status`}
            className={cn(
              'rounded bg-pop-inset px-1.5 py-0.5 text-[10px] font-bold',
              tone === 'danger' ? 'text-pop-red' : tone === 'warn' ? 'text-pop-amber' : 'text-pop-green',
            )}
          >
            {status}
          </span>
        )}
      </div>
      <div className="mt-1.5 space-y-1">{children}</div>
    </div>
  )
}

/** 键值行（卡面 `k/v` 网格，原型 .row 同款）。 */
export function CardRow({ k, v, tone }: { k: string; v: ReactNode; tone?: 'warn' | 'danger' | 'muted' }) {
  return (
    <div className="flex gap-2 leading-relaxed">
      <span className="shrink-0 text-pop-dim">{k}</span>
      <span
        className={cn(
          'min-w-0 break-all',
          tone === 'warn' ? 'text-pop-amber' : tone === 'danger' ? 'text-pop-red' : tone === 'muted' ? 'text-pop-dim' : 'text-pop-ink',
        )}
      >
        {v}
      </span>
    </div>
  )
}

/** 卡面小钮（原型 btnrow：cy=看页/主操作 · no=回滚/危险 · pri=对话类）。 */
export function KcBtn({
  children,
  onClick,
  tone = 'plain',
  disabled,
  testId,
}: {
  children: ReactNode
  onClick?: () => void
  tone?: 'plain' | 'cy' | 'green' | 'no' | 'pri'
  disabled?: boolean
  testId?: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded border-[1.5px] border-pop-bd bg-pop-bg px-2 py-0.5 text-[11px] font-bold text-pop-dim transition-colors',
        tone === 'cy' && 'text-pop-cyan',
        tone === 'green' && 'text-pop-green',
        tone === 'no' && 'text-pop-red',
        tone === 'pri' && 'border-pop-pink bg-pop-pink text-pop-bg hover:brightness-110',
        !disabled && 'hover:bg-accent hover:text-pop-ink',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      {children}
    </button>
  )
}

export function CardBtnRow({ children }: { children: ReactNode }) {
  return <div className="mt-2 flex flex-wrap items-center gap-1.5">{children}</div>
}
