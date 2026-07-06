"use client"

import { useState } from "react"
import { useParams, useSearchParams, useRouter } from "next/navigation"
import { useResourceDetail } from "@/hooks/use-resources"
import { DependencyTree } from "@/components/resource/dependency-tree"
import { MarkdownPreview } from "@/components/resource/markdown-preview"
import { UninstallConfirmDialog } from "@/components/resource/uninstall-confirm-dialog"
import { AuditTable } from "@/components/resource/audit-table"
import { useAuditLog } from "@/hooks/use-resources"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import {
  ArrowLeft,
  Trash2,
  CheckCircle2,
  Circle,
  Package,
  Bot,
  Workflow,
  AlertCircle,
  ExternalLink,
} from "lucide-react"
import type { ResourceType } from "@/lib/resource/api"

const typeIcons = { skill: Package, agent: Bot, workflow: Workflow } as const

export default function ResourceDetailPage() {
  const params = useParams<{ type: string; name: string }>()
  const searchParams = useSearchParams()
  const router = useRouter()

  const type = params.type as ResourceType
  const name = decodeURIComponent(params.name)
  const tabParam = searchParams.get("tab") ?? "overview"

  const { resource, deps, loading, error, refetch } = useResourceDetail(type, name)
  const { entries } = useAuditLog({ resource: name, last: 20 })
  const [uninstallOpen, setUninstallOpen] = useState(false)

  const setTab = (tab: string) => {
    const sp = new URLSearchParams(searchParams.toString())
    sp.set("tab", tab)
    router.push(`/resources/${type}/${name}?${sp.toString()}`, { scroll: false })
  }

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-6 max-w-4xl space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="container mx-auto px-4 py-6 max-w-4xl">
        <div className="flex items-center gap-4 text-destructive">
          <AlertCircle className="h-6 w-6" />
          <div>
            <h2 className="font-semibold">加载失败</h2>
            <p className="text-sm text-muted-foreground">{error.message}</p>
          </div>
        </div>
        <Button variant="outline" className="mt-4" onClick={() => router.push("/resources")}>
          返回列表
        </Button>
      </div>
    )
  }

  if (!resource) return null

  const Icon = typeIcons[resource.type] ?? Package

  return (
    <div className="container mx-auto px-4 py-6 max-w-4xl space-y-6">
      {/* Back nav */}
      <Button variant="ghost" size="sm" onClick={() => router.push("/resources")}>
        <ArrowLeft className="mr-2 h-4 w-4" />
        返回列表
      </Button>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Icon className="h-8 w-8 text-muted-foreground" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{resource.name}</h1>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="secondary">{resource.type}</Badge>
              <span className="text-sm text-muted-foreground">v{resource.version}</span>
              {resource.installed ? (
                <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
                  <CheckCircle2 className="mr-1 h-3 w-3" />
                  已安装
                </Badge>
              ) : (
                <Badge variant="outline">
                  <Circle className="mr-1 h-3 w-3" />
                  未安装
                </Badge>
              )}
            </div>
          </div>
        </div>
        {resource.installed && (
          <Button variant="destructive" size="sm" onClick={() => setUninstallOpen(true)}>
            <Trash2 className="mr-2 h-4 w-4" />
            卸载
          </Button>
        )}
      </div>

      {/* Tabs */}
      <Tabs value={tabParam} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="deps">依赖</TabsTrigger>
          <TabsTrigger value="audit">审计</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          {/* Info Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">基本信息</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">名称</dt>
                  <dd className="font-medium">{resource.name}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">类型</dt>
                  <dd>{resource.type}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">版本</dt>
                  <dd>{resource.version}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">来源</dt>
                  <dd className="font-mono text-xs">
                    {resource.source.type === "builtin"
                      ? `builtin:${resource.source.name}`
                      : `local:${resource.source.path}`}
                  </dd>
                </div>
                {resource.installPath && (
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">安装路径</dt>
                    <dd className="font-mono text-xs">{resource.installPath}</dd>
                  </div>
                )}
                {resource.contentHash && (
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">内容哈希</dt>
                    <dd className="font-mono text-xs">{resource.contentHash.slice(0, 16)}...</dd>
                  </div>
                )}
                <div>
                  <dt className="text-muted-foreground">注册时间</dt>
                  <dd className="text-xs">{new Date(resource.createdAt).toLocaleString("zh-CN")}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">更新时间</dt>
                  <dd className="text-xs">{new Date(resource.updatedAt).toLocaleString("zh-CN")}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          {/* Description */}
          {resource.description && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">描述</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{resource.description}</p>
              </CardContent>
            </Card>
          )}

          {/* Tags */}
          {resource.tags && resource.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {resource.tags.map((tag) => (
                <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="deps">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">依赖关系</CardTitle>
            </CardHeader>
            <CardContent>
              <DependencyTree forward={deps.forward} reverse={deps.reverse} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">审计记录</CardTitle>
            </CardHeader>
            <CardContent>
              <AuditTable entries={entries} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Uninstall Dialog */}
      <UninstallConfirmDialog
        name={name}
        type={type}
        open={uninstallOpen}
        onOpenChange={setUninstallOpen}
        onSuccess={refetch}
      />
    </div>
  )
}
