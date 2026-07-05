"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { ChevronRight } from "lucide-react"
import type { AuditEntry } from "@/lib/types"

function formatTime(timestamp: string): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHour = Math.floor(diffMs / 3600000)
  const diffDay = Math.floor(diffMs / 86400000)

  if (diffMin < 1) return "刚刚"
  if (diffMin < 60) return `${diffMin} 分钟前`
  if (diffHour < 24) return `${diffHour} 小时前`
  if (diffDay < 7) return `${diffDay} 天前`
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
}

function getActionCategory(action: string): string {
  if (action.startsWith("resource.install") || action === "resource.installed") return "install"
  if (action.startsWith("resource.uninstall") || action === "resource.uninstalled") return "uninstall"
  if (action.startsWith("resource.update") || action === "resource.updated") return "update"
  if (action.startsWith("trust.")) return "trust"
  if (action.startsWith("security.")) return "security"
  return "update"
}

const actionColorMap: Record<string, string> = {
  install: "text-resource-audit-install bg-resource-audit-install/10",
  uninstall: "text-resource-audit-uninstall bg-resource-audit-uninstall/10",
  update: "text-resource-audit-update bg-resource-audit-update/10",
  trust: "text-resource-audit-trust bg-resource-audit-trust/10",
  security: "text-resource-audit-security bg-resource-audit-security/10",
}

interface AuditTableProps {
  entries: AuditEntry[]
}

export function AuditTable({ entries }: AuditTableProps) {
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())

  const toggleExpand = (index: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return (
    <div className="rounded-md border overflow-x-auto">
      <Table>
        <caption className="sr-only">资源操作审计日志</caption>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead className="w-[180px]">时间</TableHead>
            <TableHead className="w-[200px]">动作</TableHead>
            <TableHead>资源</TableHead>
            <TableHead className="w-[80px] hidden md:table-cell">调用者</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry, index) => {
            const isExpanded = expandedIds.has(index)
            const category = getActionCategory(entry.action)
            const colorClass = actionColorMap[category] ?? actionColorMap.update

            return (
              <tbody key={index}>
                <TableRow
                  className="cursor-pointer"
                  onClick={() => toggleExpand(index)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      toggleExpand(index)
                    }
                  }}
                  tabIndex={0}
                >
                  <TableCell className="w-8">
                    <button
                      aria-expanded={isExpanded}
                      aria-controls={`detail-${index}`}
                      className="flex items-center justify-center"
                      tabIndex={-1}
                    >
                      <ChevronRight className={cn(
                        "size-4 text-muted-foreground transition-transform",
                        isExpanded && "rotate-90"
                      )} />
                    </button>
                  </TableCell>
                  <TableCell className="w-[180px] text-sm text-muted-foreground whitespace-nowrap">
                    {formatTime(entry.timestamp)}
                  </TableCell>
                  <TableCell className="w-[200px]">
                    <Badge variant="secondary" className={cn("font-mono text-xs", colorClass)}>
                      {entry.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm font-medium">
                    {entry.resource}
                  </TableCell>
                  <TableCell className="w-[80px] hidden md:table-cell">
                    <Badge variant="outline" className="text-xs">
                      {entry.caller}
                    </Badge>
                  </TableCell>
                </TableRow>

                {isExpanded && (
                  <TableRow id={`detail-${index}`}>
                    <TableCell colSpan={5} className="p-4 bg-muted/50">
                      <pre
                        className="text-xs font-mono whitespace-pre-wrap"
                        role="region"
                        aria-label="操作详情"
                      >
                        {entry.detail ? JSON.stringify(entry.detail, null, 2) : "(无详细信息)"}
                      </pre>
                      <div className="mt-2 md:hidden">
                        <span className="text-xs text-muted-foreground">调用者: </span>
                        <Badge variant="outline" className="text-xs">{entry.caller}</Badge>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </tbody>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
