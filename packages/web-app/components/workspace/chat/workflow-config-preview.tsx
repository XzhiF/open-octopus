"use client"

import { useMemo } from "react"
import { extractWorkflowConfig } from "@/lib/workflow-config-extract"
import { AlertCircle, RefreshCw, FileJson } from "lucide-react"

interface WorkflowConfigPreviewProps {
  content: string
  onRetry?: () => void
}

export function WorkflowConfigPreview({ content, onRetry }: WorkflowConfigPreviewProps) {
  const result = useMemo(() => extractWorkflowConfig(content), [content])

  if (!result.ok && result.reason === "no_block") return null

  if (result.ok) {
    const { workspace_spec, workflow_chain, max_retain } = result.config
    return (
      <div
        data-testid="workflow-config-preview"
        className="mt-3 border border-border/70 rounded-lg overflow-hidden bg-muted/40"
      >
        <div className="flex items-center gap-2 px-3 py-2 bg-primary/10 border-b border-border/70 text-xs font-medium">
          <FileJson className="w-3.5 h-3.5" aria-hidden="true" />
          <span>WorkflowConfig 预览</span>
        </div>
        <dl className="text-xs space-y-1.5 px-3 py-2.5">
          <div className="flex gap-2">
            <dt className="text-muted-foreground shrink-0 w-24">org</dt>
            <dd className="font-mono break-all">{workspace_spec.org}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground shrink-0 w-24">branch_prefix</dt>
            <dd className="font-mono break-all">{workspace_spec.branch_prefix}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground shrink-0 w-24">workflow_chain</dt>
            <dd className="font-mono break-all">
              {workflow_chain.map((item, i) => (
                <span key={i} className="block">{i + 1}. {item.workflow_ref}</span>
              ))}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground shrink-0 w-24">max_retain</dt>
            <dd className="font-mono">{max_retain}</dd>
          </div>
        </dl>
      </div>
    )
  }

  return (
    <div
      data-testid="workflow-config-error"
      className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg border border-red-500/40 bg-red-500/10 text-xs text-red-500"
    >
      <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span className="flex-1 break-words">{result.message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          data-testid="workflow-config-retry"
          className="shrink-0 flex items-center gap-1 px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30 transition-colors"
        >
          <RefreshCw className="w-3 h-3" aria-hidden="true" />
          <span>重新生成</span>
        </button>
      )}
    </div>
  )
}
