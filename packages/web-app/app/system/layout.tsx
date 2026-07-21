"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { Boxes, Database } from "lucide-react"
import { Toaster } from "@/components/ui/sonner"

const MENU = [
  { label: "模型管理", href: "/system/models", icon: Boxes },
  { label: "仓库管理", href: "/system/repos", icon: Database },
]

export default function SystemLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="flex flex-1 min-h-0">
      {/* Left sidebar */}
      <aside className="w-56 shrink-0 border-r border-border bg-muted/30">
        <nav className="p-3 space-y-1" aria-label="系统管理菜单">
          {MENU.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(item.href + "/")
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
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

      <Toaster position="top-right" />
    </div>
  )
}
