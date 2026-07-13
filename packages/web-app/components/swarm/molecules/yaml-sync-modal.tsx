"use client"

import { useState, useCallback } from "react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Copy, Upload, Download, AlertCircle } from "lucide-react"
import { toast } from "sonner"
import yaml from "js-yaml"

export interface YamlSyncModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "export" | "import"
  yamlContent?: string
  onImport?: (parsed: Record<string, unknown>) => void
}

export function YamlSyncModal({
  open,
  onOpenChange,
  mode: initialMode,
  yamlContent = "",
  onImport,
}: YamlSyncModalProps) {
  const [activeTab, setActiveTab] = useState(initialMode)
  const [importText, setImportText] = useState("")
  const [importError, setImportError] = useState<string | null>(null)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(yamlContent)
      toast.success("YAML 已复制到剪贴板")
    } catch {
      toast.error("复制失败")
    }
  }, [yamlContent])

  const handleParse = useCallback(() => {
    setImportError(null)
    if (!importText.trim()) {
      setImportError("请输入 YAML 内容")
      return
    }

    try {
      const parsed = yaml.load(importText)

      if (!parsed || typeof parsed !== "object") {
        setImportError("YAML 内容必须是一个对象")
        return
      }

      const obj = parsed as Record<string, unknown>

      if (obj.mode && obj.mode !== "moa") {
        setImportError(`期望 mode: moa, 实际 mode: ${obj.mode}`)
        return
      }

      onImport?.(obj)
      toast.success("导入成功")
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : "未知错误"
      const lineMatch = message.match(/line (\d+)/)
      setImportError(lineMatch ? `第 ${lineMatch[1]} 行: ${message}` : message)
    }
  }, [importText, onImport, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[640px] max-w-[90vw]">
        <DialogHeader>
          <DialogTitle>YAML {activeTab === "export" ? "导出" : "导入"}</DialogTitle>
          <DialogDescription>
            {activeTab === "export" ? "查看或复制当前配置的 YAML 表示" : "粘贴 YAML 配置并解析为表单数据"}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "export" | "import")}>
          <TabsList className="grid grid-cols-2 w-full">
            <TabsTrigger value="export" className="gap-1">
              <Download className="h-3.5 w-3.5" />
              导出
            </TabsTrigger>
            <TabsTrigger value="import" className="gap-1">
              <Upload className="h-3.5 w-3.5" />
              导入
            </TabsTrigger>
          </TabsList>

          <TabsContent value="export" className="mt-3">
            <ScrollArea className="h-[400px] rounded-md border bg-muted/30 p-3">
              <pre className="font-mono text-xs whitespace-pre-wrap break-all">
                {yamlContent || "# 暂无配置"}
              </pre>
            </ScrollArea>
            <div className="flex justify-end mt-3">
              <Button size="sm" variant="outline" onClick={handleCopy} className="gap-1">
                <Copy className="h-3.5 w-3.5" />
                复制
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="import" className="mt-3">
            <Textarea
              placeholder="粘贴 YAML 配置..."
              value={importText}
              onChange={(e) => {
                setImportText(e.target.value)
                setImportError(null)
              }}
              className="font-mono text-xs h-[350px] resize-none"
            />
            {importError && (
              <div className="flex items-center gap-1.5 mt-2 text-sm text-destructive" role="alert">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span>{importError}</span>
              </div>
            )}
            <div className="flex justify-end mt-3">
              <Button size="sm" onClick={handleParse} className="gap-1">
                <Upload className="h-3.5 w-3.5" />
                解析
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
