'use client'

/**
 * CreateExperienceDialog — dialog for creating new experience files.
 *
 * Flow:
 * 1. Select type (project/workflow)
 * 2. Select an item from the corresponding list (repos or workflows)
 * 3. Call AI to generate initial content
 * 4. Return generated content to parent for editing
 */

import { useState, useEffect, useCallback } from 'react'
import { Loader2, Search } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { generateKnowledge, getAvailableWorkflows } from '@/lib/knowledge/api'
import { fetchManifestRepos } from '@/lib/api-client'
import type { KnowledgeFile } from '@/lib/knowledge/types'

interface ListItem {
  name: string
  /** For repos: group/name. For workflows: just name. */
  key: string
}

export interface CreateExperienceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  org: string
  existingFiles: KnowledgeFile[]
  onCreated: (filePath: string, content: string) => void
}

export function CreateExperienceDialog({
  open,
  onOpenChange,
  org,
  existingFiles,
  onCreated,
}: CreateExperienceDialogProps) {
  const [type, setType] = useState<'project' | 'workflow'>('project')
  const [items, setItems] = useState<ListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)

  // Fetch items when dialog opens or type changes
  useEffect(() => {
    if (!open) {
      setSelected(null)
      setSearch('')
      return
    }

    let cancelled = false
    setLoading(true)
    setItems([])

    const fetchItems = type === 'project'
      ? fetchManifestRepos(org).then((res) => {
          if (cancelled) return
          const groups = res.groups ?? {}
          const all: ListItem[] = []
          for (const [group, entries] of Object.entries(groups)) {
            for (const entry of entries as Array<{ name: string }>) {
              all.push({ name: entry.name, key: `${group}/${entry.name}` })
            }
          }
          setItems(all)
        })
      : getAvailableWorkflows().then((res) => {
          if (cancelled) return
          setItems((res.workflows ?? []).map((name: string) => ({ name, key: name })))
        })

    fetchItems
      .catch((err: unknown) => {
        if (cancelled) return
        toast.error(err instanceof Error ? err.message : '加载列表失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [open, org, type])

  // Reset selection when type changes
  useEffect(() => {
    setSelected(null)
  }, [type])

  const filteredItems = search
    ? items.filter((item) => item.name.toLowerCase().includes(search.toLowerCase()))
    : items

  const existingNames = new Set(
    existingFiles
      .filter((f) => f.type === type)
      .map((f) => f.name.replace(/^(projects|workflows)\//, '').replace(/\.md$/, '')),
  )

  const handleCreate = useCallback(async () => {
    if (!selected) return

    setGenerating(true)
    try {
      const result = await generateKnowledge(org, type, selected)
      onCreated(result.suggestedPath, result.content)
      onOpenChange(false)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '生成失败')
    } finally {
      setGenerating(false)
    }
  }, [org, type, selected, onCreated, onOpenChange])

  const placeholderText = type === 'project' ? '搜索项目...' : '搜索工作流...'
  const emptyText = type === 'project' ? '暂无可用项目' : '暂无可用工作流'
  const emptySearchText = type === 'project' ? '未找到匹配的项目' : '未找到匹配的工作流'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px] max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>新建经验</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 flex-1 overflow-hidden">
          {/* Type selection */}
          <RadioGroup
            value={type}
            onValueChange={(v) => setType(v as 'project' | 'workflow')}
            className="flex gap-4"
          >
            <label className="flex items-center gap-2 cursor-pointer">
              <RadioGroupItem value="project" />
              <span className="text-sm">项目经验</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <RadioGroupItem value="workflow" />
              <span className="text-sm">工作流经验</span>
            </label>
          </RadioGroup>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={placeholderText}
              className="pl-8 h-8 text-xs"
            />
          </div>

          {/* Item list */}
          <ScrollArea className="h-[260px] border border-agent-divider rounded-md">
            <div className="p-2 space-y-0.5">
              {loading ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
                  <Loader2 className="size-4 animate-spin mr-2" />
                  加载中...
                </div>
              ) : filteredItems.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground text-xs">
                  {search ? emptySearchText : emptyText}
                </div>
              ) : (
                filteredItems.map((item) => {
                  const hasExisting = existingNames.has(item.name)
                  const isSelected = selected === item.name

                  return (
                    <button
                      key={item.key}
                      onClick={() => setSelected(item.name)}
                      disabled={generating}
                      className={cn(
                        'flex items-center gap-2 w-full rounded-md px-2.5 py-2 text-sm transition-colors',
                        'hover:bg-accent',
                        isSelected
                          ? 'bg-knowledge-primary/10 text-knowledge-primary font-medium ring-1 ring-knowledge-primary/30'
                          : 'text-foreground',
                      )}
                    >
                      <span className="truncate flex-1 text-left">{item.name}</span>
                      {hasExisting && (
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          已有
                        </Badge>
                      )}
                    </button>
                  )
                })
              )}
            </div>
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={generating}>
            取消
          </Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={!selected || generating}
            className="bg-knowledge-primary hover:bg-knowledge-primary-hover text-knowledge-primary-foreground"
          >
            {generating ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                生成中...
              </>
            ) : (
              '下一步'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
