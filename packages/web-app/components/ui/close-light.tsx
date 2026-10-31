'use client'

import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

/** 24px hit area around a 16px macOS traffic-light close. */
export const closeLightButtonBase =
  'group/light grid size-6 place-items-center rounded-full outline-none transition-transform focus-visible:ring-2 focus-visible:ring-pop-yellow'

export const closeLightButtonClass = cn(closeLightButtonBase, 'absolute left-3 top-3 z-30')

export function CloseLightGlyph({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-4 place-items-center rounded-full border-[1.5px] border-pop-bd/50 bg-pop-red shadow-pop-sm transition-transform duration-150 group-hover/light:scale-110',
        className,
      )}
    >
      <X className="size-2.5 text-pop-bg opacity-40 transition-opacity duration-150 group-hover/light:opacity-90" />
    </span>
  )
}
