"use client"

import { useEffect, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  ArrowLeft,
  Trash2,
  RefreshCw,
  ScrollText,
  BrainCircuit,
  Cog,
  Workflow,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { getResource, uninstallResource } from "@/lib/resource/api"
import { toast } from "sonner"
import type { ResourceEntry, ResourceType } from "@/lib/resource/types"
import { useResourceOrg } from "./resource-context"
import { UninstallConfirm } from "./UninstallConfirm"

const typeIcon = { skill: BrainCircuit, agent: Cog, workflow: Workflow }

export function ResourceDetail() {
  const params = useParams()
  const router = useRouter()
  const org = useResourceOrg()
  const type = params.type as string
  const name = params.name as string

  const [entry, setEntry] = useState<ResourceEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showUninstall, setShowUninstall] = useState(false)
  const [uninstalling, setUninstalling] = useState(false)

  useEffect(() => {
    if (!type || !name) return
    getResource(org, type, name)
      .then(setEntry)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [type, name])

  const handleUninstall = async () => {
    if (!entry) return
    setUninstalling(true)
    try {
      await uninstallResource(org, entry.name, entry.type)
      toast.success(`资源 ${entry.name} 已卸载`)
      router.push("/resources")
    } catch {
      setShowUninstall(false)
      setUninstalling(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground" role="status">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
        加载中...
      </div>
    )
  }

  if (error || !entry) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
        {error || "资源不存在"}
        <div className="mt-3">
          <Button variant="outline" size="sm" asChild>
            <Link href="/resources">← 返回列表</Link>
          </Button>
        </div>
      </div>
    )
  }

  const Icon = typeIcon[entry.type as ResourceType] || BrainCircuit

  return (
    <div aria-label="资源详情">
      <Link
        href="/resources"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        返回列表
      </Link>

      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div className="flex items-start gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
            <Icon className="h-7 w-7 text-muted-foreground" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold">{entry.name}</h2>
              <Badge variant="outline">{entry.type}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{entry.source}: {entry.ref}</p>
          </div>
        </div>
        <div className="flex gap-2">
          {entry.installed && (
            <Button variant="destructive" size="sm" onClick={() => setShowUninstall(true)} aria-label="卸载资源">
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              卸载
            </Button>
          )}
        </div>
      </div>

      <Separator className="mb-6" />

      {/* Tabs */}
      <Tabs defaultValue="overview">
        <TabsList aria-label="资源详情标签页">
          <TabsTrigger value="overview">概述</TabsTrigger>
          <TabsTrigger value="deps">依赖</TabsTrigger>
          <TabsTrigger value="files">文件</TabsTrigger>
          <TabsTrigger value="operations">操作</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            <MetaItem label="来源" value={entry.source} />
            <MetaItem label="引用" value={entry.ref} mono />
            <MetaItem label="安装时间" value={new Date(entry.installedAt).toLocaleDateString("zh-CN")} />
            <MetaItem
              label="状态"
              value={
                <span className={cn(
                  "inline-flex items-center gap-1",
                  entry.status === "installed" ? "text-green-600" : "text-amber-600"
                )}>
                  {entry.status === "installed"
                    ? <CheckCircle2 className="h-3.5 w-3.5" />
                    : <AlertTriangle className="h-3.5 w-3.5" />}
                  {entry.status === "installed" ? "已安装" : "已安装 (未验证)"}
                </span>
              }
            />
            <MetaItem label="范围" value={entry.scope} />
            <MetaItem label="验证" value={entry.verified ? "通过" : "未验证"} />
            {entry.installPath && <MetaItem label="安装路径" value={entry.installPath} mono />}
          </div>
          {entry.dependsOn?.length > 0 && (
            <div className="mt-6">
              <h3 className="mb-2 text-sm font-medium">依赖列表</h3>
              <div className="flex flex-wrap gap-2">
                {entry.dependsOn.map((dep) => (
                  <Badge key={dep} variant="secondary">{dep}</Badge>
                ))}
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="deps" className="mt-4">
          <p className="text-sm text-muted-foreground">
            {entry.dependsOn?.length
              ? `依赖: ${entry.dependsOn.join(", ")}`
              : "无依赖"}
          </p>
        </TabsContent>

        <TabsContent value="files" className="mt-4">
          <p className="text-sm text-muted-foreground">
            安装路径: {entry.installPath || "N/A"}
          </p>
        </TabsContent>

        <TabsContent value="operations" className="mt-4">
          <div className="flex gap-2">
            {entry.installed && (
              <Button variant="destructive" size="sm" onClick={() => setShowUninstall(true)}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                卸载
              </Button>
            )}
            <Button variant="outline" size="sm" asChild>
              <Link href="/resources?tab=audit">
                <ScrollText className="mr-1.5 h-3.5 w-3.5" />
                查看审计日志
              </Link>
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      <UninstallConfirm
        open={showUninstall}
        onOpenChange={setShowUninstall}
        name={entry.name}
        type={entry.type as ResourceType}
        onConfirm={handleUninstall}
        loading={uninstalling}
      />
    </div>
  )
}

function MetaItem({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-sm font-medium", mono && "font-mono text-xs")}>{value}</div>
    </div>
  )
}
