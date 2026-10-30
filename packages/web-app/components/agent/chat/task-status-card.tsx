'use client'

// 对话里的任务状态卡（2026-10-30 用户定稿）：
//
//   · 「任务开始执行 / 任务已暂停」→ 会自己走表的运行卡：计时（服务端 started_at
//     起算，刷新不归零）、进度（x/y 节点）、节点摘要。数据与运行窗同源
//     （getTask + fetchExecutionDetail），只有「还在跑」的卡按 3s 轮询；跑完
//     自动停轮询、定格成只读的「本轮执行完成」（2026-10-30 用户：正常结束的卡
//     要有结束态，不能一直挂着「任务开始执行 / 已结束」）。
//
//   · 节点摘要只列**顶层节点**：`__engine_init__` 等内部节点隐藏，子工作流
//     （`ticket-dag:ticket-01`）聚合回父节点显示 n/m —— 2026-10-30 用户：原来
//     取「最近 2 个完成节点」会被 DAG 子节点占满，看不出整轮跑到哪了。
//   · 收尾状态（本轮完成 · 待验收 / 归档中 / 已归档 / 中止 / 失败）→ 收尾只读卡，
//     和「启动方式选完」的决策卡同一套观感：降噪、无按钮，操作回主 chat / 作业坞。
//
// 卡片永远没有动作按钮 —— 用户明确要求操作走主 chat 或作业坞对应窗口。

import { useEffect, useRef, useState } from 'react'
import { getTask, type TaskDetail, type TaskExecutionBadge } from '@/lib/tasks-api'
import { fetchExecutionDetail } from '@/lib/api-client'
import type { StepExecution } from '@/lib/types'
import type { AgentMessage } from '@/lib/agent/types'
import { formatRunClock } from '@/lib/format'

const LIVE_TASK_STATUS = new Set(['running', 'paused'])
const TERMINAL_EXEC_STATUS = new Set([
  'completed', 'completed_with_failures', 'failed', 'cancelled', 'aborted',
])
const FAILED_EXEC_STATUS = new Set(['failed', 'completed_with_failures'])
const STOPPED_EXEC_STATUS = new Set(['cancelled', 'aborted'])

/** 收尾卡 / 历史卡的 detail 拉取去重缓存：同一任务的多张卡只打一次（20s 内）。 */
const taskDetailCache = new Map<string, { at: number; promise: Promise<TaskDetail> }>()
function getTaskCached(id: string): Promise<TaskDetail> {
  const hit = taskDetailCache.get(id)
  if (hit && Date.now() - hit.at < 20_000) return hit.promise
  const promise = getTask(id).catch((err: unknown) => {
    taskDetailCache.delete(id)
    throw err
  })
  taskDetailCache.set(id, { at: Date.now(), promise })
  return promise
}

interface ExecSnapshot {
  status: string
  startedAt: string | null
  completedAt: string | null
  steps: StepExecution[]
}

const stepLabel = (s: StepExecution) => s.stepName || s.stepId
const isDone = (s: StepExecution) => s.status === 'completed' || s.status === 'skipped'
const stepMs = (s: StepExecution): number | null => {
  if (typeof s.duration === 'number') return s.duration * 1000
  const a = s.startedAt ? Date.parse(s.startedAt) : NaN
  const b = s.completedAt ? Date.parse(s.completedAt) : NaN
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null
}

// ── 节点摘要（顶层节点 + 子工作流聚合）─────────────────────────────
// 引擎把子工作流的节点铺平进同一份 steps（`ticket-dag:ticket-01`），
// `__engine_init__` 之类是内部节点。直接取尾部会在 DAG 轮次里只剩子票，
// 看不出「整轮跑到哪」——所以摘要只列顶层节点，子节点计数聚合到父节点。

type ChipKind = 'done' | 'skipped' | 'failed' | 'running' | 'paused' | 'waiting' | 'pending'

interface NodeChip {
  key: string
  label: string
  kind: ChipKind
  ms: number | null
  /** 子工作流进度（如 ticket-dag 4/4）。 */
  sub?: { done: number; total: number }
  tip: string
}

