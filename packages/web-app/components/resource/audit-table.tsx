"use client"

import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { CheckCircle2, XCircle } from "lucide-react"
import type { AuditEntry } from "@/lib/resource/api"

interface AuditTableProps {
  entries: AuditEntry[]
}

const actionLabels: Record<string, string> = {
  install: "安装",
  uninstall: "卸载",
  register: "注册",
  gc: "清理",
  sync: "同步",
  doctor: "自检",
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
  } catch {
    return iso
  }
}

export function AuditTable({ entries }: AuditTableProps) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">暂无审计记录</p>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-36">时间</TableHead>
          <TableHead className="w-20">操作</TableHead>
          <TableHead className="w-20">类型</TableHead>
          <TableHead>资源</TableHead>
          <TableHead className="w-16">状态</TableHead>
          <TableHead>详情</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry, i) => (
          <TableRow key={`${entry.timestamp}-${i}`}>
            <TableCell className="text-xs text-muted-foreground font-mono">
              {formatTime(entry.timestamp)}
            </TableCell>
            <TableCell>
              <Badge variant="secondary" className="text-xs">
                {actionLabels[entry.action] ?? entry.action}
              </Badge>
            </TableCell>
            <TableCell className="text-xs">{entry.type}</TableCell>
            <TableCell className="font-medium text-sm">{entry.resource}</TableCell>
            <TableCell>
              {entry.status === "success" ? (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              ) : (
                <XCircle className="h-4 w-4 text-destructive" />
              )}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground max-w-xs truncate">
              {entry.detail ?? "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
