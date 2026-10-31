'use client'

import Link from '@/lib/app-navigation'
import { usePathname } from '@/lib/app-navigation'

export function NotFoundView() {
  const pathname = usePathname()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="font-mono text-4xl font-black text-pop-dim">404</div>
      <p className="text-sm font-bold text-pop-ink">没有找到这个页面</p>
      <p className="max-w-lg break-all font-mono text-[11px] text-pop-dim">{pathname}</p>
      <Link
        href="/"
        className="mt-2 rounded-lg border-[1.5px] border-pop-bd bg-pop-yellow px-3 py-1.5 text-xs font-black text-pop-bg"
      >
        回到对话
      </Link>
    </div>
  )
}
