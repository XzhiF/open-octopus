"use client"

import { useState, useEffect, useCallback } from "react"
import { Database, Plus, RefreshCw, Download, FileText, Loader2, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { toast } from "sonner"
import { OrgSelector } from "@/components/system/org-selector"
import { RepoEditDialog } from "@/components/system/repo-edit-dialog"
import { useOrgs } from "@/hooks/useOrgs"
import type { ManifestEntry } from "@octopus/shared"

interface ReposResponse {
  groups: Record<string, ManifestEntry[]>
  org: string
}

export default function SystemReposPage() {
  const { orgs } = useOrgs()
  const [selectedOrg, setSelectedOrg] = useState("")
  const [data, setData] = useState<ReposResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [editEntry, setEditEntry] = useState<ManifestEntry | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [gitLoading, setGitLoading] = useState<Record<string, boolean>>({})
  const [batchLoading, setBatchLoading] = useState<Record<string, boolean>>({})

  // Initialize with first org when orgs load
  useEffect(() => {
    if (orgs.length > 0 && !selectedOrg) {
      setSelectedOrg(orgs[0].name)
    }
  }, [orgs, selectedOrg])

  const fetchRepos = useCallback(() => {
    if (!selectedOrg) return

    setLoading(true)
    setError(null)

    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3001"
    fetch(`${serverUrl}/api/repos?org=${encodeURIComponent(selectedOrg)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((json: ReposResponse) => {
        setData(json)
        setLoading(false)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
  }, [selectedOrg])

  // Fetch repos when org changes
  useEffect(() => {
    fetchRepos()
  }, [fetchRepos])

  function toggleGroup(group: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(group)) {
        next.delete(group)
      } else {
        next.add(group)
      }
      return next
    })
  }

  function handleRowClick(entry: ManifestEntry) {
    setEditEntry(entry)
    setDialogOpen(true)
  }

  function handleNewRepo() {
    setEditEntry(null)
    setDialogOpen(true)
  }

  async function handleGitOp(name: string, op: "clone" | "pull") {
    const key = `${name}:${op}`
    setGitLoading(prev => ({ ...prev, [key]: true }))

    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3001"
    try {
      const res = await fetch(
        `${serverUrl}/api/repos/${encodeURIComponent(name)}/${op}?org=${encodeURIComponent(selectedOrg)}`,
        { method: "POST" }
      )
      const body = await res.json()

      if (op === "clone") {
        if (body.success) {
          toast.success(`${name} 克隆成功`)
        } else {
          toast.error(`${name} 克隆失败: ${body.message}`)
        }
      } else {
        if (body.success) {
          toast.success(`${name} 已更新`)
        } else {
          toast.error(`${name} 拉取失败: ${body.message}`)
        }
      }
    } catch (err: unknown) {
      toast.error(`${name} ${op} 请求失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setGitLoading(prev => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
  }

  async function handleBatchOp(op: "pull-all" | "clone-missing") {
    setBatchLoading(prev => ({ ...prev, [op]: true }))

    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3001"
    try {
      const res = await fetch(
        `${serverUrl}/api/repos/${op}?org=${encodeURIComponent(selectedOrg)}`,
        { method: "POST" }
      )
      const body = await res.json()

      if (op === "pull-all") {
        toast.success(`Pull All: ${body.success} 成功, ${body.failed} 失败`)
      } else {
        toast.success(`Clone Missing: ${body.cloned} 成功, ${body.failed} 失败`)
      }
    } catch (err: unknown) {
      toast.error(`批量操作失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBatchLoading(prev => {
        const next = { ...prev }
        delete next[op]
        return next
      })
    }
  }

  async function handleRebuildIndex() {
    setBatchLoading(prev => ({ ...prev, "rebuild-index": true }))

    const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3001"
    try {
      const res = await fetch(
        `${serverUrl}/api/repos/rebuild-index?org=${encodeURIComponent(selectedOrg)}`,
        { method: "POST" }
      )
      const body = await res.json()

      if (body.success) {
        toast.success("Index 重建成功")
      } else {
        toast.error(`Index 重建失败: ${body.error?.message ?? body.message}`)
      }
    } catch (err: unknown) {
      toast.error(`Index 重建请求失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBatchLoading(prev => {
        const next = { ...prev }
        delete next["rebuild-index"]
        return next
      })
    }
  }

  const totalRepos = data
    ? Object.values(data.groups).reduce((sum, entries) => sum + entries.length, 0)
    : 0

  const groupNames = data ? Object.keys(data.groups) : []

  return (
    <div className="flex flex-col h-full">
      {/* Header with org selector */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <h2 className="text-lg font-semibold">仓库管理</h2>
        <div className="flex items-center gap-2 ml-4">
          <span className="text-sm text-muted-foreground">Org:</span>
          <OrgSelector value={selectedOrg} onChange={setSelectedOrg} />
        </div>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => handleBatchOp("pull-all")} disabled={!!batchLoading["pull-all"]}>
          {batchLoading["pull-all"] ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
          Pull All
        </Button>
        <Button variant="outline" size="sm" onClick={() => handleBatchOp("clone-missing")} disabled={!!batchLoading["clone-missing"]}>
          {batchLoading["clone-missing"] ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />}
          Clone Missing
        </Button>
        <Button variant="outline" size="sm" onClick={handleRebuildIndex} disabled={!!batchLoading["rebuild-index"]}>
          {batchLoading["rebuild-index"] ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FileText className="h-4 w-4 mr-1" />}
          Rebuild
        </Button>
        <Button size="sm" onClick={handleNewRepo}>
          <Plus className="h-4 w-4 mr-1" />
          新增
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <Card className="max-w-md mx-auto">
            <CardContent className="pt-6">
              <p className="text-sm text-destructive">加载失败: {error}</p>
            </CardContent>
          </Card>
        ) : totalRepos === 0 ? (
          /* Empty state */
          <div className="flex items-center justify-center h-full">
            <Card className="max-w-md w-full">
              <CardContent className="pt-6 text-center">
                <Database className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">暂无仓库记录</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  点击"新增"添加仓库，或运行 <code className="text-xs bg-muted px-1 rounded">octopus repos update</code> 同步现有配置。
                </p>
              </CardContent>
            </Card>
          </div>
        ) : (
          /* Repo list by group */
          <div className="space-y-2">
            {Object.entries(data!.groups).map(([group, entries]) => {
              const collapsed = collapsedGroups.has(group)
              return (
                <Card key={group}>
                  <CardContent className="p-0">
                    {/* Group header — clickable to toggle */}
                    <button
                      type="button"
                      className="flex items-center gap-2 w-full px-4 py-3 hover:bg-muted/50 transition-colors text-left"
                      onClick={() => toggleGroup(group)}
                    >
                      <ChevronRight
                        className={`h-4 w-4 text-muted-foreground transition-transform ${collapsed ? "" : "rotate-90"}`}
                      />
                      <span className="font-medium">{group}</span>
                      <span className="text-sm text-muted-foreground">({entries.length})</span>
                    </button>

                    {/* Entries */}
                    {!collapsed && (
                      <ul className="border-t border-border">
                        {entries.map((entry) => (
                          <li key={entry.name} className="flex items-center gap-3 px-4 py-2.5 pl-10 hover:bg-muted/50 transition-colors text-sm">
                            <button
                              type="button"
                              className="flex items-center gap-3 flex-1 min-w-0 text-left"
                              onClick={() => handleRowClick(entry)}
                            >
                              <span className="font-mono font-medium min-w-[120px]">{entry.name}</span>
                              <span className="text-muted-foreground truncate flex-1">{entry.git_url}</span>
                              <span className="text-xs px-1.5 py-0.5 rounded bg-muted shrink-0">
                                {entry.branch}
                              </span>
                              {entry.manual_tags.length > 0 && (
                                <span className="text-xs text-muted-foreground shrink-0">
                                  {entry.manual_tags.join(", ")}
                                </span>
                              )}
                            </button>
                            <div className="flex items-center gap-1 shrink-0">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                disabled={!!gitLoading[`${entry.name}:clone`]}
                                onClick={() => handleGitOp(entry.name, "clone")}
                              >
                                {gitLoading[`${entry.name}:clone`] ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3 mr-1" />}
                                Clone
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                disabled={!!gitLoading[`${entry.name}:pull`]}
                                onClick={() => handleGitOp(entry.name, "pull")}
                              >
                                {gitLoading[`${entry.name}:pull`] ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                                Pull
                              </Button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* Edit dialog */}
      <RepoEditDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entry={editEntry}
        groups={groupNames}
        org={selectedOrg}
        onSaved={fetchRepos}
      />
    </div>
  )
}
