"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ArrowLeft, RefreshCw, FolderGit2 } from "lucide-react"
import { getSource } from "@/lib/resource/api"

interface SourceDetail {
  name: string
  url: string
  branch: string
  resourceCount: { skills: number; agents: number; workflows: number }
  addedAt: string
  lastUpdated: string
  cachePath: string
  trusted: boolean
}

export function SourceDetail() {
  const params = useParams()
  const name = params.name as string

  const [source, setSource] = useState<SourceDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!name) return
    getSource(name)
      .then(setSource)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [name])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground" role="status">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
        加载中...
      </div>
    )
  }

  if (error || !source) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
        {error || "来源不存在"}
        <div className="mt-3">
          <Link href="/resources?tab=sources" className="text-sm text-muted-foreground hover:text-foreground">
            ← 返回来源列表
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div aria-label="来源详情">
      <Link
        href="/resources?tab=sources"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        返回来源列表
      </Link>

      <div className="mb-6 flex items-start gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
          <FolderGit2 className="h-7 w-7 text-muted-foreground" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold">{source.name}</h2>
            {source.trusted && <Badge variant="outline" className="text-green-600">已信任</Badge>}
          </div>
          <p className="mt-1 text-sm font-mono text-muted-foreground">{source.url}</p>
        </div>
      </div>

      <Separator className="mb-6" />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        <MetaItem label="分支" value={source.branch} mono />
        <MetaItem label="添加时间" value={new Date(source.addedAt).toLocaleDateString("zh-CN")} />
        <MetaItem label="更新时间" value={new Date(source.lastUpdated).toLocaleDateString("zh-CN")} />
        <MetaItem label="缓存路径" value={source.cachePath} mono />
        <MetaItem label="Skills" value={String(source.resourceCount.skills)} />
        <MetaItem label="Agents" value={String(source.resourceCount.agents)} />
        <MetaItem label="Workflows" value={String(source.resourceCount.workflows)} />
      </div>
    </div>
  )
}

function MetaItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-sm font-medium ${mono ? "font-mono text-xs" : ""}`}>{value}</div>
    </div>
  )
}
