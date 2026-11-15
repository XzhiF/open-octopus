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
  priority: number
}

/** 独立委派（design 25 §4.2）：与 workload 同级的第二种工作实体。 */
export interface DeriveDelegationInput {
  id: string
  title: string
  state: "queued" | "running" | "waiting_input" | "done" | "failed" | "cancelled"
  /** 派生句柄：`D1`。由调用方按创建顺序分配。 */
  handle?: string
  color?: number
}

export interface DeriveCabinInput {
  cabin: { id: string; status: CabinStatus; focused_job_id: string | null }
  tasks: DeriveTaskInput[]
  executions: DeriveExecutionInput[]
  incidents: DeriveIncidentInput[]
  asks: DeriveAskInput[]
  findings: DeriveFindingInput[]
  jobs: DeriveJobInput[]
  delegations?: DeriveDelegationInput[]
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
  const jobByTask = new Map<string, DeriveJobInput>()
  for (const j of jobs) if (j.kind === "task" && j.ref_id) jobByTask.set(j.ref_id, j)
  const priorityOf = (taskId: string | null): number =>
    taskId ? (jobByTask.get(taskId)?.priority ?? 0) : 0
  const taskById = new Map(tasks.map(t => [t.id, t]))

  const attention: CabinAttentionItem[] = []
  const push = (a: Omit<CabinAttentionItem, "priority"> & { priority?: number }) =>
    attention.push({ ...a, priority: a.priority ?? 0 })
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
        deep_link: `task:${t.id}`, priority: job?.priority ?? 0, ...subject,
      })
    } else if (t.status === "awaiting_archive") {
      push({
        id: `archive-${t.id}`, job_id: job?.id ?? null, stage: "review", awaiting: "person",
        title: `${t.name} · 待归档`, task_id: t.id, repo: t.repo ?? null, wt: t.branch ?? null,
        deep_link: `task:${t.id}`, priority: job?.priority ?? 0, ...subject,
      })
    } else if (t.status === "failed") {
      push({
        id: `failed-${t.id}`, job_id: job?.id ?? null, stage: "blocked", awaiting: "person",
        title: `${t.name} · 失败已升级`, task_id: t.id, repo: t.repo ?? null, wt: t.branch ?? null,
        deep_link: `task:${t.id}`, priority: job?.priority ?? 0, ...subject,
      })
    }
  }
  for (const e of executions) {
    if (e.status === "pending_approval") {
      const t = e.task_id ? taskById.get(e.task_id) : undefined
      push({
        id: `approval-${e.id}`, job_id: e.task_id ? (jobByTask.get(e.task_id)?.id ?? null) : null,
        stage: "approval", awaiting: "person", title: `${t?.name ?? e.id} · 待审批`,
        task_id: e.task_id, repo: t?.repo ?? null, wt: t?.branch ?? null,
        deep_link: `execution:${e.id}`, priority: priorityOf(e.task_id),
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
        priority: priorityOf(inc.task_id), ...subjectOf(inc.task_id),
      })
    }
  }
  for (const a of asks) {
    push({
      id: `ask-${a.id}`, job_id: a.task_id ? (jobByTask.get(a.task_id)?.id ?? null) : null,
      stage: "answer", awaiting: "person", title: a.title, question: a.question,
      task_id: a.task_id, repo: null, wt: null, deep_link: `ask:${a.id}`,
      priority: priorityOf(a.task_id), ...subjectOf(a.task_id),
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
    } else if (d.state === "failed") {
      push({
        id: `delegation-failed-${d.id}`, job_id: null, stage: "blocked", awaiting: "person",
        title: `${d.title} · 委派失败`, task_id: null, repo: null, wt: null,
        deep_link: `delegation:${d.id}`, ...subject,
      })
    }
  }

  attention.sort((a, b) =>
    AWAITING_ORDER[a.awaiting] - AWAITING_ORDER[b.awaiting] || b.priority - a.priority)

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