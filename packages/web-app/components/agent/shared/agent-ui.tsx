'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Shared building blocks for the Agent / 分身 surfaces. */

export const inputCls =
  'h-8 w-full rounded-[8px] border-[1.5px] border-pop-bd bg-pop-inset px-2.5 text-[11.5px] text-pop-ink outline-none transition-colors placeholder:text-pop-dim/70 focus:border-pop-purple/60 disabled:cursor-not-allowed disabled:opacity-60'

export const selectCls = cn(inputCls, 'cursor-pointer appearance-none pr-8')

/** 单行页头：标题 + 一句说明，不占垂直空间。 */
export function PaneHead({
  title,
  description,
  actions,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-2 flex min-w-0 items-baseline gap-2">
      <h2 className="m-0 shrink-0 text-[12px] font-bold leading-none tracking-[-0.01em]">{title}</h2>
      {description && (
        <span className="min-w-0 truncate text-[9.5px] text-pop-dim">{description}</span>
      )}
      {actions && <div className="ml-auto flex flex-none items-center gap-1.5">{actions}</div>}
    </div>
  )
}

export function Card({
  title,
  tag,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode
  tag?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-[12px] border border-pop-bd bg-pop-paper',
        className,
      )}
    >
      {(title || tag || actions) && (
        <div className="flex items-center gap-2 border-b border-pop-bd/70 px-[13px] py-2.5">
          <h3 className="m-0 text-[12px] font-semibold">{title}</h3>
          {tag && (
            <span className="ml-auto text-[8px] uppercase tracking-[0.12em] text-pop-dim">{tag}</span>
          )}
          {actions}
        </div>
      )}
      <div className={cn('flex flex-col gap-3 p-[13px]', bodyClassName)}>{children}</div>
    </section>
  )
}

export function Field({
  label,
  help,
  icon,
  children,
}: {
  label: ReactNode
  help?: ReactNode
  icon?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.06em] text-pop-dim">
        {icon}
        {label}
      </span>
      {children}
      {help && <span className="text-[10px] leading-snug text-pop-dim">{help}</span>}
    </label>
  )
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[18px] w-8 flex-none rounded-full border-[1.5px] transition-colors disabled:opacity-50',
        checked ? 'border-pop-green/60 bg-pop-green/25' : 'border-pop-bd bg-pop-inset',
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] size-[10px] rounded-full transition-all',
          checked ? 'left-[15px] bg-pop-green' : 'left-[2px] bg-pop-dim',
        )}
      />
    </button>
  )
}

/** 终端风格的小标签（mono + 细边）。 */
export function Chip({
  children,
  tone = 'dim',
}: {
  children: ReactNode
  tone?: 'dim' | 'green' | 'cyan' | 'purple' | 'yellow' | 'red'
}) {
  const tones: Record<string, string> = {
    dim: 'border-pop-bd bg-pop-idle text-pop-dim',
    green: 'border-pop-green/35 bg-pop-green-soft text-pop-green',
    cyan: 'border-pop-cyan/35 bg-pop-cyan-soft text-pop-cyan',
    purple: 'border-pop-purple/35 bg-pop-purple-soft text-pop-purple',
    yellow: 'border-pop-yellow/35 bg-pop-yellow-soft text-pop-yellow',
    red: 'border-pop-red/35 bg-pop-pink-soft text-pop-red',
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-px text-[9px] font-bold',
        tones[tone],
      )}
    >
      {children}
    </span>
  )
}
