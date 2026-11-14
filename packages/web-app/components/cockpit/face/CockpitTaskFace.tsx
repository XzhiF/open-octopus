'use client'

// S4 owns this file —— 合成 task 行（历史舱没有 job 账本时由活态任务合成）的面。
//
// 它没有 CabinJob，所以不走 JobFace：五页签里能落到真处的部分用同一批复用件
// （CabinRunSummary / ChangesWindow / AcceptanceWindow），没有账本的部分给明确
// 空态。数据只从 useCockpitFleet() 的行 + GET /api/tasks/:id（10s 轮询）来。

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { getCabinUsage, type CabinUsagePayload } from '@/lib/cabin-api'
import { abortTask, getTask, pauseTask, resumeTask, type TaskDetail, type TaskView } from '@/lib/tasks-api'
import { useBillingCurrency } from '@/lib/billing-currency'
import { formatCost } from '@/lib/format'
import { ChangesWindow } from '@/components/chat-workbench/changes-window'
import { AcceptanceWindow } from '@/components/chat-workbench/acceptance-window'
import { CabinRunSummary, type CabinRunTarget } from '@/components/cabin/modules/CabinRunSummary'
import { pctFromPhases } from '@/components/cabin/job-progress'
import { clockLabel, openTaskInChat, taskDisplayStatus } from '@/components/cabin/modules/ui'
import { isEndedJob, jobStatusLabel } from '@/components/cabin/job-status'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import type { CockpitTab } from '../state/cockpit-state'
import { CockpitElapsed, CockpitJobHeader, TaskRunActions } from './CockpitJobHeader'

/** 执行记录行的小圆点：只按真实 status 上色，不猜阶段。 */
function executionTone(status: string): string {
  if (status === 'failed' || status === 'cancelled' || status === 'aborted' || status === 'interrupted' || status === 'rejected') {
    return 'bg-pop-red'
  }
  if (status === 'completed' || status === 'completed_with_failures') return 'bg-pop-green'
  if (status === 'running') return 'bg-pop-violet'
  return 'bg-pop-dim'
}

export interface CockpitTaskFaceProps {
  cabinId: string
  taskId: string
  entryCabinId: string
  cabinName?: string | null
  tab: CockpitTab
  onTabChange(tab: CockpitTab): void
  onClose: () => void
  onMutated?: () => void
  onAcceptanceMutated?(): void
}

