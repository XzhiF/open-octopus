"use client"

import { useState, useCallback } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { useToast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"
import { exportDashboard } from "@/lib/scheduler-api"
import { Loader2, Download } from "lucide-react"

interface ExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type TimeRange = "24h" | "7d" | "30d" | "custom"
type ExportFormat = "csv" | "pdf"
type DataScope = "all" | "failed"

const TIME_RANGES: { value: TimeRange; label: string }[] = [
  { value: "24h", label: "24 小时" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
]

export function ExportDialog({ open, onOpenChange }: ExportDialogProps) {
  const { toast } = useToast()
  const [format, setFormat] = useState<ExportFormat>("csv")
  const [timeRange, setTimeRange] = useState<TimeRange>("7d")
  const [scope, setScope] = useState<DataScope>("all")
  const [exporting, setExporting] = useState(false)

  const handleExport = useCallback(async () => {
    setExporting(true)
    try {
      const blob = await exportDashboard({
        format,
        range: timeRange,
        scope,
      })

      // Trigger download
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `scheduler-report-${timeRange}.${format}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      toast({ title: "导出成功" })
      onOpenChange(false)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "导出失败"
      toast({
        title: "导出失败",
        description: msg,
        variant: "destructive",
      })
    } finally {
      setExporting(false)
    }
  }, [format, timeRange, scope, toast, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>导出报表</DialogTitle>
          <DialogDescription>
            选择导出格式和数据范围
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Format */}
          <div className="space-y-2">
            <Label>导出格式</Label>
            <RadioGroup
              value={format}
              onValueChange={(v) => setFormat(v as ExportFormat)}
              disabled={exporting}
              className="flex gap-4"
            >
              <Label className="flex cursor-pointer items-center gap-2">
                <RadioGroupItem value="csv" />
                <span className="text-sm">CSV</span>
              </Label>
              <Label className="flex cursor-pointer items-center gap-2">
                <RadioGroupItem value="pdf" />
                <span className="text-sm">PDF</span>
              </Label>
            </RadioGroup>
          </div>

          {/* Time Range */}
          <div className="space-y-2">
            <Label>时间范围</Label>
            <div className="flex gap-1 rounded-md border p-1">
              {TIME_RANGES.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  disabled={exporting}
                  onClick={() => setTimeRange(r.value)}
                  className={cn(
                    "flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors",
                    timeRange === r.value
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          {/* Scope */}
          <div className="space-y-2">
            <Label>数据范围</Label>
            <RadioGroup
              value={scope}
              onValueChange={(v) => setScope(v as DataScope)}
              disabled={exporting}
              className="flex gap-4"
            >
              <Label className="flex cursor-pointer items-center gap-2">
                <RadioGroupItem value="all" />
                <span className="text-sm">全部</span>
              </Label>
              <Label className="flex cursor-pointer items-center gap-2">
                <RadioGroupItem value="failed" />
                <span className="text-sm">仅失败</span>
              </Label>
            </RadioGroup>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={exporting}
            >
              取消
            </Button>
            <Button onClick={handleExport} disabled={exporting}>
              {exporting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              {exporting ? "导出中..." : "导出"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