const isInternalStep = (s: StepExecution) => s.stepId.startsWith('__')
const parentIdOf = (s: StepExecution): string | null => {
  const i = s.stepId.indexOf(':')
  return i > 0 ? s.stepId.slice(0, i) : null
}
const chipKind = (s: StepExecution): ChipKind => {
  switch (s.status) {
    case 'completed': return 'done'
    case 'skipped': return 'skipped'
    case 'failed': return 'failed'
    case 'running': return 'running'
    case 'paused': return 'paused'
    case 'pending_approval':
    case 'pending_interaction': return 'waiting'
    default: return 'pending'
  }
}
const KIND_MARK: Record<ChipKind, string> = {
  done: '✓', skipped: '⊘', failed: '✗', running: '▶', paused: '⏸', waiting: '◇', pending: '○',
}

const NODE_CHIP_CAP = 12

function buildNodeChips(steps: StepExecution[]): { chips: NodeChip[]; hidden: number } {
  const visible = steps.filter((s) => !isInternalStep(s))
  // 只有「父节点确实在列表里」的子节点才聚合；父节点被隐藏时子节点自己顶上。
  const parentIds = new Set(visible.filter((s) => !parentIdOf(s)).map((s) => s.stepId))
  const kidsByParent = new Map<string, StepExecution[]>()
  for (const s of visible) {
    const pid = parentIdOf(s)
    if (!pid || !parentIds.has(pid)) continue
    const arr = kidsByParent.get(pid) ?? []
    arr.push(s)
    kidsByParent.set(pid, arr)
  }
  const top = visible.filter((s) => {
    const pid = parentIdOf(s)
    return !pid || !parentIds.has(pid)
  })
  // 按真实开始时间排（DAG 子节点会乱序落库）；没开始的排最后，保持原相对顺序。
  const ordered = top
    .map((s, i) => ({ s, i, t: s.startedAt ? Date.parse(s.startedAt) : Number.NaN }))
    .sort((a, b) => {
      const at = Number.isFinite(a.t) ? a.t : Number.POSITIVE_INFINITY
      const bt = Number.isFinite(b.t) ? b.t : Number.POSITIVE_INFINITY
      return at === bt ? a.i - b.i : at - bt
    })
    .map((x) => x.s)
  const shown = ordered.slice(0, NODE_CHIP_CAP)
  const chips = shown.map((s): NodeChip => {
    const kids = kidsByParent.get(s.stepId) ?? []
    const done = kids.filter(isDone).length
    return {
      key: s.stepId,
      label: stepLabel(s),
      kind: chipKind(s),
      ms: stepMs(s),
      ...(kids.length > 0 ? { sub: { done, total: kids.length } } : {}),
      tip: kids.length > 0
        ? `${stepLabel(s)} · ${done}/${kids.length} 子节点\n` +
          kids.map((k) => `${KIND_MARK[chipKind(k)]} ${stepLabel(k)}`).join('\n')
        : `${KIND_MARK[chipKind(s)]} ${stepLabel(s)}`,
    }
  })
  return { chips, hidden: Math.max(0, ordered.length - shown.length) }
}

const STATUS_LABEL: Record<string, string> = {
  running: '执行中',
  paused: '已暂停',
}

/** 收尾卡的提示（操作入口说明——不是按钮）。 */
const SETTLED_HINT: Record<string, string> = {
  awaiting_review: '在作业坞「验收」处理',
  archiving: '归档进行中 · 报告在作业坞「产物」',
  done: '归档报告在作业坞「产物」',
  aborted: '日志在作业坞「运行」',
  failed: '完整日志在作业坞「运行」',
}

