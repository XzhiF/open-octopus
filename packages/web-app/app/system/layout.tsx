"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { Boxes, Database, ShieldCheck } from "lucide-react"

const MENU = [
  { label: "模型管理", href: "/system/models", icon: Boxes },
  { label: "仓库管理", href: "/system/repos", icon: Database },
  { label: "Harness 配置", href: "/system/harness", icon: ShieldCheck },
]

export default function SystemLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="flex flex-1 min-h-0">
      {/* Left sidebar */}
      <aside className="w-56 shrink-0 border-r-2 border-pop-bd bg-pop-paper">
        <nav className="p-3 space-y-1" aria-label="系统管理菜单">
          {MENU.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(item.href + "/")
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-all",
                  isActive
                    ? "border-2 border-pop-bd bg-pop-yellow font-black text-pop-ink shadow-[2px_2px_0_rgba(28,27,34,0.16)] dark:shadow-[2px_2px_0_rgba(0,0,0,0.45)]"
                    : "font-bold border-2 border-transparent text-pop-dim hover:bg-accent hover:text-pop-ink"
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            )
          })}
        </nav>
      </aside>

      {/* Right content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {children}
      </div>

    </div>
  )
}
