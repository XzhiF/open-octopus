"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Loader2 } from "lucide-react"

interface WorkspaceOption {
  id: string
  name: string
}

interface WorkspaceSelectProps {
  value: string
  onChange: (v: string) => void
  error?: string
  disabled?: boolean
}

export function WorkspaceSelect({
  value,
  onChange,
  error,
  disabled,
}: WorkspaceSelectProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    import("@/lib/api-client").then(({ listWorkspaces }) => {
      listWorkspaces()
        .then((ws: WorkspaceOption[]) => {
          if (!cancelled) setWorkspaces(ws)
        })
        .catch(() => {
          if (!cancelled) setWorkspaces([])
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    })

    return () => {
      cancelled = true
    }
  }, [])

  const filtered = search
    ? workspaces.filter((ws) =>
        ws.name.toLowerCase().includes(search.toLowerCase())
      )
    : workspaces

  if (loading) {
    return (
      <div className="flex h-9 items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        加载中...
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger
          className={cn("w-full", error && "border-destructive")}
        >
          <SelectValue placeholder="选择 Workspace" />
        </SelectTrigger>
        <SelectContent>
          <div className="border-b px-2 py-1.5">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索..."
              className="h-7 text-xs"
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              无可用 Workspace
            </p>
          ) : (
            filtered.map((ws) => (
              <SelectItem key={ws.id} value={ws.id}>
                {ws.name}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}

interface WorkflowRefInputProps {
  workspaceId: string
  value: string
  onChange: (v: string) => void
  error?: string
  disabled?: boolean
}

export function WorkflowRefInput({
  value,
  onChange,
  error,
  disabled,
}: WorkflowRefInputProps) {
  return (
    <div className="space-y-1.5">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="例如: workflows/daily-report.yaml"
        disabled={disabled}
        className={cn(error && "border-destructive")}
        aria-invalid={!!error}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
