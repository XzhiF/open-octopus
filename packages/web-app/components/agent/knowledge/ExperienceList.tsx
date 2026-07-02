'use client'

/**
 * ExperienceList — left panel of the experience library.
 *
 * Shows categorized knowledge files (project + workflow) with search,
 * selection highlighting, and a "新建经验" button.
 */

import { useState, useMemo } from 'react'
import { FileText, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { KnowledgeFile } from '@/lib/knowledge/types'

export interface ExperienceListProps {
  files: KnowledgeFile[]
  selectedFile: string | null
  onSelect: (path: string) => void
  onCreate: () => void
}

function displayName(name: string): string {
  return name.replace(/^(projects|workflows)\//, '').replace(/\.md$/, '')
}

export function ExperienceList({
  files,
  selectedFile,
  onSelect,
  onCreate,
}: ExperienceListProps) {
  const [search, setSearch] = useState('')
  const [globalOpen, setGlobalOpen] = useState(true)
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [workflowsOpen, setWorkflowsOpen] = useState(true)

  const { globalFiles, projectFiles, workflowFiles } = useMemo(() => {
    const filtered = search
      ? files.filter((f) => displayName(f.name).toLowerCase().includes(search.toLowerCase()))
      : files
    return {
      globalFiles: filtered.filter((f) => f.scope === 'global'),
      projectFiles: filtered.filter((f) => f.type === 'project' && f.scope !== 'global'),
      workflowFiles: filtered.filter((f) => f.type === 'workflow' && f.scope !== 'global'),
    }
  }, [files, search])

  const renderItem = (file: KnowledgeFile) => {
    const isSelected = selectedFile === file.name
    const name = displayName(file.name)

    return (
      <button
        key={file.name}
        onClick={() => onSelect(file.name)}
        className={cn(
          'flex items-center gap-2 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors',
          'hover:bg-accent',
          isSelected
            ? 'bg-knowledge-primary/10 text-knowledge-primary font-medium'
            : 'text-foreground',
        )}
      >
        <FileText className="size-3.5 text-knowledge-primary shrink-0" />
        <span className="truncate flex-1 text-left">{name}</span>
        {file.retiredCount > 0 && (
          <span className="text-[10px] text-muted-foreground shrink-0">
            {file.retiredCount}退休
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="flex flex-col h-full border-r border-agent-divider bg-agent-surface-raised">
      {/* Search */}
      <div className="p-3 border-b border-agent-divider">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索经验..."
            className="pl-8 h-8 text-xs"
          />
        </div>
      </div>

      {/* File list */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-2 space-y-1">
          {/* Global experience */}
          {globalFiles.length > 0 && (
            <Collapsible open={globalOpen} onOpenChange={setGlobalOpen}>
              <CollapsibleTrigger className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
                <span className="text-[10px]">{globalOpen ? '▾' : '▸'}</span>
                全局
                <span className="text-[10px] text-muted-foreground/60">({globalFiles.length})</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="space-y-0.5 pl-1">
                  {globalFiles.map(renderItem)}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* Project experience */}
          <Collapsible open={projectsOpen} onOpenChange={setProjectsOpen}>
            <CollapsibleTrigger className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
              <span className="text-[10px]">{projectsOpen ? '▾' : '▸'}</span>
              项目经验
              <span className="text-[10px] text-muted-foreground/60">({projectFiles.length})</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-0.5 pl-1">
                {projectFiles.length > 0 ? (
                  projectFiles.map(renderItem)
                ) : (
                  <p className="px-2.5 py-1.5 text-xs text-muted-foreground">暂无</p>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Workflow experience */}
          <Collapsible open={workflowsOpen} onOpenChange={setWorkflowsOpen}>
            <CollapsibleTrigger className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
              <span className="text-[10px]">{workflowsOpen ? '▾' : '▸'}</span>
              工作流经验
              <span className="text-[10px] text-muted-foreground/60">({workflowFiles.length})</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-0.5 pl-1">
                {workflowFiles.length > 0 ? (
                  workflowFiles.map(renderItem)
                ) : (
                  <p className="px-2.5 py-1.5 text-xs text-muted-foreground">暂无</p>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </ScrollArea>

      {/* Create button */}
      <div className="p-3 border-t border-agent-divider">
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-1.5 text-xs"
          onClick={onCreate}
        >
          <Plus className="size-3.5" />
          新建经验
        </Button>
      </div>
    </div>
  )
}
