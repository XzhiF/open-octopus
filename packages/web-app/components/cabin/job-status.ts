// 舱作业状态词表（classic-v3 编队 / 作业详情共用）。
// job.status 由服务端派生自底层实体（任务 derived / execution.status / subagent_run.status），
// 这里只做展示映射，不重派生。

export type JobTone = 'run' | 'wait' | 'blocked' | 'ended' | 'idle'

const LABEL: Record<string, string> = {
  draft: '草稿',
  ready: '待执行',
  running: '运行中',
  paused: '已暂停',
  pending: '排队中',
  pending_approval: '待审批',
  pending_interaction: '等人',
  pending_resume: '待恢复',
  awaiting_review: '待验收',
  awaiting_archive: '待归档',
  archiving: '归档中',
  done: '已完成',
  completed: '已完成',
  completed_with_failures: '完成（有失败）',
  failed: '失败',
  blocked: '受阻',
  cancelled: '已中止',
  aborted: '已中止',
  interrupted: '已中断',
  rejected: '已拒绝',
  unknown: '—',
}

const RUN = new Set(['running'])
const WAIT = new Set([
  'ready', 'paused', 'pending', 'pending_approval', 'pending_interaction', 'pending_resume',
  'awaiting_review', 'awaiting_archive', 'archiving',
])
const BLOCKED = new Set(['failed', 'blocked'])
const ENDED = new Set([
  'done', 'completed', 'completed_with_failures', 'cancelled', 'aborted', 'interrupted', 'rejected',
])

export function jobStatusLabel(status: string | null | undefined): string {
  if (!status) return '—'
  return LABEL[status] ?? status
}

export function jobTone(status: string | null | undefined): JobTone {
  if (!status) return 'idle'
  if (RUN.has(status)) return 'run'
  if (WAIT.has(status)) return 'wait'
  if (BLOCKED.has(status)) return 'blocked'
  if (ENDED.has(status)) return 'ended'
  return 'idle'
}

/** 已结束（置底、降透明）。 */
export function isEndedJob(status: string | null | undefined): boolean {
  return !!status && ENDED.has(status)
}
