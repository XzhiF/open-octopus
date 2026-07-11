"use client"

import { useState, useEffect, useCallback } from "react"
import { cn } from "@/lib/utils"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { FolderGit2, RefreshCw, Trash2, Plus } from "lucide-react"
import { listSources, updateSource, removeSource } from "@/lib/resource/api"
import { PageState } from "./PageState"
import { SourceAddDialog } from "./source-add-dialog"

interface SourceEntry {
  name: string
  url: string
  branch: string
  resourceCount: { skills: number; agents: number; workflows: number }
  addedAt: string
  lastUpdated: string
  cachePath: string
  trusted: boolean
}

export function SourceList() {
  const [sources, setSources] = useState<SourceEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [updating, setUpdating] = useState<string | null>(null)

  const fetchSources = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await listSources()
      setSources(res.sources)
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载来源列表失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSources()
  }, [fetchSources])

  const handleUpdate = async (name: string) => {
    setUpdating(name)
    try {
      await updateSource(name)
      fetchSources()
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失败")
    } finally {
      setUpdating(null)
    }
  }

  const handleRemove = async (name: string) => {
    if (!confirm(`确定移除来源 ${name}？已安装的资源不受影响。`)) return
    try {
      await removeSource(name)
      fetchSources()
    } catch (err) {
      setError(err instanceof Error ? err.message : "移除失败")
    }
  }

  return (
    <div aria-label="来源管理">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FolderGit2 className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm font-medium">集合源管理</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchSources} disabled={loading} aria-label="刷新">
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
            刷新
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)} aria-label="添加来源">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            添加来源
          </Button>
        </div>
      </div>

      {loading && sources.length === 0 ? (
        <PageState status="loading" />
      ) : error ? (
        <PageState status="error" message={error} onRetry={fetchSources} />
      ) : sources.length === 0 ? (
        <PageState
          status="empty"
          title="暂无集合源"
          description="添加 Git 仓库作为集合源，批量管理 Skills、Agents、Workflows"
          icon={FolderGit2}
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-48">名称</TableHead>
                <TableHead>URL</TableHead>
                <TableHead className="w-32">资源数</TableHead>
                <TableHead className="w-36">更新时间</TableHead>
                <TableHead className="w-16">信任</TableHead>
                <TableHead className="w-24">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map((s) => (
                <TableRow key={s.name}>
                  <TableCell className="text-sm font-medium">{s.name}</TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground truncate max-w-xs">
                    {s.url || "-"}
                  </TableCell>
                  <TableCell className="text-sm">
                    <Badge variant="secondary" className="text-xs">
                      {s.resourceCount?.agents ?? 0}a {s.resourceCount?.skills ?? 0}s
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {s.lastUpdated ? new Date(s.lastUpdated).toLocaleDateString("zh-CN") : "-"}
                  </TableCell>
                  <TableCell>
                    {s.trusted ? (
                      <Badge variant="outline" className="text-green-600 text-xs">✓</Badge>
                    ) : (
                      <Badge variant="outline" className="text-red-600 text-xs">✗</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleUpdate(s.name)}
                        disabled={updating === s.name}
                        aria-label={`更新 ${s.name}`}
                      >
                        <RefreshCw className={cn("h-3.5 w-3.5", updating === s.name && "animate-spin")} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemove(s.name)}
                        aria-label={`移除 ${s.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <SourceAddDialog open={addOpen} onOpenChange={setAddOpen} onSuccess={fetchSources} />
    </div>
  )
}
