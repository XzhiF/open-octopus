"use client"

import { useCallback } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"

const ACTION_OPTIONS = [
  { value: "all", label: "全部动作" },
  { value: "resource.installed", label: "安装" },
  { value: "resource.uninstalled", label: "卸载" },
  { value: "resource.updated", label: "更新" },
  { value: "resource.registered", label: "注册" },
  { value: "trust.added", label: "添加信任" },
  { value: "trust.removed", label: "移除信任" },
  { value: "trust.blocked", label: "阻止来源" },
  { value: "security.path_traversal", label: "路径遍历" },
  { value: "security.source_blocked", label: "来源阻止" },
]

const LAST_OPTIONS = [
  { value: "20", label: "最近 20 条" },
  { value: "50", label: "最近 50 条" },
  { value: "100", label: "最近 100 条" },
]

interface AuditFilterBarProps {
  resourceNames?: string[]
}

export function AuditFilterBar({ resourceNames = [] }: AuditFilterBarProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const currentAction = searchParams.get("action") ?? "all"
  const currentResource = searchParams.get("resource") ?? "all"
  const currentLast = searchParams.get("last") ?? "20"

  const updateParam = useCallback((key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString())
    if (value === "all" || !value) params.delete(key)
    else params.set(key, value)
    router.push(`/resources/audit?${params}`)
  }, [searchParams, router])

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <Select value={currentAction} onValueChange={(v) => updateParam("action", v)}>
        <SelectTrigger className="w-full sm:w-[180px]">
          <SelectValue placeholder="全部动作" />
        </SelectTrigger>
        <SelectContent>
          {ACTION_OPTIONS.map(opt => (
            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={currentResource} onValueChange={(v) => updateParam("resource", v)}>
        <SelectTrigger className="w-full sm:w-[180px]">
          <SelectValue placeholder="全部资源" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部资源</SelectItem>
          {resourceNames.map(name => (
            <SelectItem key={name} value={name}>{name}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={currentLast} onValueChange={(v) => updateParam("last", v)}>
        <SelectTrigger className="w-full sm:w-[160px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LAST_OPTIONS.map(opt => (
            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
