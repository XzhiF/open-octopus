"use client"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { X } from "lucide-react"

interface FilterBarProps {
  workflow?: string
  status?: string
  from?: string
  to?: string
  workflowOptions: string[]
  onChange: (updates: Record<string, string | undefined>) => void
}

export function FilterBar({
  workflow,
  status,
  from,
  to,
  workflowOptions,
  onChange,
}: FilterBarProps) {
  const hasFilters = !!(workflow || status || from || to)

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3"
      aria-label="执行记录过滤器"
    >
      <Select
        value={workflow ?? "all"}
        onValueChange={(v) =>
          onChange({ workflow: v === "all" ? undefined : v })
        }
      >
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="工作流: 全部" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部工作流</SelectItem>
          {workflowOptions.map((w) => (
            <SelectItem key={w} value={w}>
              {w}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={status ?? "all"}
        onValueChange={(v) =>
          onChange({ status: v === "all" ? undefined : v })
        }
      >
        <SelectTrigger className="w-[140px]">
          <SelectValue placeholder="状态: 全部" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部状态</SelectItem>
          <SelectItem value="completed">已完成</SelectItem>
          <SelectItem value="failed">失败</SelectItem>
          <SelectItem value="cancelled">已取消</SelectItem>
        </SelectContent>
      </Select>

      <div className="flex items-center gap-2">
        <Input
          type="date"
          value={from ?? ""}
          onChange={(e) => onChange({ from: e.target.value || undefined })}
          className="w-[150px] h-9"
          placeholder="开始日期"
        />
        <span className="text-muted-foreground text-xs">至</span>
        <Input
          type="date"
          value={to ?? ""}
          onChange={(e) => onChange({ to: e.target.value || undefined })}
          className="w-[150px] h-9"
          placeholder="结束日期"
        />
      </div>

      {hasFilters && (
        <button
          onClick={() =>
            onChange({
              workflow: undefined,
              status: undefined,
              from: undefined,
              to: undefined,
              page: "1",
            })
          }
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" /> 清除过滤
        </button>
      )}
    </div>
  )
}
