import type {
  CabinAttentionItem, CabinHealth, CabinStatus,
} from "@octopus/shared"

/**
 * deriveCabinView — PURE attention/health aggregation (K3: never stored).
 * Mirrors derive-task-view discipline: no DAO / fs / clock; caller gathers rows.
 * "awaiting" = whom the work waits for (superagent stage.ts), first-match wins.
 */

export interface DeriveTaskInput {
  id: string
  name: string
  /** Derived task status (from deriveTaskView), not the raw column. */
  status: string
  /** 任务行原始状态（draft / ready / running / …）。
   *  派生 status 会把「草稿」和「已入列」都折成 ready；start 需要靠它区分
   *  「待入列」与「待触发」。缺省（老调用方）不产 start 项。 */
  rawStatus?: string
  /** v4 且所有 phase 都绑了 workflowRef —— 入队 gate 的静态前提。
   *  只有为真才把 draft 认成「待入列」，避免把还在写规格的草稿也当成待办。 */
  enqueueReady?: boolean
  repo?: string | null
  branch?: string | null
  /** design 25 §4.1：派生句柄 / 颜色（不落库）。 */
  handle?: string
  color?: number
}

export interface DeriveExecutionInput {
  id: string
  task_id: string | null
  status: string
}

export interface DeriveIncidentInput {
  id: string
  task_id: string | null
  status: string
  title: string
}

export interface DeriveAskInput {
  id: string
  task_id: string | null
  title: string
  question?: string
  /** design 26：有决策票据的提问把信封一起带进 attention（可选）。 */
  ask?: CabinAttentionItem["ask"]
}

export interface DeriveFindingInput {
  id: string
  title: string
  status: string
}

export interface DeriveJobInput {
  id: string
  kind: string
  ref_id: string | null
  title: string
  /** 任务主线程是否在流式（作者 agent 在推进）。start 项在作者干活时先不冒出来。 */
  agent_running?: boolean
}

/** 独立委派（design 25 §4.2）：与 workload 同级的第二种工作实体。 */
export interface DeriveDelegationInput {
  id: string
  title: string
  state: "queued" | "running" | "waiting_input" | "done" | "failed" | "cancelled"
  /** 完成结论（state=done 时进「已完成」条目的正文）。 */
  summary?: string | null
  /** 派生句柄：`D1`。由调用方按创建顺序分配。 */
  handle?: string
  color?: number
}

export interface DeriveCabinInput {
  cabin: { id: string; status: CabinStatus }
  tasks: DeriveTaskInput[]
  executions: DeriveExecutionInput[]
  incidents: DeriveIncidentInput[]
  asks: DeriveAskInput[]
  findings: DeriveFindingInput[]
  jobs: DeriveJobInput[]
  delegations?: DeriveDelegationInput[]
  /** 已 ack 的 attention id（cabin_attention_acks）：只过滤 notice 类完成项。 */
  acked?: readonly string[]
  maxWorkers: number
}

export interface DerivedCabinView {
  attention: CabinAttentionItem[]
  health: CabinHealth
  open_findings: number
}

const AWAITING_ORDER: Record<CabinAttentionItem["awaiting"], number> = {
  person: 0, working: 1, idle: 2, ended: 3,
}

