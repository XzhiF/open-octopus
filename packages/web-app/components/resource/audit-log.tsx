"use client"

import { useState, useMemo, useEffect } from "react"
import { cn } from "@/lib/utils"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ScrollText, Download, RefreshCw } from "lucide-react"
import { PageState } from "./PageState"
import { useAuditLog } from "@/hooks/use-audit-log"

const PAGE_SIZE = 20

const STORAGE_KEY = "audit-log-state"

interface AuditState {
  page: number
  actionFilter: string
  callerFilter: string
  nameFilter: string
}

function loadState(): AuditState {
  if (typeof window === "undefined") {
    return { page: 1, actionFilter: "all", callerFilter: "all", nameFilter: "" }
  }
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      return {
        page: parsed.page || 1,
        actionFilter: parsed.actionFilter || "all",
        callerFilter: parsed.callerFilter || "all",
        nameFilter: parsed.nameFilter || "",
      }
    }
  } catch {}
  return { page: 1, actionFilter: "all", callerFilter: "all", nameFilter: "" }
}

function saveState(state: AuditState) {
  if (typeof window === "undefined") return
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {}
}

export function AuditLog() {
  const [page, setPage] = useState(() => loadState().page)
  const [actionFilter, setActionFilter] = useState<string>(() => loadState().actionFilter)
  const [callerFilter, setCallerFilter] = useState<string>(() => loadState().callerFilter)
  const [nameFilter, setNameFilter] = useState(() => loadState().nameFilter)

  // Save state to sessionStorage whenever it changes
  useEffect(() => {
    saveState({ page, actionFilter, callerFilter, nameFilter })
  }, [page, actionFilter, callerFilter, nameFilter])

  // Fetch more records to support client-side pagination and filtering
  const { records: allRecords, loading, error, refresh } = useAuditLog({
    last: 1000,
    action: actionFilter === "all" ? undefined : actionFilter,
  })

  // Client-side filtering
  const filteredRecords = useMemo(() => {
    let records = allRecords
    if (callerFilter !== "all") {
      records = records.filter((r) => (r.caller || "cli") === callerFilter)
    }
    if (nameFilter.trim()) {
      const q = nameFilter.trim().toLowerCase()
      records = records.filter((r) =>
        (r.resource_name || "").toLowerCase().includes(q)
      )
    }
    return records
  }, [allRecords, callerFilter, nameFilter])

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const paginatedRecords = filteredRecords.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  )

  // Reset page when filters change
  const handleActionChange = (v: string) => { setActionFilter(v); setPage(1) }
  const handleCallerChange = (v: string) => { setCallerFilter(v); setPage(1) }
  const handleNameChange = (v: string) => { setNameFilter(v); setPage(1) }

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(filteredRecords, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div data-testid="audit-timeline" aria-label="审计日志">
      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">动作:</span>
          <Select value={actionFilter} onValueChange={handleActionChange}>
            <SelectTrigger className="w-36" aria-label="按动作过滤">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="install">安装</SelectItem>
              <SelectItem value="uninstall">卸载</SelectItem>
              <SelectItem value="verify">验证</SelectItem>
              <SelectItem value="install_blocked">安装阻止</SelectItem>
              <SelectItem value="install_or_upgrade">安装/升级</SelectItem>
              <SelectItem value="source_add">添加源</SelectItem>
              <SelectItem value="source_remove">移除源</SelectItem>
              <SelectItem value="source_sync">同步源</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">调用者:</span>
          <Select value={callerFilter} onValueChange={handleCallerChange}>
            <SelectTrigger className="w-28" aria-label="按调用者过滤">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="cli">CLI</SelectItem>
              <SelectItem value="ui">UI</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">资源名:</span>
          <Input
            value={nameFilter}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="搜索..."
            className="w-40 h-8 text-sm"
          />
        </div>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading} aria-label="刷新审计日志">
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
          刷新
        </Button>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={filteredRecords.length === 0} aria-label="导出JSON">
          <Download className="mr-1.5 h-3.5 w-3.5" />
          导出
        </Button>
      </div>

      {/* Table */}
      {loading && filteredRecords.length === 0 ? (
        <PageState status="loading" />
      ) : error ? (
        <PageState status="error" message={error} onRetry={refresh} />
      ) : filteredRecords.length === 0 ? (
        <PageState status="empty" title="暂无审计日志" icon={ScrollText} />
      ) : (
        <>
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">时间</TableHead>
                  <TableHead className="w-32">动作</TableHead>
                  <TableHead>资源</TableHead>
                  <TableHead className="w-20">调用者</TableHead>
                  <TableHead>来源</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedRecords.map((entry, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs font-mono text-muted-foreground">
                      {entry.timestamp ? new Date(entry.timestamp).toLocaleString("zh-CN") : "-"}
                    </TableCell>
                    <TableCell>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
                        {entry.action || "-"}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {entry.resource_name || "-"}
                      <span className="ml-1 text-xs text-muted-foreground">({entry.resource_type || "-"})</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={entry.caller === "cli" ? "outline" : "default"} className="text-xs">
                        {(entry.caller || "cli").toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground truncate max-w-xs">
                      {entry.source || "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                共 {filteredRecords.length} 条，第 {currentPage}/{totalPages} 页
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline" size="sm"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(1)}
                >
                  首页
                </Button>
                <Button
                  variant="outline" size="sm"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  上一页
                </Button>
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let p: number
                  if (totalPages <= 5) {
                    p = i + 1
                  } else if (currentPage <= 3) {
                    p = i + 1
                  } else if (currentPage >= totalPages - 2) {
                    p = totalPages - 4 + i
                  } else {
                    p = currentPage - 2 + i
                  }
                  return (
                    <Button
                      key={p}
                      variant={p === currentPage ? "default" : "outline"}
                      size="sm"
                      onClick={() => setPage(p)}
                    >
                      {p}
                    </Button>
                  )
                })}
                <Button
                  variant="outline" size="sm"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage(currentPage + 1)}
                >
                  下一页
                </Button>
                <Button
                  variant="outline" size="sm"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage(totalPages)}
                >
                  末页
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
