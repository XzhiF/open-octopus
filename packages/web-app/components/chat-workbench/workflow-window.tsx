'use client'

import { useEffect, useState } from 'react'
import { Activity, Terminal } from 'lucide-react'
import { fetchExecutionDetail } from '@/lib/api-client'
import type { StepExecution } from '@/lib/types'
import { WorkflowFlowViewerWithStatus } from '@/components/workspace/workflow-flow-viewer-with-status'
import { RunLogConsole } from '@/components/workspace/run-log/run-log-console'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CloseLightGlyph } from '@/components/ui/close-light'
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
  /** DAG 与日志共用的聚焦（节点 id = 日志通道 id）；日志栏点击也回写这里。 */
  const [focus, setFocus] = useState<string | null>(null)

  // 换一轮执行就松开聚焦：上一轮的通道 id 不该挂在新轮上。
  useEffect(() => { setFocus(null) }, [executionId])

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
        className="ui-font flex h-[82vh] w-[92vw] max-w-[1400px] flex-col gap-0 overflow-hidden rounded-2xl border border-white/[0.10] bg-pop-bg p-0 sm:max-w-[1400px]"
      >
        <DialogTitle className="sr-only">{title ?? '工作流执行'}</DialogTitle>
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3">
          <button
            type="button"
            aria-label="关闭工作流窗口"
            title="关闭"
            onClick={onClose}
            className="group/light grid size-6 shrink-0 place-items-center rounded-full outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-pop-yellow"
          >
            <CloseLightGlyph />
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
                onNodeClick={(stepId) => setFocus((prev) => (prev === stepId ? null : stepId))}
              />
            </div>
          ) : (
            <div className={cn('h-full min-h-0 overflow-hidden')}>
              <RunLogConsole
                workspaceId={workspaceId}
                executionId={executionId}
                executionStatus={detail.status}
                steps={detail.steps}
                focus={focus}
                onFocusChange={setFocus}
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
