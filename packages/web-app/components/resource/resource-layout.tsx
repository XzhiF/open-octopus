"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { Package, ScrollText, Shield, FolderOpen } from "lucide-react"
import { ResourceProvider } from "./resource-context"

const subNav = [
  { name: "资源列表", href: "/resources", icon: Package, exact: true },
  { name: "安装", href: "/resources/install", icon: FolderOpen },
  { name: "信任", href: "/resources/trust", icon: Shield },
  { name: "审计日志", href: "/resources/audit", icon: ScrollText },
]

export function ResourceLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <ResourceProvider>
      <div className="mx-auto max-w-7xl px-4 py-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">资源管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理平台 Skills、Agents、Workflows 资产
          </p>
        </div>

        <div className="mb-6 flex items-center gap-1 border-b border-border">
          {subNav.map((item) => {
            const isActive = item.exact
              ? pathname === item.href
              : pathname.startsWith(item.href)
            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  "flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
                  isActive
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.name}
              </Link>
            )
          })}
        </div>

        {children}
      </div>
    </ResourceProvider>
  )
}