export function deriveCabinView(input: DeriveCabinInput): DerivedCabinView {
  const { cabin, tasks, executions, incidents, asks, findings, jobs, delegations = [], maxWorkers } = input
  const acked = new Set(input.acked ?? [])
  const jobByTask = new Map<string, DeriveJobInput>()
  for (const j of jobs) if (j.kind === "task" && j.ref_id) jobByTask.set(j.ref_id, j)
  const taskById = new Map(tasks.map(t => [t.id, t]))
  // start（待放行）的去重护栏：同一条任务已经有「等你答」或「受阻」时，
  // 不再额外冒一条「待入列 / 待触发 / 待恢复」——人先处理更紧要的那条。
  const askTaskIds = new Set(
    asks.map(a => a.task_id).filter((v): v is string => !!v),
  )
  const blockedTaskIds = new Set(
    incidents
      .filter(i => i.status === "waiting_human" && i.task_id)
      .map(i => i.task_id as string),
  )

  const attention: CabinAttentionItem[] = []
  const push = (a: CabinAttentionItem) => attention.push(a)
  /** 两种工作实体共用一套 attention：subject / handle / color 由这里统一挂上。 */
  const subjectOf = (taskId: string | null): Pick<CabinAttentionItem, "subject" | "handle" | "color"> => {
    if (!taskId) return {}
    const t = taskById.get(taskId)
    return {
      subject: { kind: "task", id: taskId },
      ...(t?.handle ? { handle: t.handle } : {}),
      ...(t?.color !== undefined ? { color: t.color } : {}),
    }
  }

  for (const t of tasks) {
    const job = jobByTask.get(t.id)
    const subject = subjectOf(t.id)
    if (t.status === "awaiting_review") {
      push({
        id: `review-${t.id}`, job_id: job?.id ?? null, stage: "review", awaiting: "person",
        title: `${t.name} · 待验收`, task_id: t.id, repo: t.repo ?? null, wt: t.branch ?? null,
        deep_link: `task:${t.id}`, ...subject,
      })
    } else if (t.status === "awaiting_archive") {
      push({
        id: `archive-${t.id}`, job_id: job?.id ?? null, stage: "review", awaiting: "person",
        title: `${t.name} · 待归档`, task_id: t.id, repo: t.repo ?? null, wt: t.branch ?? null,
        deep_link: `task:${t.id}`, ...subject,
      })
    } else if (t.status === "failed") {
      push({
        id: `failed-${t.id}`, job_id: job?.id ?? null, stage: "blocked", awaiting: "person",
        title: `${t.name} · 失败已升级`, task_id: t.id, repo: t.repo ?? null, wt: t.branch ?? null,
        deep_link: `task:${t.id}`, ...subject,
      })
    } else if (t.status === "done") {
      // 2026-11-19 用户 #9：执行完先回流进 inbox，汐音审一道 / 人可确认无需回复。
      // 重新完成会换 id（重新开写用后续任务，不会复用 done），旧 ack 不误吞。
      const noticeId = `done-task-${t.id}`
      if (!acked.has(noticeId)) {
        push({
          id: noticeId, job_id: job?.id ?? null, stage: "notice", awaiting: "person",
          title: `${t.name} · 已完成`, detail: "执行与归档已收口，确认无需回复就收下",
          task_id: t.id, repo: t.repo ?? null, wt: t.branch ?? null,
          deep_link: `task:${t.id}`, ...subject,
        })
      }
    } else if (t.rawStatus && (t.status === "paused" || t.status === "ready")) {
      // 待放行（start）：任务停在「等人给一脚」的门上。
      //   · paused            → 待恢复
      //   · raw ready         → 已入列，待你触发
      //   · raw draft + 绑定齐 → 待你入列（草稿还没到这一步时不冒出来）
      // raw running + 派生 ready 是「阶段之间的瞬时等待」，不归人，不产项。
      // 作者主线程在流式（agent_running）或已有更紧要的提问/受阻时也不产。
      if (!askTaskIds.has(t.id) && !blockedTaskIds.has(t.id) && !job?.agent_running) {
        const startKind: "enqueue" | "trigger" | "resume" | null = t.status === "paused"
          ? "resume"
          : t.rawStatus === "ready"
            ? "trigger"
            : t.rawStatus === "draft" && t.enqueueReady
              ? "enqueue"
              : null
        const label = startKind === "resume"
          ? "待恢复"
          : startKind === "trigger"
            ? "待触发"
            : startKind === "enqueue"
              ? "待入列"
              : null
        if (label && startKind) {
          const detail = label === "待入列"
            ? "规格与 phase 绑定已齐，等你入列"
            : label === "待触发"
              ? "已入列，等你触发执行"
              : "已暂停，等你恢复推进"
          push({
            id: `start-${t.id}`, job_id: job?.id ?? null, stage: "start", awaiting: "person",
            title: `${t.name} · ${label}`, detail, task_id: t.id, start_kind: startKind,
            repo: t.repo ?? null, wt: t.branch ?? null,
            deep_link: `task:${t.id}`, ...subject,
          })
        }
      }
    }
  }
  for (const e of executions) {
    if (e.status === "pending_approval") {
      const t = e.task_id ? taskById.get(e.task_id) : undefined
      push({
        id: `approval-${e.id}`, job_id: e.task_id ? (jobByTask.get(e.task_id)?.id ?? null) : null,
        stage: "approval", awaiting: "person", title: `${t?.name ?? e.id} · 待审批`,
        task_id: e.task_id, repo: t?.repo ?? null, wt: t?.branch ?? null,
        deep_link: `execution:${e.id}`,
        ...subjectOf(e.task_id),
      })
    }
  }
  for (const inc of incidents) {
    if (inc.status === "waiting_human") {
      push({
        id: `incident-${inc.id}`, job_id: inc.task_id ? (jobByTask.get(inc.task_id)?.id ?? null) : null,
        stage: "blocked", awaiting: "person", title: inc.title,
        task_id: inc.task_id, repo: null, wt: null, deep_link: `incident:${inc.id}`,
        ...subjectOf(inc.task_id),
      })
    }
  }
  for (const a of asks) {
    push({
      id: `ask-${a.id}`, job_id: a.task_id ? (jobByTask.get(a.task_id)?.id ?? null) : null,
      stage: "answer", awaiting: "person", title: a.title, question: a.question,
      task_id: a.task_id, repo: null, wt: null, deep_link: `ask:${a.id}`,
      ...subjectOf(a.task_id),
      ...(a.ask ? { ask: a.ask } : {}),
    })
  }
  for (const f of findings) {
    if (f.status === "open") {
      push({
        id: `finding-${f.id}`, job_id: null, stage: "adjudicate", awaiting: "person",
        title: f.title, task_id: null, repo: null, wt: null, deep_link: `finding:${f.id}`,
      })
    }
  }
  // 委派（design 25 §4.2）：waiting_input → answer；failed → blocked；
  // done 不产 attention（只留回执，免得跑一趟的小事把决策队列占满）。
  for (const d of delegations) {
    const subject = {
      subject: { kind: "delegation" as const, id: d.id },
      ...(d.handle ? { handle: d.handle } : {}),
      ...(d.color !== undefined ? { color: d.color } : {}),
    }
    if (d.state === "waiting_input") {
      push({
        id: `delegation-ask-${d.id}`, job_id: null, stage: "answer", awaiting: "person",
        title: `${d.title} · 委派在问你`, task_id: null, repo: null, wt: null,
        deep_link: `delegation:${d.id}`, ...subject,
      })
    } else if (d.state === "done") {
      // 2026-11-19 用户 #9：完成回流进 inbox；汐音审一道 / 人可确认无需回复。
      const noticeId = `done-delegation-${d.id}`
      if (!acked.has(noticeId)) {
        push({
          id: noticeId, job_id: null, stage: "notice", awaiting: "person",
          title: `${d.title} · 已完成`, ...(d.summary ? { detail: d.summary } : {}),
          task_id: null, repo: null, wt: null,
          deep_link: `delegation:${d.id}`, ...subject,
        })
      }
    } else if (d.state === "failed") {
      push({
        id: `delegation-failed-${d.id}`, job_id: null, stage: "blocked", awaiting: "person",
        title: `${d.title} · 委派失败`, task_id: null, repo: null, wt: null,
        deep_link: `delegation:${d.id}`, ...subject,
      })
    }
  }

  attention.sort((a, b) => AWAITING_ORDER[a.awaiting] - AWAITING_ORDER[b.awaiting])

  const running = executions.filter(e => e.status === "running").length
  const queued = executions.filter(e => e.status === "pending" || e.status === "queued").length
  const health: CabinHealth = {
    running, queued,
    dormant: cabin.status === "dormant" ? 1 : 0,
    workers: running, max: maxWorkers,
  }

  return {
    attention, health,
    open_findings: findings.filter(f => f.status === "open").length,
  }
}