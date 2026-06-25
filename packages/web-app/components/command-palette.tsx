"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command"
import { GitBranch, Play, Settings, RefreshCw } from "lucide-react"

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workflows?: Array<{ ref: string; name: string }>
  executions?: Array<{ id: string; workflowName: string; status: string }>
  workspaceId?: string
}

const ACTIONS = [
  { id: 'run-workflow', label: '运行工作流', icon: Play, prefix: '>' },
  { id: 'refresh', label: '刷新数据', icon: RefreshCw, prefix: '>' },
  { id: 'settings', label: '设置', icon: Settings, prefix: '>' },
]

export function CommandPalette({ open, onOpenChange, workflows = [], executions = [], workspaceId }: CommandPaletteProps) {
  const router = useRouter()

  const handleSelect = (value: string) => {
    if (value.startsWith('#')) {
      const ref = value.slice(1)
      onOpenChange(false)
      router.push(`/workspaces/${workspaceId}?tab=detail&ref=${ref}`)
    } else if (value.startsWith('@')) {
      const execId = value.slice(1)
      onOpenChange(false)
      router.push(`/workspaces/${workspaceId}?tab=detail&execId=${execId}`)
    } else if (value.startsWith('>')) {
      const actionId = value.slice(1)
      onOpenChange(false)
      if (actionId === 'refresh') window.location.reload()
    }
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="搜索工作流、执行记录或操作..." />
      <CommandList>
        <CommandEmpty>无匹配结果</CommandEmpty>

        <CommandGroup heading="操作">
          {ACTIONS.map(action => (
            <CommandItem key={action.id} value={`>${action.id}`}>
              <action.icon className="mr-2 h-4 w-4" />
              {action.label}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading="工作流">
          {workflows.map(wf => (
            <CommandItem key={wf.ref} value={`#${wf.ref}`} onSelect={handleSelect}>
              <GitBranch className="mr-2 h-4 w-4" />
              {wf.name || wf.ref}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading="执行记录">
          {executions.slice(0, 20).map(exec => (
            <CommandItem key={exec.id} value={`@${exec.id}`} onSelect={handleSelect}>
              <Play className="mr-2 h-4 w-4" />
              {exec.workflowName} <span className="text-muted-foreground ml-auto text-xs">{exec.status}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}

export function useGlobalCommandPalette() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen(prev => !prev)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return { open, setOpen }
}
