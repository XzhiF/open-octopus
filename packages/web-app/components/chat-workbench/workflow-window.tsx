'use client'

import { useEffect, useState } from 'react'
import { Activity, Terminal, X } from 'lucide-react'
import { fetchExecutionDetail } from '@/lib/api-client'
import type { StepExecution } from '@/lib/types'
import { WorkflowFlowViewerWithStatus } from '@/components/workspace/workflow-flow-viewer-with-status'
import { ExecutionLogViewer } from '@/components/workspace/execution-log-viewer'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

interface WorkflowWindowProps {
  workspaceId: string
  executionId: string
  title?: string
  onClose: () => void
}

/** Chat-native workflow execution window: DAG + node status + live logs. */
export function WorkflowWindow({ workspaceId, executionId, title, onClose }: WorkflowWindowProps) {
  const [detail, setDetail] = useState<{
    status: string
    workflowRef: string
    yaml: string
    steps: StepExecution[]
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'dag' | 'logs'>('dag')

  useEffect(() => {
    let alive = true
    setDetail(null)
    setError(null)
    const load = () => {
      fetchExecutionDetail(workspaceId, executionId)
        .then((data) => {
          if (!alive) return
          setDetail({
            status: data.status,
            workflowRef: data.workflow_ref,
            yaml: data.workflow_content ?? '',
            steps: (data.steps ?? []) as StepExecution[],
          })
        })
        .catch((err: unknown) => {
          if (alive) setError(err instanceof Error ? err.message : String(err))
        })
    }
    load()
    const timer = window.setInterval(load, 3000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [workspaceId, executionId])

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="ui-font flex h-[82vh] w-[92vw] max-w-[1200px] flex-col gap-0 overflow-hidden rounded-2xl border border-white/[0.10] bg-pop-bg p-0"
      >
        <DialogTitle className="sr-only">{title ?? '工作流执行'}</DialogTitle>
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3">
          <button
            type="button"
            aria-label="关闭工作流窗口"
            onClick={onClose}
            className="grid size-6 place-items-center rounded-full text-pop-dim hover:bg-white/[0.06] hover:text-pop-ink"
          >
            <X className="size-3.5" />
          </button>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-pop-ink">{title ?? detail?.workflowRef ?? '工作流执行'}</div>
            <div className="truncate font-mono text-[10px] text-pop-dim">{executionId} · {detail?.status ?? '…'}</div>
          </div>
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'dag' | 'logs')} className="ml-auto">
            <TabsList className="h-7">
              <TabsTrigger value="dag" className="h-6 gap-1 text-[10.5px]">
                <Activity className="size-3" /> DAG
              </TabsTrigger>
              <TabsTrigger value="logs" className="h-6 gap-1 text-[10.5px]">
                <Terminal className="size-3" /> 日志
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="min-h-0 flex-1">
          {error ? (
            <div className="p-6 text-[12px] text-pop-red">{error}</div>
          ) : !detail ? (
            <div className="p-6 text-[12px] text-pop-dim">加载执行…</div>
          ) : tab === 'dag' ? (
            <div className="h-full min-h-0 overflow-hidden">
              <WorkflowFlowViewerWithStatus
                yamlContent={detail.yaml}
                executionSteps={detail.steps}
                workspaceId={workspaceId}
                executionId={executionId}
              />
            </div>
          ) : (
            <div className={cn('h-full min-h-0 overflow-hidden')}>
              <ExecutionLogViewer
                workspaceId={workspaceId}
                executionId={executionId}
                executionStatus={detail.status}
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
