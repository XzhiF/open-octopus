"use client"

import { useState, useCallback } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { useResources } from "@/hooks/use-resources"
import { resourceApi } from "@/lib/api-client"
import { ResourceGrid } from "@/components/resources/resource-grid"
import { ResourceSearch } from "@/components/resources/resource-search"
import { EmptyState } from "@/components/resources/empty-state"
import { InstallDialog } from "@/components/resources/install-dialog"
import { ConfirmUninstallDialog } from "@/components/resources/confirm-uninstall-dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Package, PackagePlus, ScrollText, Shield, RotateCcw, PackageOpen } from "lucide-react"
import { toast } from "sonner"
import Link from "next/link"

export function ResourcePage() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const activeTab = searchParams.get("type") ?? "all"
  const searchQuery = searchParams.get("q") ?? ""

  const [installOpen, setInstallOpen] = useState(false)
  const [uninstallTarget, setUninstallTarget] = useState<string | null>(null)
  const [highlightNames, setHighlightNames] = useState<Set<string>>(new Set())

  const { resources, loading, error, refetch, counts } = useResources({
    type: activeTab,
    query: searchQuery,
  })

  const setTab = useCallback((tab: string) => {
    const params = new URLSearchParams(searchParams.toString())
    if (tab === "all") params.delete("type")
    else params.set("type", tab)
    router.push(`/resources?${params}`)
  }, [searchParams, router])

  const setSearch = useCallback((q: string) => {
    const params = new URLSearchParams(searchParams.toString())
    if (q) params.set("q", q)
    else params.delete("q")
    router.push(`/resources?${params}`)
  }, [searchParams, router])

  const handleUninstall = useCallback(async (name: string) => {
    setUninstallTarget(null)
    try {
      await resourceApi.uninstall([name])
      toast.success(`${name} 已卸载`)
      refetch()
    } catch {
      toast.error(`卸载 ${name} 失败`)
    }
  }, [refetch])

  const handleInstallComplete = useCallback((installedNames: string[]) => {
    refetch()
    setHighlightNames(new Set(installedNames))
    // Clear highlight after animation
    setTimeout(() => setHighlightNames(new Set()), 2500)
    installedNames.forEach(name => {
      toast.success(`${name} 已安装并自动接入`)
    })
  }, [refetch])

  return (
    <div className="container mx-auto space-y-6 px-4 py-6 lg:px-6">
      {/* Title area */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">资源管理</h1>
          <p className="text-muted-foreground">
            管理和监控工作空间中的 Skills、Agents、Workflows 资源
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" asChild>
            <Link href="/resources/audit">
              <ScrollText className="size-3.5 mr-1.5" />
              <span className="hidden sm:inline">审计日志</span>
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/resources/trust">
              <Shield className="size-3.5 mr-1.5" />
              <span className="hidden sm:inline">信任管理</span>
            </Link>
          </Button>
          <Button size="sm" onClick={() => setInstallOpen(true)}>
            <PackagePlus className="size-3.5 mr-1.5" />
            <span className="hidden sm:inline">安装资源</span>
          </Button>
        </div>
      </div>

      {/* Tabs + Search */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={activeTab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="all" className="gap-1.5">
              全部 <Badge variant="secondary" className="ml-0.5 text-xs">{counts.all}</Badge>
            </TabsTrigger>
            <TabsTrigger value="skill">Skills</TabsTrigger>
            <TabsTrigger value="agent">Agents</TabsTrigger>
            <TabsTrigger value="workflow">Workflows</TabsTrigger>
            <TabsTrigger value="source">Sources</TabsTrigger>
          </TabsList>
        </Tabs>
        <ResourceSearch value={searchQuery} onChange={setSearch} />
      </div>

      {/* Error state */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center gap-2">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={refetch} className="gap-1.5 ml-auto">
              <RotateCcw className="size-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Loading state */}
      {loading && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-48 rounded-xl" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && resources.length === 0 && (
        <EmptyState
          icon={searchQuery || activeTab !== "all" ? PackageOpen : Package}
          title={searchQuery || activeTab !== "all" ? "无匹配资源" : "暂无资源"}
          description={
            searchQuery || activeTab !== "all"
              ? "尝试调整搜索条件或切换类型过滤"
              : "安装第一个资源以开始使用资源管理功能"
          }
          action={
            !searchQuery && activeTab === "all" ? (
              <Button size="sm" onClick={() => setInstallOpen(true)} className="gap-1.5">
                <PackagePlus className="size-3.5" />
                安装资源
              </Button>
            ) : undefined
          }
        />
      )}

      {/* Resource grid */}
      {!loading && !error && resources.length > 0 && (
        <ResourceGrid
          resources={resources}
          onUninstall={(name) => setUninstallTarget(name)}
          highlightNames={highlightNames}
        />
      )}

      {/* Bottom summary */}
      {!loading && !error && resources.length > 0 && (
        <p className="text-sm text-muted-foreground text-center">
          已安装 {counts.all} 个资源 · {counts.skill} skills · {counts.agent} agents · {counts.workflow} workflows · {counts.source} sources
        </p>
      )}

      {/* Install dialog */}
      <InstallDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        onInstallComplete={handleInstallComplete}
      />

      {/* Uninstall confirmation */}
      <ConfirmUninstallDialog
        resourceName={uninstallTarget}
        onConfirm={handleUninstall}
        onCancel={() => setUninstallTarget(null)}
      />
    </div>
  )
}
