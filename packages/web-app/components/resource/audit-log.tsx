"use client"

import { useState, useEffect } from "react"
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
import { getAuditLog } from "@/lib/resource/api"
import type { ResourceAuditRecord } from "@/lib/resource/types"
import { useResourceOrg } from "./resource-context"

export function AuditLog() {
  const org = useResourceOrg()
  const [entries, setEntries] = useState<ResourceAuditRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [last, setLast] = useState(50)
  const [actionFilter, setActionFilter] = useState<string>("all")

  const fetchAudit = async () => {
    setLoading(true)
    try {
      const res = await getAuditLog(org, {
        last,
        action: actionFilter === "all" ? undefined : actionFilter,
      })
      setEntries(res.records)
    } catch {
      // API not ready
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAudit()
  }, [last, actionFilter])

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
    <div>
      {/* Filters */}
      <div className="mb-4 flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">动作:</span>
          <Select value={actionFilter} onValueChange={setActionFilter}>
            <SelectTrigger className="w-32">
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
            <SelectTrigger className="w-20">
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
        <Button variant="outline" size="sm" onClick={fetchAudit} disabled={loading}>
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
          刷新
        </Button>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={entries.length === 0}>
          <Download className="mr-1.5 h-3.5 w-3.5" />
          导出 JSON
        </Button>
      </div>

      {/* Table */}
      {loading && entries.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
          加载中...
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
          <ScrollText className="mb-3 h-8 w-8 opacity-50" />
          <p className="font-medium">暂无审计日志</p>
        </div>
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
                    {new Date(entry.timestamp).toLocaleString("zh-CN")}
                  </TableCell>
                  <TableCell>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
                      {entry.action}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    {entry.resource_name}
                    <span className="ml-1 text-xs text-muted-foreground">({entry.resource_type})</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={entry.caller === "cli" ? "outline" : "default"} className="text-xs">
                      {entry.caller.toUpperCase()}
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
