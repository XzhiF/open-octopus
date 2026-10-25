'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, FileText, GitCompare, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { SPEC_FIELD_UPDATE_EVENT, TASK_STATUS_EVENT } from '@octopus/shared'
import { getTask, readyTask, TaskReadyGateError, type TaskDetail, type TaskView } from '@/lib/tasks-api'
import { listBuiltInWorkflows, type BuiltInWorkflowSummary } from '@/lib/workflow-presets-api'
import { subscribeSSE } from '@/lib/sse-manager'
import { getServerUrl } from '@/lib/server-config'
import { SpecPanel } from '@/components/tasks/authoring/spec-panel'
import { useBatchTree } from '@/components/tasks/authoring/use-batch-tree'
import { useHomeTree } from '@/components/tasks/authoring/use-home-tree'
import { computeGateHits, computeSpecRows } from '@/components/tasks/authoring/spec-gate'
import { TASK_STATUS_LABEL } from '@/components/tasks/run-console/phase-status'
import { CloseLightGlyph } from '@/components/ui/close-light'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ChangesWindow } from './changes-window'

type OverviewTab = 'plan' | 'changes' | 'acceptance'

const TABS: Array<{ id: OverviewTab; label: string; icon: typeof FileText }> = [
  { id: 'plan', label: '计划与产物', icon: FileText },
  { id: 'changes', label: '变更', icon: GitCompare },
  { id: 'acceptance', label: '验收', icon: CheckCircle2 },
]

interface TaskOverviewProps {
  task: TaskView
  onClose: () => void
  /** Enqueue succeeded: the parent leaves the draft chat and follows the task
   *  on the board / execution console. */
  onEnqueued: () => void
  /** Transitional bridge to the existing acceptance console. */
  onOpenAcceptance: (task: TaskView) => void
}

/**
 * Task-scoped result surface: one floating overview for the plan, artifacts,
 * code changes and acceptance. Chat stays behind it and keeps its width.
 */
