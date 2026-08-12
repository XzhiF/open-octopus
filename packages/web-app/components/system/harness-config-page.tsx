"use client"

import { useCallback } from "react"
import { toast } from "sonner"
import {
  Save,
  Loader2,
  RotateCcw,
  AlertTriangle,
  XCircle,
  ShieldCheck,
  RefreshCw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { WorkflowYamlEditor } from "@/components/workspace/workflow-yaml-editor"
import { useHarnessConfig } from "@/hooks/use-harness-config"

/**
 * Default YAML shipped with @octopus/shared.
 * Hard-coded here so the "Reset to defaults" button works without an extra API call.
 */
const SHIPPED_DEFAULTS_YAML = `detectors:
  stupid_retry:
    enabled: true
    threshold: 2
  model_mismatch:
    enabled: true
  process_conflict:
    enabled: true
  timeout_cascade:
    enabled: true
    threshold: 3

strategies:
  - match: stupid_retry
    actions:
      - type: inject_message
        message: "上次因为同样的原因失败了。请换一种方法解决。"
      - type: retry_with_hint

  - match: model_mismatch
    actions:
      - type: switch_model
        prefer: vision_capable

  - match: process_conflict
    severity: critical
    actions:
      - type: abort
        reason: "检测到进程冲突，已阻断以保护宿主进程"

  - match: timeout_cascade
    actions:
      - type: pause
        notify: true

  - match: "*"
    actions:
      - type: pause_and_notify
    delegate_to_agent: true

isolation:
  process_group: true
  port_protection: true
  pid_protection: true
  sandbox: auto
  fs_whitelist: [".", "/tmp"]
`

export function HarnessConfigPage() {
  const {
    content,
    version,
    source,
    loading,
    saving,
    loadError,
    validationErrors,
    isDirty,
    setContent,
    save,
    reset,
    reload,
    resetToDefaults,
  } = useHarnessConfig()

  const handleSave = useCallback(async () => {
    const ok = await save()
    if (ok) {
      toast.success("Harness 配置已保存，新执行将使用新配置")
    } else if (validationErrors.length > 0) {
      toast.error(`校验失败：${validationErrors.length} 个错误`)
    } else {
      toast.error("保存失败")
    }
  }, [save, validationErrors.length])

  const handleResetDefaults = useCallback(() => {
    resetToDefaults(SHIPPED_DEFAULTS_YAML)
    toast.info("已恢复默认配置（尚未保存）")
  }, [resetToDefaults])

  const handleReload = useCallback(async () => {
    await reload()
    toast.info("已重新加载配置")
  }, [reload])

  // ── Loading state ───────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // ── Error state ─────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="flex items-center justify-center h-full">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle className="text-destructive">加载失败</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{loadError}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={handleReload}
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              重试
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Main UI ─────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <ShieldCheck className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Harness 配置</h2>

        {/* Version badge */}
        <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-mono">
          v{version}
        </span>

        {/* Source indicator */}
        {source && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-muted/50 text-muted-foreground">
            {source === "defaults" ? "内置默认" : "自定义"}
          </span>
        )}

        <div className="flex-1" />

        {/* Dirty indicator */}
        {isDirty && (
          <span className="text-xs text-amber-600 flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" /> 未保存
          </span>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={handleResetDefaults}
        >
          <RotateCcw className="h-4 w-4 mr-1" />
          恢复默认
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={handleReload}
          disabled={saving}
        >
          <RefreshCw className="h-4 w-4 mr-1" />
          重新加载
        </Button>

        {isDirty && (
          <Button
            variant="ghost"
            size="sm"
            onClick={reset}
          >
            撤销
          </Button>
        )}

        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving || !isDirty}
        >
          {saving ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Save className="h-4 w-4 mr-1" />
          )}
          保存
        </Button>
      </div>

      {/* Editor */}
      <div className="flex-1 min-h-0">
        <WorkflowYamlEditor
          value={content}
          onChange={setContent}
          onSave={handleSave}
        />
      </div>

      {/* Validation errors panel */}
      {validationErrors.length > 0 && (
        <div className="border-t border-destructive/30 bg-destructive/5 px-4 py-3 max-h-48 overflow-auto">
          <h3 className="text-sm font-medium text-destructive mb-2 flex items-center gap-1">
            <XCircle className="h-4 w-4" /> 校验错误
          </h3>
          <ul className="space-y-1">
            {validationErrors.map((err, i) => (
              <li key={i} className="text-xs text-destructive/90 font-mono">
                {err.path ? (
                  <span className="text-destructive font-semibold">
                    {err.path}
                  </span>
                ) : null}
                {err.path ? ": " : ""}
                {err.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Status bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-t border-border text-xs text-muted-foreground bg-muted/20">
        {validationErrors.length === 0 ? (
          <span className="flex items-center gap-1 text-green-600">
            <ShieldCheck className="h-3 w-3" /> 配置有效
          </span>
        ) : (
          <span className="flex items-center gap-1 text-destructive">
            <XCircle className="h-3 w-3" /> {validationErrors.length} 个校验错误
          </span>
        )}
        <div className="flex-1" />
        <span>
          配置变更仅影响新的执行，正在运行的 execution 不受影响
        </span>
      </div>
    </div>
  )
}
