"use client"

import { useAuditLog } from "@/hooks/use-resources"
import { AuditTable } from "@/components/resource/audit-table"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from "@/components/ui/empty"
import { Download, ClipboardList, AlertCircle, ArrowLeft } from "lucide-react"
import { useRouter } from "next/navigation"
import { getAuditExportUrl } from "@/lib/resource/api"

const actions = [
  { label: "全部操作", value: "all" },
  { label: "安装", value: "install" },
  { label: "卸载", value: "uninstall" },
  { label: "注册", value: "register" },
  { label: "清理", value: "gc" },
  { label: "同步", value: "sync" },
  { label: "自检", value: "doctor" },
]

export default function AuditLogPage() {
  const router = useRouter()
  const { entries, total, loading, error, refetch, action, setActionFilter } = useAuditLog()

  const handleExport = () => {
    window.open(getAuditExportUrl(), "_blank")
  }

  return (
    <div className="container mx-auto px-4 py-6 max-w-5xl space-y-6">
      {/* Back nav */}
      <Button variant="ghost" size="sm" onClick={() => router.push("/resources")}>
        <ArrowLeft className="mr-2 h-4 w-4" />
        返回资源列表
      </Button>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">审计日志</h1>
          <p className="text-sm text-muted-foreground">
            资源操作历史，共 {total} 条记录
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleExport}>
          <Download className="mr-2 h-4 w-4" />
          导出 JSON
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Select
          value={action ?? "all"}
          onValueChange={(v) => setActionFilter(v === "all" ? undefined : v)}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="操作类型" />
          </SelectTrigger>
          <SelectContent>
            {actions.map((a) => (
              <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Content */}
      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}

      {error && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AlertCircle className="text-destructive" />
            </EmptyMedia>
            <EmptyTitle>加载失败</EmptyTitle>
            <EmptyDescription>{error.message}</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" onClick={refetch}>重试</Button>
        </Empty>
      )}

      {!loading && !error && entries.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ClipboardList />
            </EmptyMedia>
            <EmptyTitle>暂无审计记录</EmptyTitle>
            <EmptyDescription>
              安装或卸载资源后，操作记录将显示在这里
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {!loading && !error && entries.length > 0 && (
        <AuditTable entries={entries} />
      )}
    </div>
  )
}
