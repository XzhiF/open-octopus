"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  LayoutDashboard,
  FolderKanban,
  BookOpen,
  Clock,
  Settings,
  Bell,
  Activity,
  BrainCircuit,
  Package,
  Sliders,
  ListTodo,
} from "lucide-react"

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "任务看板", href: "/tasks", icon: ListTodo },
  { name: "工作空间", href: "/workspaces", icon: FolderKanban },
  { name: "工作经验", href: "/experience", icon: BookOpen },
  { name: "系统调度", href: "/scheduler", icon: Clock },
  { name: "Agent", href: "/agent", icon: BrainCircuit },
  { name: "资源", href: "/resources", icon: Package },
  { name: "系统管理", href: "/system/models", icon: Sliders },
]

export function Header() {
  const pathname = usePathname()

  return (
    <header className="sticky top-0 z-50 w-full border-b-[2.5px] border-pop-bd bg-pop-paper">
      <div className="flex h-14 items-center px-4 lg:px-6">
        {/* Logo — 粉色贴纸 */}
        <Link href="/" className="flex items-center gap-2 mr-6">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border-2 border-pop-bd bg-pop-pink text-white shadow-pop-sm">
            <Activity className="h-4 w-4" />
          </div>
          <span className="font-black text-lg tracking-tight text-pop-ink">Octopus</span>
        </Link>

        {/* Navigation — 激活 = 黄贴纸 */}
        <nav aria-label="主导航" className="flex items-center gap-1">
          {navigation.map((item) => {
            const isActive = pathname === item.href ||
              (item.href !== "/" && pathname.startsWith(item.href))
            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-all",
                  isActive
                    ? "border-2 border-pop-bd bg-pop-yellow font-black text-pop-ink shadow-[2px_2px_0_rgba(28,27,34,0.16)] dark:shadow-[2px_2px_0_rgba(0,0,0,0.45)]"
                    : "font-bold text-pop-dim hover:bg-accent hover:text-pop-ink"
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.name}
              </Link>
            )
          })}
        </nav>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right side actions */}
        <div className="flex items-center gap-2">
          {/* Notifications */}
          <Button variant="ghost" size="icon" className="relative">
            <Bell className="h-4 w-4" />
            <span className="sr-only">通知</span>
          </Button>

          {/* Settings */}
          <Button variant="ghost" size="icon" asChild>
            <Link href="/settings">
              <Settings className="h-4 w-4" />
              <span className="sr-only">设置</span>
            </Link>
          </Button>
        </div>
      </div>
    </header>
  )
}
