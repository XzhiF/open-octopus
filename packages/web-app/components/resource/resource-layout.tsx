"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { cn } from "@/lib/utils"
import { Package, ScrollText, FolderOpen, FolderGit2 } from "lucide-react"

const TABS = [
  { id: "list", label: "资源列表", icon: Package },
  { id: "install", label: "安装", icon: FolderOpen },
  { id: "audit", label: "审计日志", icon: ScrollText },
  { id: "sources", label: "来源管理", icon: FolderGit2 },
] as const

type TabId = (typeof TABS)[number]["id"]

export function ResourceLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // Detail page — no tab nav
  const isDetailPage = pathname.match(/^\/resources\/[^/]+\/[^/]+$/)

  // If on a legacy route (/resources/audit), map to tab
  let activeTab: TabId = (searchParams.get("tab") as TabId) || "list"
  if (pathname === "/resources/audit") activeTab = "audit"

  const handleTabChange = (tab: TabId) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set("tab", tab)
    router.push(`/resources?${params.toString()}`)
  }

  return (
    <>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-black tracking-tight text-pop-ink">资源管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理平台 Skills、Agents、Workflows 资产
          </p>
        </div>

        {!isDetailPage && (
          <div className="mb-6 flex items-end gap-1 border-b-[2.5px] border-pop-bd" role="tablist" aria-label="资源管理标签页">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`tabpanel-${tab.id}`}
                className={cn(
                  "flex items-center gap-2 rounded-t-lg border-b-[2.5px] px-4 py-2.5 text-sm transition-colors -mb-[2.5px]",
                  activeTab === tab.id
                    ? "border-pop-bd bg-pop-yellow font-black text-pop-ink"
                    : "border-transparent font-bold text-pop-dim hover:bg-accent hover:text-pop-ink"
                )}
                onClick={() => handleTabChange(tab.id)}
              >
                <tab.icon className="h-4 w-4" />
                {tab.label}
              </button>
            ))}
          </div>
        )}

        <div
          id={`tabpanel-${activeTab}`}
          role="tabpanel"
          aria-label={TABS.find((t) => t.id === activeTab)?.label}
        >
          {children}
        </div>
      </div>

    </>
  )
}