export function TaskStatusCard({ message }: { message: AgentMessage }) {
  const activity = message.activity
  const taskId = activity?.taskId ?? null
  const executionId = activity?.executionId ?? null
  const cardStatus = activity?.status ?? ''
  const isRunCard = LIVE_TASK_STATUS.has(cardStatus)

  const [exec, setExec] = useState<ExecSnapshot | null>(null)
  const [run, setRun] = useState<TaskExecutionBadge | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const stoppedRef = useRef(false)

  useEffect(() => {
    if (!taskId) return
    let alive = true
    stoppedRef.current = false
    const load = async () => {
      try {
        // 运行中的卡要新鲜数据；收尾卡只补一次「用时」上下文，走去重缓存。
        const detail = isRunCard ? await getTask(taskId) : await getTaskCached(taskId)
        if (!alive) return
        const nextRun = detail.executions.find((e) => e.id === executionId)
          ?? detail.executions[0]
          ?? null
        setRun(nextRun)
        const wsId = nextRun?.workspace_id ?? activity?.workspaceId ?? null
        const execId = nextRun?.id ?? executionId
        if (!wsId || !execId) return
        const data = await fetchExecutionDetail(wsId, execId)
        if (!alive) return
        setExec({
          status: data.status,
          startedAt: data.started_at ?? null,
          completedAt: data.completed_at ?? null,
          steps: Array.isArray(data.steps) ? data.steps : [],
        })
        if (TERMINAL_EXEC_STATUS.has(data.status)) stoppedRef.current = true
      } catch {
        /* 服务端离线 / 执行被清理：保留上一份快照，卡片照常渲染 */
      }
    }
    void load()
    if (!isRunCard) return () => { alive = false }
    const timer = window.setInterval(() => {
      if (!stoppedRef.current) void load()
    }, 3000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [taskId, executionId, isRunCard, activity?.workspaceId])

  // 收尾（执行终态）后计时停住 —— 只在还活着时每秒推一格。
  const execStatus = exec?.status ?? null
  const execTerminal = !!execStatus && TERMINAL_EXEC_STATUS.has(execStatus)
  const failed = execTerminal
    ? FAILED_EXEC_STATUS.has(execStatus!)
    : cardStatus === 'failed'
  const stopped = !failed && execTerminal && STOPPED_EXEC_STATUS.has(execStatus!)
  const paused = !execTerminal && (cardStatus === 'paused' || execStatus === 'paused')
  const liveNow = isRunCard && !execTerminal && !paused
  useEffect(() => {
    if (!liveNow) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [liveNow])

  const tone = failed ? 'failed' : paused ? 'paused' : liveNow ? 'live' : stopped ? 'settled' : 'done'

  const steps = exec?.steps ?? []
  const doneSteps = steps.filter(isDone)
  const pct = steps.length > 0 ? Math.round((doneSteps.length / steps.length) * 100) : null
  const { chips, hidden: hiddenNodes } = buildNodeChips(steps)

  const startedMs = Date.parse(exec?.startedAt ?? run?.started_at ?? message.created_at ?? '')
  const endedMs = Date.parse(exec?.completedAt ?? run?.completed_at ?? '')
  const lastStepEnd = steps.reduce(
    (acc, s) => Math.max(acc, s.completedAt ? Date.parse(s.completedAt) : 0),
    0,
  )
  const elapsedMs = !Number.isFinite(startedMs)
    ? null
    : Number.isFinite(endedMs)
      ? Math.max(0, endedMs - startedMs)
      // 暂停也定格在「暂停那一刻」——now 只在 liveNow 时每秒推进。
      : (liveNow || paused)
        ? Math.max(0, now - startedMs)
        : lastStepEnd > startedMs ? lastStepEnd - startedMs : null

  const coord = activity?.phaseIndex != null
    ? `P${activity.phaseIndex}${activity.roundIndex != null ? ` · R${activity.roundIndex}` : ''}`
    : ''

  // ── 收尾状态卡（本轮完成 · 待验收 / 归档 / 中止 / 失败 / 其它终态） ──
  if (!isRunCard) {
    const mark = failed ? '✕' : '✓'
    const accent = failed ? 'text-pop-red' : 'text-pop-green'
    return (
      <div
        data-tui-msg="event"
        data-message-id={message.id}
        data-testid="activity-event-card"
        data-card-tone={failed ? 'failed' : 'settled'}
        className={[
          'rounded-md border px-3 py-2 font-mono text-[11.5px]',
          'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]',
          failed ? 'border-pop-red/35 bg-pop-red/[0.05]' : 'border-pop-bd/70 bg-white/[0.015]',
        ].join(' ')}
      >
        <div className="flex items-center gap-2">
          <span className={`grid size-4 shrink-0 place-items-center rounded-full border border-current text-[9px] ${accent}`}>{mark}</span>
          <span className={`min-w-0 flex-1 truncate font-semibold ${failed ? 'text-pop-red' : 'text-pop-ink/80'}`}>
            {activity?.title ?? '任务状态'}
          </span>
          {elapsedMs != null && (
            <span className="shrink-0 rounded-full border border-pop-bd/60 px-2 py-[1px] text-[9.5px] tabular-nums text-pop-dim">
              用时 {formatRunClock(elapsedMs)}
            </span>
          )}
        </div>
        {activity?.message && (
          <div className="mt-1 pl-6 text-[10.5px] text-pop-dim">{activity.message}</div>
        )}
        {SETTLED_HINT[cardStatus] && (
          <div className="mt-0.5 pl-6 text-[10px] text-pop-dim/70">{SETTLED_HINT[cardStatus]}</div>
        )}
      </div>
    )
  }

  // ── 运行卡（执行中 / 已暂停；跑完后同一张卡定格成只读） ──
  const TONE = {
    live: {
      box: 'border-pop-violet/35 bg-pop-violet/[0.05]',
      title: 'text-pop-violet',
      pill: 'border-pop-violet/40 text-pop-violet',
      dot: 'bg-pop-violet',
      bar: 'bg-pop-violet',
      chipCurrent: 'border-pop-violet/40 bg-white/[0.05] text-pop-ink',
    },
    paused: {
      box: 'border-pop-amber/35 bg-pop-amber/[0.05]',
      title: 'text-pop-amber',
      pill: 'border-pop-amber/40 text-pop-amber',
      dot: 'bg-pop-amber',
      bar: 'bg-pop-amber',
      chipCurrent: 'border-pop-amber/40 bg-white/[0.05] text-pop-ink',
    },
    settled: {
      box: 'border-pop-bd/70 bg-white/[0.015]',
      title: 'text-pop-ink/80',
      pill: 'border-pop-bd text-pop-dim',
      dot: 'bg-pop-dim',
      bar: 'bg-pop-dim',
      chipCurrent: 'border-pop-bd/60 bg-transparent text-pop-dim',
    },
    // 正常跑完：降噪底 + 绿色完成信号（圈 ✓ / 进度条 / 徽章同色）。
    done: {
      box: 'border-pop-bd/70 bg-white/[0.015]',
      title: 'text-pop-ink/80',
      pill: 'border-pop-green/40 text-pop-green',
      dot: 'bg-pop-green',
      bar: 'bg-pop-green',
      chipCurrent: 'border-pop-bd/60 bg-transparent text-pop-dim',
    },
    failed: {
      box: 'border-pop-red/35 bg-pop-red/[0.05]',
      title: 'text-pop-red',
      pill: 'border-pop-red/40 text-pop-red',
      dot: 'bg-pop-red',
      bar: 'bg-pop-red',
      chipCurrent: 'border-pop-red/45 bg-pop-red/[0.08] text-pop-red',
    },
  }[tone]

  const CHIP_CLASS: Record<ChipKind, string> = {
    done: 'border-pop-bd/60 bg-black/20 text-pop-dim',
    skipped: 'border-pop-bd/40 bg-transparent text-pop-dim/55',
    failed: 'border-pop-red/45 bg-pop-red/[0.08] text-pop-red',
    running: TONE.chipCurrent,
    paused: 'border-pop-amber/40 bg-white/[0.05] text-pop-ink',
    waiting: 'border-pop-amber/40 bg-pop-amber/[0.06] text-pop-amber',
    pending: 'border-dashed border-pop-bd/60 text-pop-dim/60',
  }

  const statusLabel = liveNow
    ? (STATUS_LABEL[cardStatus] ?? '执行中')
    : paused ? '已暂停'
      : failed ? '失败'
        : stopped ? '已中止'
          : '已完成'

  // 跑完这一轮后标题跟着结束态走（用户 2026-10-30：不能永远挂着「任务开始执行」）。
  const title = liveNow
    ? (activity?.title ?? '任务开始执行')
    : paused
      ? (activity?.title ?? '任务已暂停')
      : failed ? '本轮执行失败'
        : stopped ? '本轮执行中止'
          : '本轮执行完成'

  return (
    <div
      data-tui-msg="event"
      data-message-id={message.id}
      data-testid="activity-event-card"
      data-card-tone={tone}
      className={[
        'rounded-md border px-3 py-2 font-mono text-[11.5px] leading-relaxed',
        'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]',
        TONE.box,
      ].join(' ')}
    >
      <div className="flex items-center gap-2">
        {liveNow || paused ? (
          <span className="relative flex size-2 shrink-0">
            {liveNow && (
              <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${TONE.dot}`} />
            )}
            <span className={`relative inline-flex size-2 rounded-full ${TONE.dot}`} />
          </span>
        ) : (
          <span
            className={`grid size-4 shrink-0 place-items-center rounded-full border border-current text-[9px] ${
              failed ? 'text-pop-red' : stopped ? 'text-pop-dim' : 'text-pop-green'
            }`}
          >
            {failed ? '✕' : stopped ? '■' : '✓'}
          </span>
        )}
        <span className={`min-w-0 flex-1 truncate font-semibold ${TONE.title}`}>
          {title}
        </span>
        {coord && <span className="shrink-0 text-[10.5px] text-pop-dim">{coord}</span>}
        <span className={`shrink-0 rounded-full border px-1.5 py-[1px] text-[9px] font-bold ${TONE.pill}`}>
          {statusLabel}
        </span>
        <span
          className="shrink-0 rounded-full border border-pop-bd/70 bg-black/20 px-2 py-[1px] text-[10px] font-bold tabular-nums text-pop-ink"
          title={liveNow ? '总耗时 —— 自服务端 started_at 起算，刷新/重开不归零' : '本轮总耗时'}
        >
          {liveNow ? '⏱ ' : '用时 '}{formatRunClock(elapsedMs)}
        </span>
      </div>

      <div className="mt-1 flex items-center gap-2 pl-4 text-[10.5px] text-pop-dim">
        {run?.workflow_ref && <span className="truncate text-pop-ink/70">{run.workflow_ref}</span>}
        <span className="ml-auto shrink-0 text-[9.5px] text-pop-dim/60">
          {activity?.executionId ? activity.executionId.slice(0, 8) : ''}
        </span>
      </div>

      {pct == null ? (
        <div className="mt-2 pl-4 text-[10.5px] text-pop-dim/60">正在读取运行节点…</div>
      ) : (
        <>
          <div className="mt-2 flex items-center gap-2.5">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
              <div
                className={`h-full rounded-full transition-[width] duration-700 ${TONE.bar}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="shrink-0 text-[10px] tabular-nums text-pop-dim">
              <b className="text-pop-ink/80">{doneSteps.length}/{steps.length}</b> 节点 · {pct}%
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-4">
            {chips.map((c) => (
              <span
                key={c.key}
                title={c.tip}
                className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-[1px] text-[10px] ${CHIP_CLASS[c.kind]}`}
              >
                {c.kind === 'done' && <span className="text-pop-green">✓</span>}
                {c.kind === 'skipped' && <span className="opacity-70">⊘</span>}
                {c.kind === 'failed' && <span>✗</span>}
                {c.kind === 'running' && (
                  <span className={`inline-flex size-[5px] rounded-full ${liveNow ? 'animate-pulse' : ''} ${TONE.dot}`} />
                )}
                {c.kind === 'paused' && <span className="text-pop-amber">⏸</span>}
                {c.kind === 'waiting' && <span className="text-pop-amber">◇</span>}
                {c.label}
                {c.sub && (
                  <span className={`text-[9px] tabular-nums ${c.sub.done === c.sub.total ? 'text-pop-green/90' : 'text-pop-dim/80'}`}>
                    {c.sub.done}/{c.sub.total}
                  </span>
                )}
                {c.ms != null && c.ms >= 1000 && (
                  <span className="text-[9.5px] tabular-nums opacity-70">{formatRunClock(c.ms)}</span>
                )}
              </span>
            ))}
            {hiddenNodes > 0 && (
              <span
                title={`还有 ${hiddenNodes} 个节点未列出，明细见运行窗`}
                className="inline-flex shrink-0 items-center rounded border border-dashed border-pop-bd/60 px-1.5 py-[1px] text-[10px] text-pop-dim/60"
              >
                +{hiddenNodes}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
