'use client'

// S4 owns this file —— 合成 task 行（历史舱没有 job 账本时由活态任务合成）的面。
//
// 它没有 CabinJob，所以不走 JobFace：五页签里能落到真处的部分用同一批复用件
// （CabinRunSummary / ChangesWindow / AcceptanceWindow），没有账本的部分给明确
// 空态。数据只从 useCockpitFleet() 的行 + GET /api/tasks/:id（10s 轮询）来。

import { useCallback, useEffect, useState } from 'react'
import { getCabinUsage, type CabinUsagePayload } from '@/lib/cabin-api'
import { getTask, type TaskDetail, type TaskView } from '@/lib/tasks-api'
import { useBillingCurrency } from '@/lib/billing-currency'
import { formatCost } from '@/lib/format'
import { ChangesWindow } from '@/components/chat-workbench/changes-window'
import { AcceptanceWindow } from '@/components/chat-workbench/acceptance-window'
import { CabinRunSummary, type CabinRunTarget } from '@/components/cabin/modules/CabinRunSummary'
import { openTaskInChat, taskDisplayStatus } from '@/components/cabin/modules/ui'
import { isEndedJob, jobStatusLabel } from '@/components/cabin/job-status'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import type { CockpitTab } from '../state/cockpit-state'
import { CockpitJobHeader, CockpitJobTabs } from './CockpitJobHeader'
import { CockpitJobFiles } from './CockpitJobFiles'
import { CockpitJobDebug } from './CockpitJobDebug'
import { CockpitJobProject } from './CockpitJobProject'
import { projectNameFromKey } from '../projects/project-model'

export interface CockpitTaskFaceProps {
  cabinId: string
  taskId: string
  entryCabinId: string
  cabinName?: string | null
  /** 项目名（编队行 project_keys 派生；副行「项目 · 分支 · 编号」第一段）。 */
  projectName?: string | null
  tab: CockpitTab
  onTabChange(tab: CockpitTab): void
  onClose: () => void
  onMutated?: () => void
  onAcceptanceMutated?(): void
  /** v22 #5：打开这条任务的独立 chat 窗（有 doer 会话才传）。 */
  onOpenChat?: (() => void) | null
}

export function CockpitTaskFace({
  cabinId,
  taskId,
  entryCabinId,
  cabinName,
  projectName,
  tab,
  onTabChange,
  onClose,
  onMutated,
  onAcceptanceMutated,
  onOpenChat,
}: CockpitTaskFaceProps) {
  const { rows } = useCockpitFleet()
  const found = rows.find((entry) => entry.kind === 'task' && entry.task.id === taskId)
  const row = found && found.kind === 'task' ? found : null
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [usage, setUsage] = useState<CabinUsagePayload | null>(null)

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
  // 项目锚点与副行「项目」段：classic 同源（task.project_ids）。
  const taskProjects = view?.project_ids ?? []
  const headerProjectName = projectName
    ?? (taskProjects.length > 0 ? projectNameFromKey(taskProjects[0]) : null)
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

  const panes = (
    <>
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

      {tab === 'files' && (
        <div data-testid="cockpit-face-task-files">
          <CockpitJobFiles taskId={taskId} />
        </div>
      )}
      {tab === 'debug' && (
        <div data-testid="cockpit-face-task-debug">
          <CockpitJobDebug sessionId={view?.doer_session_id ?? row?.task.doer_session_id ?? null} />
        </div>
      )}
      {tab === 'project' && (
        <div data-testid="cockpit-face-task-project">
          <CockpitJobProject
            cabinId={cabinId}
            projects={taskProjects}
            branch={detail?.task_spec?.branch ?? null}
          />
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
        onClose={onClose}
        branch={detail?.task_spec?.branch ?? null}
        projectName={headerProjectName}
        jobNo={taskId.slice(0, 8)}
        doing={doing}
        cabinName={cabinName ?? null}
        startedAt={startedAt}
        endedAt={endedAt}
        costLabel={costLabel}
        onOpenChat={onOpenChat ?? null}
      />
      <div className="ck12-face-body" data-testid="cockpit-face-task">
        {view ? (
          <>
            {/* 原型 .dtabs 在滚动正文里（.pb）—— 页签跟内容一起滚走。 */}
            <CockpitJobTabs tab={tab} onTabChange={onTabChange} />
            {panes}
          </>
        ) : (
          <div className="ck12-face-empty">载入任务…</div>
        )}
      </div>
    </>
  )
}
