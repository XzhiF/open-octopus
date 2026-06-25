"use client"

import { useEffect, useMemo, useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  Search,
  X,
  Loader2,
  AlertCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { fetchManifestRepos } from "@/lib/api-client"

interface ManifestRepo {
  name: string
  git_url: string
  branch: string
  group: string
}

export interface SelectedProject {
  name: string
  source_path: string
  group: string
}

interface ProjectSelectorProps {
  org: string
  value: SelectedProject[]
  onChange: (projects: SelectedProject[]) => void
  disabled?: boolean
}

export function ProjectSelector({
  org,
  value,
  onChange,
  disabled,
}: ProjectSelectorProps) {
  const [repos, setRepos] = useState<ManifestRepo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // Load repos when org changes
  useEffect(() => {
    if (!org) {
      setRepos([])
      return
    }
    setLoading(true)
    setError(null)
    fetchManifestRepos(org)
      .then((data: { groups: Record<string, Array<{ name: string; git_url: string; branch: string }>> }) => {
        const all: ManifestRepo[] = []
        for (const [group, entries] of Object.entries(data.groups)) {
          for (const entry of entries) {
            all.push({ ...entry, group })
          }
        }
        setRepos(all)
        // Auto-expand all groups
        setExpandedGroups(new Set(Object.keys(data.groups)))
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "加载失败")
      })
      .finally(() => setLoading(false))
  }, [org])

  const selectedIds = useMemo(
    () => new Set(value.map((p) => `${p.group}/${p.name}`)),
    [value]
  )

  const filteredRepos = useMemo(() => {
    if (!search) return repos
    const q = search.toLowerCase()
    return repos.filter(
      (r) => r.name.toLowerCase().includes(q) || r.group.toLowerCase().includes(q)
    )
  }, [repos, search])

  const groupedRepos = useMemo(() => {
    const groups: Record<string, ManifestRepo[]> = {}
    for (const repo of filteredRepos) {
      if (!groups[repo.group]) groups[repo.group] = []
      groups[repo.group].push(repo)
    }
    return groups
  }, [filteredRepos])

  const toggleGroup = (group: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      next.has(group) ? next.delete(group) : next.add(group)
      return next
    })
  }

  const toggleRepo = (repo: ManifestRepo) => {
    const id = `${repo.group}/${repo.name}`
    if (selectedIds.has(id)) {
      onChange(value.filter((p) => `${p.group}/${p.name}` !== id))
    } else {
      onChange([
        ...value,
        {
          name: repo.name,
          source_path: "", // Will be resolved server-side from repos/index.md
          group: repo.group,
        },
      ])
    }
  }

  const toggleGroupAll = (group: string, groupRepos: ManifestRepo[]) => {
    const allSelected = groupRepos.every((r) =>
      selectedIds.has(`${r.group}/${r.name}`)
    )
    if (allSelected) {
      // Deselect all in group
      const groupIds = new Set(groupRepos.map((r) => `${r.group}/${r.name}`))
      onChange(value.filter((p) => !groupIds.has(`${p.group}/${p.name}`)))
    } else {
      // Select all in group
      const existing = new Set(value.map((p) => `${p.group}/${p.name}`))
      const toAdd = groupRepos
        .filter((r) => !existing.has(`${r.group}/${r.name}`))
        .map((r) => ({
          name: r.name,
          source_path: "",
          group: r.group,
        }))
      onChange([...value, ...toAdd])
    }
  }

  const removeProject = (index: number) => {
    onChange(value.filter((_, i) => i !== index))
  }

  return (
    <div className="space-y-3">
      {/* Selected projects */}
      {value.length > 0 && (
        <div className="space-y-1 rounded-lg border p-3">
          <Label className="text-xs text-muted-foreground">
            已选项目 ({value.length})
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {value.map((proj, i) => (
              <Badge
                key={`${proj.group}/${proj.name}`}
                variant="secondary"
                className="gap-1 pr-1"
              >
                {proj.group}/{proj.name}
                {!disabled && (
                  <button
                    type="button"
                    className="ml-0.5 rounded-full hover:bg-muted-foreground/20"
                    onClick={() => removeProject(i)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Repo browser */}
      <div className="space-y-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-7 text-xs"
            placeholder="搜索项目..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={disabled || loading}
          />
        </div>

        {loading && (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            加载项目列表...
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            <AlertCircle className="h-3 w-3" />
            {error}
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => {
                setLoading(true)
                setError(null)
                fetchManifestRepos(org)
                  .then((data: { groups: Record<string, Array<{ name: string; git_url: string; branch: string }>> }) => {
                    const all: ManifestRepo[] = []
                    for (const [group, entries] of Object.entries(data.groups)) {
                      for (const entry of entries) {
                        all.push({ ...entry, group })
                      }
                    }
                    setRepos(all)
                  })
                  .catch(() => setError("重试失败"))
                  .finally(() => setLoading(false))
              }}
            >
              重试
            </Button>
          </div>
        )}

        {!loading && !error && repos.length === 0 && org && (
          <p className="py-4 text-center text-xs text-muted-foreground">
            未找到项目。请确保已运行 <code className="text-xs">octopus setup --org {org}</code>
          </p>
        )}

        <ScrollArea className="h-[200px] rounded border">
          <div className="p-1">
            {Object.entries(groupedRepos).map(([group, groupRepos]) => {
              const allSelected = groupRepos.every((r) =>
                selectedIds.has(`${r.group}/${r.name}`)
              )
              const someSelected = groupRepos.some((r) =>
                selectedIds.has(`${r.group}/${r.name}`)
              )
              const expanded = expandedGroups.has(group)

              return (
                <Collapsible
                  key={group}
                  open={expanded}
                  onOpenChange={() => toggleGroup(group)}
                >
                  <div className="flex items-center gap-1 py-0.5">
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0">
                        {expanded ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                      </Button>
                    </CollapsibleTrigger>
                    <Checkbox
                      checked={allSelected ? true : someSelected ? "indeterminate" : false}
                      onCheckedChange={() => toggleGroupAll(group, groupRepos)}
                      disabled={disabled}
                    />
                    <span className="text-xs font-medium">{group}</span>
                    <span className="text-xs text-muted-foreground">
                      ({groupRepos.length})
                    </span>
                  </div>
                  <CollapsibleContent>
                    {groupRepos.map((repo) => {
                      const id = `${repo.group}/${repo.name}`
                      return (
                        <label
                          key={id}
                          className="flex cursor-pointer items-center gap-2 rounded px-6 py-1 text-xs hover:bg-accent"
                        >
                          <Checkbox
                            checked={selectedIds.has(id)}
                            onCheckedChange={() => toggleRepo(repo)}
                            disabled={disabled}
                          />
                          <span>{repo.name}</span>
                          <span className="ml-auto text-muted-foreground">
                            {repo.branch}
                          </span>
                        </label>
                      )
                    })}
                  </CollapsibleContent>
                </Collapsible>
              )
            })}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
