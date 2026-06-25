"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { createWorkspace, listOrgs, fetchManifestRepos } from "@/lib/api-client"
import { toast } from "sonner"
import { ChevronDown, ChevronRight, Search, X } from "lucide-react"

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

interface ManifestRepo {
  name: string
  git_url: string
  branch: string
  group: string
}

interface CreateWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: () => void
}

const GROUP_LABELS: Record<string, string> = {
  xzf: "xzf",
}

export function CreateWorkspaceDialog({ open, onOpenChange, onCreated }: CreateWorkspaceDialogProps) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [branch, setBranch] = useState("")
  const [org, setOrg] = useState("")
  const [orgs, setOrgs] = useState<{ id: number; name: string; path: string }[]>([])
  const [loadingOrgs, setLoadingOrgs] = useState(true)
  const [isLoading, setIsLoading] = useState(false)

  // Repo selection state
  const [repos, setRepos] = useState<ManifestRepo[]>([])
  const [selectedRepos, setSelectedRepos] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [repoError, setRepoError] = useState<string | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})

  useEffect(() => {
    listOrgs().then(data => {
      setOrgs(data)
      if (data.length > 0) setOrg(data[0].name)
      setLoadingOrgs(false)
    })
  }, [])

  // Load repos when org changes
  useEffect(() => {
    if (!org) return
    setSelectedRepos([])
    setRepos([])
    setRepoError(null)
    setLoadingRepos(true)

    fetchManifestRepos(org)
      .then(data => {
        const all: ManifestRepo[] = []
        for (const [group, entries] of Object.entries(data.groups)) {
          for (const entry of entries as any[]) {
            all.push({ ...entry, group })
          }
        }
        setRepos(all)
        setExpandedGroups(
          Object.keys(data.groups).reduce(
            (acc, g) => ({ ...acc, [g]: true }),
            {} as Record<string, boolean>
          )
        )
      })
      .catch(() => setRepoError("加载失败"))
      .finally(() => setLoadingRepos(false))
  }, [org])

  const nameError = useMemo(() => {
    if (!name) return null
    if (!NAME_PATTERN.test(name)) return "名称仅支持英文字母、数字、下划线和连字符"
    return null
  }, [name])

  const orgPath = orgs.find(o => o.name === org)?.path ?? ""
  const derivedPath = name ? `${orgPath}/workspaces/${name}` : ""

  // Filter repos by search query
  const filteredRepos = useMemo(() => {
    if (!searchQuery.trim()) return repos
    const q = searchQuery.toLowerCase()
    return repos.filter(
      r => r.name.toLowerCase().includes(q) || r.group.toLowerCase().includes(q)
    )
  }, [repos, searchQuery])

  // Group filtered repos
  const groupedRepos = useMemo(() => {
    const groups: Record<string, ManifestRepo[]> = {}
    for (const repo of filteredRepos) {
      if (!groups[repo.group]) groups[repo.group] = []
      groups[repo.group].push(repo)
    }
    return groups
  }, [filteredRepos])

  const toggleRepo = useCallback((fullName: string) => {
    setSelectedRepos(prev =>
      prev.includes(fullName)
        ? prev.filter(r => r !== fullName)
        : [...prev, fullName]
    )
  }, [])

  const removeRepo = useCallback((fullName: string) => {
    setSelectedRepos(prev => prev.filter(r => r !== fullName))
  }, [])

  const toggleGroup = useCallback((group: string) => {
    setExpandedGroups(prev => ({ ...prev, [group]: !prev[group] }))
  }, [])

  const retryLoadRepos = useCallback(() => {
    if (!org) return
    setRepoError(null)
    setLoadingRepos(true)
    fetchManifestRepos(org)
      .then(data => {
        const all: ManifestRepo[] = []
        for (const [group, entries] of Object.entries(data.groups)) {
          for (const entry of entries as any[]) {
            all.push({ ...entry, group })
          }
        }
        setRepos(all)
        setExpandedGroups(
          Object.keys(data.groups).reduce(
            (acc, g) => ({ ...acc, [g]: true }),
            {} as Record<string, boolean>
          )
        )
      })
      .catch(() => setRepoError("加载失败"))
      .finally(() => setLoadingRepos(false))
  }, [org])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (nameError) return
    setIsLoading(true)

    try {
      await createWorkspace({
        name,
        org,
        description: description || undefined,
        path: derivedPath,
        repos: selectedRepos.length > 0 ? selectedRepos : undefined,
        branch: branch || undefined,
      })
      toast.success(`工作空间 "${name}" 创建成功`)
      setName("")
      setDescription("")
      setBranch("")
      setSelectedRepos([])
      onCreated?.()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建工作空间失败")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>新建工作空间</DialogTitle>
          <DialogDescription>
            创建一个新的工作空间来管理您的项目和工作流。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col overflow-hidden">
          <div className="grid gap-4 py-4 flex-1 overflow-y-auto pr-1">
            {/* Name */}
            <div className="grid gap-2">
              <Label htmlFor="name">名称</Label>
              <Input
                id="name"
                placeholder="例如：my-project"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              {nameError ? (
                <p className="text-xs text-destructive">{nameError}</p>
              ) : name ? (
                <p className="text-xs text-muted-foreground">
                  路径：{derivedPath || "---"}
                </p>
              ) : null}
            </div>

            {/* Org */}
            <div className="grid gap-2">
              <Label htmlFor="org">组织</Label>
              <select
                id="org"
                value={org}
                onChange={(e) => setOrg(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                disabled={loadingOrgs}
                required
              >
                {loadingOrgs && <option>加载中...</option>}
                {orgs.map(o => (
                  <option key={o.id} value={o.name}>{o.name}</option>
                ))}
              </select>
            </div>

            {/* Description */}
            <div className="grid gap-2">
              <Label htmlFor="description">描述</Label>
              <Textarea
                id="description"
                placeholder="简要描述这个工作空间的用途..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>

            {/* Branch */}
            <div className="grid gap-2">
              <Label htmlFor="branch">分支名 <span className="text-xs text-muted-foreground">(可选，默认使用工作空间名)</span></Label>
              <Input
                id="branch"
                placeholder={name || "默认使用工作空间名"}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            </div>

            {/* Repo Selection */}
            <div className="grid gap-2">
              <Label>选择项目</Label>

              {/* Search input */}
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="搜索项目名称或分组..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                  disabled={loadingRepos || !!repoError}
                />
                {loadingRepos && (
                  <Spinner className="absolute right-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                )}
              </div>

              {/* Selected repos as removable badges */}
              {selectedRepos.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {selectedRepos.map(fullName => {
                    const repo = repos.find(r => `${r.group}/${r.name}` === fullName)
                    return (
                      <Badge
                        key={fullName}
                        variant="secondary"
                        className="cursor-pointer gap-1 pr-0.5"
                        onClick={() => removeRepo(fullName)}
                      >
                        {repo?.name ?? fullName}
                        <X className="h-3 w-3" />
                      </Badge>
                    )
                  })}
                  <span className="text-xs text-muted-foreground self-center">
                    已选 {selectedRepos.length} 个项目
                  </span>
                </div>
              )}

              {/* Error state */}
              {repoError && (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-destructive">
                  <span>{repoError}，点击重试</span>
                  <Button variant="outline" size="sm" onClick={retryLoadRepos}>
                    重试
                  </Button>
                </div>
              )}

              {/* Loading skeleton */}
              {loadingRepos && !repoError && (
                <div className="space-y-3">
                  {[0, 1, 2].map(i => (
                    <div key={i} className="space-y-2">
                      <Skeleton className="h-5 w-32" />
                      <Skeleton className="h-8 w-full" />
                      <Skeleton className="h-8 w-full" />
                    </div>
                  ))}
                </div>
              )}

              {/* Repo list grouped */}
              {!loadingRepos && !repoError && (
                <ScrollArea className="h-[260px] rounded-md border">
                  <div className="p-3 space-y-2">
                    {Object.keys(groupedRepos).length === 0 && (
                      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                        {searchQuery.trim() ? "无匹配项目" : repos.length === 0 ? "暂无可用项目" : "无匹配项目"}
                      </div>
                    )}
                    {Object.entries(groupedRepos).map(([group, groupRepos]) => {
                      const label = GROUP_LABELS[group] ?? group
                      const isExpanded = expandedGroups[group] ?? true
                      const allSelected = groupRepos.every(
                        r => selectedRepos.includes(`${r.group}/${r.name}`)
                      )
                      const someSelected = groupRepos.some(
                        r => selectedRepos.includes(`${r.group}/${r.name}`)
                      )

                      const toggleGroupSelect = () => {
                        const fullNames = groupRepos.map(r => `${r.group}/${r.name}`)
                        if (allSelected) {
                          setSelectedRepos(prev => prev.filter(n => !fullNames.includes(n)))
                        } else {
                          setSelectedRepos(prev => [...new Set([...prev, ...fullNames])])
                        }
                      }

                      return (
                        <Collapsible
                          key={group}
                          open={isExpanded}
                          onOpenChange={() => toggleGroup(group)}
                        >
                          <div className="flex items-center gap-2">
                            <CollapsibleTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-6 px-1">
                                {isExpanded ? (
                                  <ChevronDown className="h-4 w-4" />
                                ) : (
                                  <ChevronRight className="h-4 w-4" />
                                )}
                              </Button>
                            </CollapsibleTrigger>
                            <Checkbox
                              checked={allSelected ? true : someSelected ? "indeterminate" : false}
                              onCheckedChange={toggleGroupSelect}
                              className="translate-y-0"
                            />
                            <span className="text-sm font-medium">{label}</span>
                            <span className="text-xs text-muted-foreground">
                              ({groupRepos.length})
                            </span>
                          </div>
                          <CollapsibleContent>
                            <div className="ml-7 mt-1 space-y-1.5">
                              {groupRepos.map(repo => {
                                const fullName = `${repo.group}/${repo.name}`
                                const isSelected = selectedRepos.includes(fullName)
                                return (
                                  <label
                                    key={fullName}
                                    className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent cursor-pointer"
                                  >
                                    <Checkbox
                                      checked={isSelected}
                                      onCheckedChange={() => toggleRepo(fullName)}
                                    />
                                    <span className="text-sm">{repo.name}</span>
                                    {repo.branch !== "master" && (
                                      <span className="text-xs text-muted-foreground">
                                        [{repo.branch}]
                                      </span>
                                    )}
                                  </label>
                                )
                              })}
                            </div>
                          </CollapsibleContent>
                        </Collapsible>
                      )
                    })}
                  </div>
                </ScrollArea>
              )}
            </div>
          </div>
          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isLoading}
            >
              取消
            </Button>
            <Button type="submit" disabled={isLoading || !name || !!nameError}>
              {isLoading ? "创建中..." : "创建工作空间"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}