export function TaskOverview({ task, onClose, onEnqueued, onOpenAcceptance }: TaskOverviewProps) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<OverviewTab>('plan')
  const [catalog, setCatalog] = useState<BuiltInWorkflowSummary[]>([])
  const [enqueueBusy, setEnqueueBusy] = useState(false)
  const [gateMissing, setGateMissing] = useState<string[] | null>(null)

  const batchTree = useBatchTree(task.id, { versionKey: detail?.version })
  const home = useHomeTree(task.id, { versionKey: detail?.version })

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setDetail(await getTask(task.id))
    } catch {
      /* keep the last snapshot */
    } finally {
      setLoading(false)
    }
  }, [task.id])

  useEffect(() => {
    void refresh()
    listBuiltInWorkflows().then(setCatalog).catch(() => setCatalog([]))
  }, [refresh])

  useEffect(() => {
    const url = `${getServerUrl()}/api/tasks/events`
    const mine = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as { task_id?: string }
        return payload.task_id === task.id
      } catch {
        return false
      }
    }
    const offSpec = subscribeSSE(url, SPEC_FIELD_UPDATE_EVENT, (e) => {
      if (mine(e)) void refresh()
    })
    const offStatus = subscribeSSE(url, TASK_STATUS_EVENT, (e) => {
      if (mine(e)) void refresh()
    })
    return () => {
      offSpec()
      offStatus()
    }
  }, [task.id, refresh])

  const spec = detail?.task_spec
  const rows = useMemo(() => {
    if (!spec) return null
    return computeSpecRows({
      phases: spec.phases ?? [],
      spec,
      catalog,
      batches: batchTree.batches,
      batchLoading: batchTree.loading,
      batchError: batchTree.error,
      projectCount: (task.project_ids ?? []).length,
      composite: Array.isArray(spec.subunits) && spec.subunits.length >= 2,
    })
  }, [spec, catalog, batchTree.batches, batchTree.loading, batchTree.error, task.project_ids])

  const execution = task.execution
  const phase =
    execution?.phase_index != null
      ? `P${execution.phase_index}${execution.round_index != null ? ` · R${execution.round_index}` : ''}`
      : null
  const isDraft = task.status === 'draft'
  const stage =
    isDraft
      ? '计划'
      : task.status === 'awaiting_review' || task.status === 'archiving'
        ? '验收'
        : task.status === 'done' || task.status === 'failed' || task.status === 'aborted'
          ? '完成'
          : '执行'
  const meta = [stage, TASK_STATUS_LABEL[task.status] ?? task.status, phase].filter(Boolean).join(' · ')
  const gateHits = useMemo(() => computeGateHits(gateMissing), [gateMissing])
  const canEnqueue =
    !!rows &&
    rows.rowPhases &&
    rows.rowSpec &&
    rows.rowBind &&
    rows.rowInputs &&
    rows.rowRunbook &&
    rows.rowRepos

  const handleEnqueue = async () => {
    if (!canEnqueue || enqueueBusy) return
    setEnqueueBusy(true)
    try {
      await readyTask(task.id)
      toast.success('已入队 · 在任务看板触发执行')
      onEnqueued()
    } catch (err: unknown) {
      if (err instanceof TaskReadyGateError) {
        setGateMissing(err.missing)
        setTab('plan')
        toast.error(`入队被拒：缺少 ${err.missing.join('、')}`)
      } else {
        toast.error(err instanceof Error ? err.message : '入队失败')
      }
    } finally {
      setEnqueueBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="ui-font flex h-[84vh] w-[92vw] max-w-[1080px] flex-col gap-0 overflow-hidden rounded-2xl border border-white/[0.10] bg-pop-bg p-0 sm:max-w-[1080px]"
      >
        <DialogTitle className="sr-only">任务概览 · {task.name}</DialogTitle>

        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-white/[0.06] px-3">
          <button
            type="button"
            aria-label="关闭任务概览"
            title="关闭"
            onClick={onClose}
            className="grid size-6 shrink-0 place-items-center rounded-full outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-pop-yellow"
          >
            <CloseLightGlyph />
          </button>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold tracking-[-0.01em] text-pop-ink">
              {task.name}
            </div>
            <div className="truncate text-[10.5px] text-pop-dim">{meta}</div>
          </div>

          <div className="ml-auto flex items-center gap-1 rounded-lg bg-white/[0.04] p-0.5">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                data-overview-tab={id}
                aria-pressed={tab === id}
                onClick={() => setTab(id)}
                className={cn(
                  'flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[7px] px-2.5 text-[11.5px] transition-colors',
                  tab === id
                    ? 'bg-white/[0.09] text-pop-ink'
                    : 'text-pop-dim hover:bg-white/[0.04] hover:text-pop-ink',
                )}
              >
                <Icon className="size-3.5" strokeWidth={1.8} />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>

          <button
            type="button"
            aria-label="刷新"
            title="刷新产物"
            onClick={() => {
              void refresh()
              batchTree.refresh()
              home.refresh()
            }}
            className="grid size-7 shrink-0 place-items-center rounded-md text-pop-dim transition-colors hover:bg-white/[0.05] hover:text-pop-ink"
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </button>

          {isDraft && (
            <Button
              size="sm"
              variant="pop"
              data-testid="task-overview-enqueue"
              onClick={() => void handleEnqueue()}
              disabled={!canEnqueue || enqueueBusy}
              title={canEnqueue ? '入队后到任务看板触发执行' : '入队清单未全绿'}
              className="shrink-0"
            >
              {enqueueBusy ? '入队中…' : '入队执行'}
            </Button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {!detail ? (
            <div className="flex h-full items-center justify-center">
              <Spinner className="size-5 text-pop-dim" />
            </div>
          ) : tab === 'plan' ? (
            rows ? (
              <SpecPanel
                task={detail}
                onMutated={() => void refresh()}
                batchTree={batchTree}
                rows={rows}
                gateHits={gateHits}
                home={home}
                readOnly
              />
            ) : (
              <EmptyTab
                icon={FileText}
                title="还没有 v4 规格"
                hint="在对话里让 task-author 拆 Phase、写 spec；产物会实时出现在这里。"
              />
            )
          ) : tab === 'changes' ? (
            isDraft ? (
              <EmptyTab
                icon={GitCompare}
                title="还没有代码变更"
                hint="任务入队执行后，每一轮的代码 diff 会出现在这里。"
              />
            ) : (
              <ChangesWindow task={task} />
            )
          ) : (
            <AcceptanceTab
              task={task}
              detail={detail}
              onOpenAcceptance={onOpenAcceptance}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function EmptyTab({
  icon: Icon,
  title,
  hint,
}: {
  icon: typeof FileText
  title: string
  hint: string
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="grid size-10 place-items-center rounded-xl bg-white/[0.04] text-pop-dim">
        <Icon className="size-5" strokeWidth={1.6} />
      </div>
      <div className="mt-3 text-[13px] font-medium text-pop-ink">{title}</div>
      <p className="mt-1 max-w-sm text-[11.5px] leading-relaxed text-pop-dim">{hint}</p>
    </div>
  )
}

function AcceptanceTab({
  task,
  detail,
  onOpenAcceptance,
}: {
  task: TaskView
  detail: TaskDetail
  onOpenAcceptance: (task: TaskView) => void
}) {
  const spec = detail.task_spec
  const runbook = spec.acceptance_runbook
  const preview = spec.acceptance_preview
  const verify = spec.acceptance_verify

  if (task.status === 'draft') {
    return (
      <EmptyTab
        icon={CheckCircle2}
        title="入队并执行后才能验收"
        hint="先在对话里把 Phase、规格和 Runbook 定下来；入队执行后会在这里看到运行结果、预览和验收闸门。"
      />
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-6 py-6">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-pop-ink">验收</h2>
        <p className="mt-1 text-[11.5px] leading-relaxed text-pop-dim">
          先跑起来看，再对照变更与用例决定通过还是打回。
        </p>

        <div className="mt-5 space-y-2.5">
          <AcceptanceRow
            label="起停"
            value={
              runbook?.up?.command && runbook?.ready?.command
                ? `${runbook.up.command} → ${runbook.ready.command}`
                : null
            }
          />
          <AcceptanceRow
            label="预览"
            value={preview?.command ? `${preview.command}${preview.url ? ` · ${preview.url}` : ''}` : null}
          />
          <AcceptanceRow label="复检" value={verify?.command ?? null} />
        </div>

        <div className="mt-6 flex items-center gap-2">
          <Button size="sm" variant="pop" onClick={() => onOpenAcceptance(task)}>
            打开验收控制台
          </Button>
          <span className="text-[10.5px] text-pop-dim">
            运行记录、逐轮 diff、用例与打回仍在原控制台里
          </span>
        </div>
      </div>
    </div>
  )
}

function AcceptanceRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-3 rounded-[9px] border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      <span className="w-9 shrink-0 text-[10.5px] text-pop-dim">{label}</span>
      <span className={cn('min-w-0 flex-1 break-all font-mono text-[11px]', value ? 'text-pop-ink' : 'text-pop-dim/60')}>
        {value ?? '未配置'}
      </span>
    </div>
  )
}
