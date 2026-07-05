"use client"

import { useState, useCallback } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useResourceDetail } from "@/hooks/use-resource-detail"
import { resourceApi } from "@/lib/api-client"
import { ResourceTypeBadge } from "@/components/resources/resource-type-badge"
import { DepsTreeList } from "@/components/resources/deps-tree-list"
import { MarkdownPreview } from "@/components/resources/markdown-preview"
import { ConfirmUninstallDialog } from "@/components/resources/confirm-uninstall-dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  ArrowLeft, RefreshCw, Trash2, RotateCcw,
} from "lucide-react"
import { toast } from "sonner"
import type { DepNode } from "@/lib/types"

interface ResourceDetailProps {
  type: string
  name: string
}

export function ResourceDetail({ type, name }: ResourceDetailProps) {
  const router = useRouter()
  const { resource, loading, error, notFound, refetch } = useResourceDetail(type, name)
  const [uninstallOpen, setUninstallOpen] = useState(false)
  const [updating, setUpdating] = useState(false)

  const handleUninstall = useCallback(async () => {
    setUninstallOpen(false)
    try {
      await resourceApi.uninstall([name])
      toast.success(`${name} 已卸载`)
      router.push("/resources")
    } catch {
      toast.error(`卸载 ${name} 失败`)
    }
  }, [name, router])

  const handleUpdate = useCallback(async () => {
    if (!resource) return
    if (resource.manifest.source.protocol === "builtin") {
      toast.info("内置资源通过 octopus upgrade 更新")
      return
    }
    setUpdating(true)
    try {
      const result = await resourceApi.update([name])
      if (result.updated.length > 0) {
        toast.success(`已更新到 ${result.details?.[0]?.to ?? "最新版本"}`)
        refetch()
      } else {
        toast.info("当前已是最新版本")
      }
    } catch {
      toast.error("更新失败")
    } finally {
      setUpdating(false)
    }
  }, [resource, name, refetch])

  // Loading state
  if (loading) {
    return (
      <div className="container mx-auto space-y-6 px-4 py-6 lg:px-6">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-48 w-full max-w-2xl" />
        <Skeleton className="h-32 w-full max-w-2xl" />
        <Skeleton className="h-64 w-full max-w-3xl" />
      </div>
    )
  }

  // 404 state
  if (notFound) {
    return (
      <div className="container mx-auto space-y-6 px-4 py-6 lg:px-6">
        <Alert variant="destructive">
          <AlertDescription>
            资源 {type}/{name} 不存在
          </AlertDescription>
        </Alert>
        <Button variant="outline" asChild>
          <Link href="/resources">返回列表</Link>
        </Button>
      </div>
    )
  }

  // Error state
  if (error || !resource) {
    return (
      <div className="container mx-auto space-y-6 px-4 py-6 lg:px-6">
        <Alert variant="destructive">
          <AlertDescription className="flex items-center gap-2">
            <span>{error ?? "加载失败"}</span>
            <Button variant="outline" size="sm" onClick={refetch} className="gap-1.5">
              <RotateCcw className="size-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  const { manifest, installedAt } = resource
  const isBuiltin = manifest.source.protocol === "builtin"
  const sourceRef = `${manifest.source.protocol}:${manifest.source.location}`

  return (
    <div className="container mx-auto space-y-6 px-4 py-6 lg:px-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/resources" className="hover:text-foreground transition-colors">
          资源管理
        </Link>
        <span>/</span>
        <span>{type}</span>
        <span>/</span>
        <span className="text-foreground">{name}</span>
      </div>

      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">{manifest.name}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <ResourceTypeBadge type={manifest.type} />
            <Badge variant="outline" className="font-mono text-xs">v{manifest.version}</Badge>
            <Badge variant="secondary" className="text-xs font-mono">{sourceRef}</Badge>
          </div>
          {manifest.description && (
            <p className="text-muted-foreground">{manifest.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={handleUpdate}
            disabled={updating}
            className="gap-1.5"
          >
            <RefreshCw className={`size-3.5 ${updating ? "animate-spin" : ""}`} />
            {updating ? "检查中..." : "更新"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setUninstallOpen(true)}
            disabled={isBuiltin}
            className="gap-1.5 text-destructive hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
            卸载
          </Button>
        </div>
      </div>

      <Separator />

      {/* Metadata */}
      <div className="max-w-2xl space-y-4">
        <h2 className="text-lg font-semibold">元数据</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-y-3 gap-x-4 text-sm">
          <dt className="text-muted-foreground">安装时间</dt>
          <dd>{new Date(installedAt).toLocaleString("zh-CN")}</dd>
          <dt className="text-muted-foreground">Hash</dt>
          <dd className="font-mono text-xs break-all">{manifest.hash}</dd>
          <dt className="text-muted-foreground">来源协议</dt>
          <dd><Badge variant="outline">{manifest.source.protocol}</Badge></dd>
          <dt className="text-muted-foreground">来源位置</dt>
          <dd className="font-mono text-xs">{manifest.source.location}</dd>
          {manifest.source.subpath && (
            <>
              <dt className="text-muted-foreground">子路径</dt>
              <dd className="font-mono text-xs">{manifest.source.subpath}</dd>
            </>
          )}
          {manifest.tags && manifest.tags.length > 0 && (
            <>
              <dt className="text-muted-foreground">标签</dt>
              <dd className="flex flex-wrap gap-1">
                {manifest.tags.map(tag => (
                  <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                ))}
              </dd>
            </>
          )}
        </dl>
      </div>

      <Separator />

      {/* Dependencies */}
      <div className="max-w-2xl space-y-4">
        <h2 className="text-lg font-semibold">依赖关系</h2>
        <DepsTreeList
          dependencies={(manifest.dependencies ?? []).map(d => ({
            name: d.split(":").pop() ?? d,
            type: (d.split(":")[0] ?? "skill") as DepNode["type"],
            version: "—",
          }))}
          dependents={(manifest.references ?? []).map(r => ({
            name: r.split(":").pop() ?? r,
            type: (r.split(":")[0] ?? "workflow") as DepNode["type"],
            version: "—",
          }))}
        />
      </div>

      <Separator />

      {/* Documentation preview placeholder */}
      <div className="max-w-3xl space-y-4">
        <h2 className="text-lg font-semibold">文档预览</h2>
        <MarkdownPreview content={`# ${manifest.name}\n\n${manifest.description ?? "暂无文档内容"}\n\n## 来源\n\n- 协议: \`${manifest.source.protocol}\`\n- 位置: \`${manifest.source.location}\`\n- 版本: \`${manifest.version}\`\n\n## 依赖\n\n${manifest.dependencies.length > 0 ? manifest.dependencies.map(d => `- ${d}`).join("\n") : "无依赖"}`} />
      </div>

      {/* Uninstall dialog */}
      <ConfirmUninstallDialog
        resourceName={uninstallOpen ? name : null}
        onConfirm={handleUninstall}
        onCancel={() => setUninstallOpen(false)}
      />
    </div>
  )
}