export function CockpitTaskFace({
  cabinId,
  taskId,
  entryCabinId,
  cabinName,
  tab,
  onTabChange,
  onClose,
  onMutated,
  onAcceptanceMutated,
}: CockpitTaskFaceProps) {
  const { rows } = useCockpitFleet()
  const found = rows.find((entry) => entry.kind === 'task' && entry.task.id === taskId)
  const row = found && found.kind === 'task' ? found : null
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [usage, setUsage] = useState<CabinUsagePayload | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [task, payload] = await Promise.all([
        getTask(taskId),
        getCabinUsage(cabinId).catch(() => null),
      ])
      setDetail(task)
      setUsage(payload)
    } catch {
      /* 保留上一份快照 */
    }
  }, [cabinId, taskId])

  useEffect(() => {
    setDetail(null)
    setUsage(null)
    void load()
    const timer = window.setInterval(() => { void load() }, 10_000)
    return () => window.clearInterval(timer)
  }, [load])

  const currency = useBillingCurrency()
  const view: TaskView | null = detail ?? row?.task ?? null
  const status = row ? taskDisplayStatus(row.task) : (detail?.derived?.taskStatus ?? detail?.status ?? null)
  const executions = detail?.executions ?? []
  const currentExecution =
    executions.find((e) => ['pending', 'running', 'paused'].includes(e.status)) ?? executions[0] ?? null

  const runTarget: CabinRunTarget | null = currentExecution
    ? {
        executionId: currentExecution.id,
        workspaceId: currentExecution.workspace_id,
        title: view?.name ?? '任务',
        workflowRef: currentExecution.workflow_ref,
        phaseIndex: currentExecution.phase_index,
        roundIndex: currentExecution.round_index,
        status: currentExecution.status,
        taskId,
      }
    : null

  const runAction = async (action: 'pause' | 'resume' | 'abort') => {
    setBusy(action)
    try {
      if (action === 'pause') await pauseTask(taskId)
      else if (action === 'resume') await resumeTask(taskId)
      else await abortTask(taskId)
      toast.success(
        action === 'pause' ? '已暂停这一轮' : action === 'resume' ? '已继续运行' : '已中止任务',
      )
      await load()
      onMutated?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(null)
    }
  }

  const usageRow = usage?.byJob.find((entry) => entry.ref_id === taskId) ?? null
  const costLabel = usageRow && usageRow.totals.cost.usd != null
    ? formatCost(usageRow.totals.cost.usd, usageRow.totals.cost.complete, currency)
    : null
  const doing = currentExecution
    ? [currentExecution.name ?? currentExecution.workflow_ref, jobStatusLabel(currentExecution.status)]
        .filter(Boolean).join(' · ')
    : status ? jobStatusLabel(status) : null
  const startedAt = detail?.created_at ?? row?.task.created_at ?? null
  const endedAt = status && isEndedJob(status)
    ? (detail?.completed_at ?? detail?.updated_at ?? null)
    : null

  // 概览右栏读数：进度只来自 v4 phaseViews，缺就整段省略（不猜）。
  const phaseViews = detail?.derived?.phaseViews ?? []
  const pct = pctFromPhases(phaseViews)
  const acceptedPhases = phaseViews.filter((phase) => phase.status === 'accepted').length
  const statusText = status ? jobStatusLabel(status) : null
  const acList = detail?.task_spec?.ac ?? []

  const panes = (
    <>
      {tab === 'overview' && (
        // 合成 task 行同样按 v12 两栏：左摘要（目标 + 验收标准），右状态（读数 +
        // 执行记录）。没有作业账本，所以左栏不是事件轨迹。
        <div data-testid="cockpit-face-task-overview" className="ck12-sgrid ck12-jg-over">
          <section className="ck12-pane">
            <header className="ck12-pane-h">
              <b>任务摘要</b>
              <span className="ck12-pane-tag">
                {acList.length > 0 ? `AC ${acList.length}` : 'AC —'}
              </span>
            </header>
            <div className="ck12-pane-b is-tight">
              {detail?.task_spec?.goal ? (
                <div className="ck12-attn-card">
                  <div className="ck12-attn-label">目标</div>
                  <div className="ck12-attn-text">{detail.task_spec.goal}</div>
                </div>
              ) : null}
              {acList.length > 0 ? (
                <div className="ck12-attn-card">
                  <div className="ck12-attn-label">验收标准 · {acList.length}</div>
                  <ul className="ck12-attn-list">
                    {acList.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {!detail?.task_spec?.goal && acList.length === 0 && (
                <div className="ck12-face-empty">这条任务还没有写目标与验收标准。</div>
              )}
            </div>
          </section>

          <section className="ck12-pane">
            <header className="ck12-pane-h">
              <b>作业状态</b>
              {statusText && <span className="ck12-pane-tag">{statusText}</span>}
            </header>
            <div className="ck12-pane-b is-tight">
              <div className="ck12-jstats">
                <div className="ck12-jstat">
                  <div className="l">状态</div>
                  <div className="v">{statusText ?? '—'}</div>
                </div>
                {pct !== null && (
                  <div className="ck12-jstat">
                    <div className="l">进度</div>
                    <div className="v is-cyan">{pct}%</div>
                  </div>
                )}
                <div className="ck12-jstat">
                  <div className="l">耗时</div>
                  <div className="v"><CockpitElapsed start={startedAt} end={endedAt} /></div>
                </div>
                {costLabel && (
                  <div className="ck12-jstat">
                    <div className="l">消耗</div>
                    <div className="v is-amber">{costLabel}</div>
                  </div>
                )}
              </div>

              {(view?.repo_group || view?.workflow_ref || detail?.task_spec?.branch || startedAt) && (
                <div className="ck12-jfacts">
                  {view?.repo_group && <span>仓库 <b>{view.repo_group}</b></span>}
                  {view?.workflow_ref && <span>工作流 <b>{view.workflow_ref}</b></span>}
                  {detail?.task_spec?.branch && <span>分支 <b>{detail.task_spec.branch}</b></span>}
                  {startedAt && <span>创建 <b>{clockLabel(startedAt)}</b></span>}
                </div>
              )}

              {phaseViews.length > 0 && (
                <div className="ck12-jchips">
                  <span>阶段 <b>{acceptedPhases}/{phaseViews.length}</b></span>
                </div>
              )}

              {executions.length === 0 ? (
                <div className="ck12-face-empty" style={{ marginTop: 11 }}>
                  这一轮还没有执行 · 跑起来后这里留执行记录。
                </div>
              ) : (
                <div className="ck12-jtl" data-testid="cockpit-face-task-executions" style={{ marginTop: 9 }}>
                  {executions.map((execution) => (
                    <div key={execution.id} className="ck12-jrow">
                      <i className={`ck12-jrow-d ${executionTone(execution.status)}`} aria-hidden="true" />
                      <span className="ck12-jrow-t">{clockLabel(execution.created_at)}</span>
                      <span className="ck12-jrow-a" title={execution.id}>
                        {execution.id.slice(0, 8)}
                      </span>
                      <span className="ck12-jrow-k">{jobStatusLabel(execution.status)}</span>
                      <span
                        className="ck12-jrow-x"
                        title={[execution.name ?? execution.workflow_ref, execution.phase_index != null ? `P${execution.phase_index}` : null, execution.round_index != null ? `R${execution.round_index}` : null].filter(Boolean).join(' · ')}
                      >
                        {[execution.name ?? execution.workflow_ref, execution.phase_index != null ? `P${execution.phase_index}` : null, execution.round_index != null ? `R${execution.round_index}` : null].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {cabinId === entryCabinId && (
                <div className="ck12-face-actions">
                  <button
                    type="button"
                    className="ck12-jh-go"
                    data-testid="cockpit-task-main-chat"
                    onClick={() => openTaskInChat(taskId)}
                  >
                    去任务对话 →
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {tab === 'relay' && (
        <div data-testid="cockpit-face-task-relay">
          <div className="ck12-face-empty">
            这条任务没有作业账本（没有派发 / 回报事件）。
          </div>
          {cabinId === entryCabinId && (
            <div className="ck12-face-actions">
              <button
                type="button"
                className="ck12-jh-go"
                data-testid="cockpit-task-main-chat"
                onClick={() => openTaskInChat(taskId)}
              >
                去任务对话 →
              </button>
            </div>
          )}
        </div>
      )}

      {tab === 'run' && (
        <div data-testid="cockpit-face-task-run">
          {runTarget ? (
            <CabinRunSummary target={runTarget} />
          ) : (
            <div className="ck12-face-empty">
              这一轮还没有执行 · 跑起来后这里给执行摘要。
            </div>
          )}
        </div>
      )}

      {tab === 'changes' && (
        <div data-testid="cockpit-face-task-changes">
          {view ? (
            <div className="h-[500px] overflow-hidden rounded-lg border-[1.5px] border-pop-bd bg-pop-paper">
              <ChangesWindow task={view} />
            </div>
          ) : (
            <div className="ck12-face-empty">任务还没载入 · 暂时没有变更账本。</div>
          )}
        </div>
      )}

      {tab === 'accept' && (
        <div data-testid="cockpit-face-task-accept">
          {view ? (
            <div className="max-h-[520px] overflow-y-auto rounded-lg border-[1.5px] border-pop-bd bg-pop-paper">
              <AcceptanceWindow
                task={view}
                onMutated={() => {
                  onMutated?.()
                  onAcceptanceMutated?.()
                  void load()
                }}
                onOpenChanges={() => onTabChange('changes')}
              />
            </div>
          ) : (
            <div className="ck12-face-empty">任务还没载入 · 暂时没有验收单。</div>
          )}
        </div>
      )}
    </>
  )

  return (
    <>
      <CockpitJobHeader
        loading={!view}
        kind="task"
        title={view?.name}
        status={status}
        tab={tab}
        onTabChange={onTabChange}
        onClose={onClose}
        branch={detail?.task_spec?.branch ?? null}
        doing={doing}
        cabinName={cabinName ?? null}
        startedAt={startedAt}
        endedAt={endedAt}
        costLabel={costLabel}
        actions={
          <TaskRunActions
            status={status}
            busy={busy}
            onPause={() => { void runAction('pause') }}
            onResume={() => { void runAction('resume') }}
            onAbort={() => { void runAction('abort') }}
          />
        }
      />
      <div className="ck12-face-body" data-testid="cockpit-face-task">
        {view ? panes : <div className="ck12-face-empty">载入任务…</div>}
      </div>
    </>
  )
}
