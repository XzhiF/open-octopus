"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  LayoutDashboard,
  FolderKanban,
  Clock,
  Settings,
  Bell,
  Activity,
  BrainCircuit,
  Package,
} from "lucide-react"

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "工作空间", href: "/workspaces", icon: FolderKanban },
  { name: "系统调度", href: "/scheduler", icon: Clock },
  { name: "Agent", href: "/agent", icon: BrainCircuit },
  { name: "资源", href: "/resources", icon: Package },
]

export function Header() {
  const pathname = usePathname()

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-14 items-center px-4 lg:px-6">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 mr-6">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Activity className="h-4 w-4" />
          </div>
          <span className="font-semibold text-lg tracking-tight">Octopus</span>
        </Link>

        {/* Navigation */}
        <nav aria-label="主导航" className="flex items-center gap-1">
          {navigation.map((item) => {
            const isActive = pathname === item.href ||
              (item.href !== "/" && pathname.startsWith(item.href))
            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
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
