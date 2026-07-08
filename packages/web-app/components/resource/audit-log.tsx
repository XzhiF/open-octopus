"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ScrollText, Download, RefreshCw } from "lucide-react"
import { useResourceOrg } from "./resource-context"
import { PageState } from "./PageState"
import { useAuditLog } from "@/hooks/use-audit-log"

export function AuditLog() {
  const org = useResourceOrg()
  const [last, setLast] = useState(50)
  const [actionFilter, setActionFilter] = useState<string>("all")

  const { records: entries, loading, error, refresh } = useAuditLog(org, {
    last,
    action: actionFilter,
  })

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" })
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
      <div className="mb-4 flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">动作:</span>
          <Select value={actionFilter} onValueChange={setActionFilter}>
            <SelectTrigger className="w-32" aria-label="按动作过滤">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="install">安装</SelectItem>
              <SelectItem value="uninstall">卸载</SelectItem>
              <SelectItem value="verify">验证</SelectItem>
              <SelectItem value="install_blocked">安装阻止</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">条数:</span>
          <Select value={String(last)} onValueChange={(v) => setLast(Number(v))}>
            <SelectTrigger className="w-20" aria-label="显示条数">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="20">20</SelectItem>
              <SelectItem value="50">50</SelectItem>
              <SelectItem value="100">100</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading} aria-label="刷新审计日志">
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
          刷新
        </Button>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={entries.length === 0} aria-label="导出JSON">
          <Download className="mr-1.5 h-3.5 w-3.5" />
          导出 JSON
        </Button>
      </div>

      {/* Table */}
      {loading && entries.length === 0 ? (
        <PageState status="loading" />
      ) : error ? (
        <PageState status="error" message={error} onRetry={refresh} />
      ) : entries.length === 0 ? (
        <PageState status="empty" title="暂无审计日志" icon={ScrollText} />
      ) : (
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
              {entries.map((entry, i) => (
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
                      {(entry.caller || "unknown").toUpperCase()}
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
      )}
    </div>
  )
}
