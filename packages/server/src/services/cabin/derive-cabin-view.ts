import type {
  CabinAttentionItem, CabinHealth, CabinIteration, CabinStatus,
} from "@octopus/shared"

/**
 * deriveCabinView — PURE attention/health/iteration aggregation (K3: never stored).
 * Mirrors derive-task-view discipline: no DAO / fs / clock; caller gathers rows.
 * "awaiting" = whom the work waits for (superagent stage.ts), first-match wins.
 */

export interface DeriveTaskInput {
  id: string
  name: string
  /** Derived task status (from deriveTaskView), not the raw column. */
  status: string
  iteration_id: string | null
  repo?: string | null
  branch?: string | null
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

export interface DeriveIterationInput {
  id: string
  code: string
  name: string
  sort_order: number
  status: "pending" | "active" | "done"
}

export interface DeriveCabinInput {
  cabin: { id: string; status: CabinStatus; focused_job_id: string | null }
  tasks: DeriveTaskInput[]
  executions: DeriveExecutionInput[]
  incidents: DeriveIncidentInput[]
  asks: DeriveAskInput[]
  findings: DeriveFindingInput[]
  jobs: DeriveJobInput[]
  iterations: DeriveIterationInput[]
  maxWorkers: number
}

export interface DerivedCabinView {
  attention: CabinAttentionItem[]
  health: CabinHealth
  iterations: CabinIteration[]
  open_findings: number
}

const AWAITING_ORDER: Record<CabinAttentionItem["awaiting"], number> = {
  person: 0, working: 1, idle: 2, ended: 3,
}

export function deriveCabinView(input: DeriveCabinInput): DerivedCabinView {
  const { cabin, tasks, executions, incidents, asks, findings, jobs, iterations, maxWorkers } = input
  const jobByTask = new Map<string, DeriveJobInput>()
  for (const j of jobs) if (j.kind === "task" && j.ref_id) jobByTask.set(j.ref_id, j)
  const priorityOf = (taskId: string | null): number =>
    taskId ? (jobByTask.get(taskId)?.priority ?? 0) : 0
  const taskById = new Map(tasks.map(t => [t.id, t]))

  const attention: CabinAttentionItem[] = []
  const push = (a: Omit<CabinAttentionItem, "priority"> & { priority?: number }) =>
    attention.push({ ...a, priority: a.priority ?? 0 })

  for (const t of tasks) {
    const job = jobByTask.get(t.id)
    if (t.status === "awaiting_review") {
      push({
        id: `review-${t.id}`, job_id: job?.id ?? null, stage: "review", awaiting: "person",
        title: `${t.name} · 待验收`, task_id: t.id, repo: t.repo ?? null, wt: t.branch ?? null,
        deep_link: `task:${t.id}`, priority: job?.priority ?? 0,
      })
    } else if (t.status === "awaiting_archive") {
      push({
        id: `archive-${t.id}`, job_id: job?.id ?? null, stage: "review", awaiting: "person",
        title: `${t.name} · 待归档`, task_id: t.id, repo: t.repo ?? null, wt: t.branch ?? null,
        deep_link: `task:${t.id}`, priority: job?.priority ?? 0,
      })
    } else if (t.status === "failed") {
      push({
        id: `failed-${t.id}`, job_id: job?.id ?? null, stage: "blocked", awaiting: "person",
        title: `${t.name} · 失败已升级`, task_id: t.id, repo: t.repo ?? null, wt: t.branch ?? null,
        deep_link: `task:${t.id}`, priority: job?.priority ?? 0,
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
      })
    }
  }
  for (const inc of incidents) {
    if (inc.status === "waiting_human") {
      push({
        id: `incident-${inc.id}`, job_id: inc.task_id ? (jobByTask.get(inc.task_id)?.id ?? null) : null,
        stage: "blocked", awaiting: "person", title: inc.title,
        task_id: inc.task_id, repo: null, wt: null, deep_link: `incident:${inc.id}`,
        priority: priorityOf(inc.task_id),
      })
    }
  }
  for (const a of asks) {
    push({
      id: `ask-${a.id}`, job_id: a.task_id ? (jobByTask.get(a.task_id)?.id ?? null) : null,
      stage: "answer", awaiting: "person", title: a.title, question: a.question,
      task_id: a.task_id, repo: null, wt: null, deep_link: `ask:${a.id}`,
      priority: priorityOf(a.task_id),
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

  attention.sort((a, b) =>
    AWAITING_ORDER[a.awaiting] - AWAITING_ORDER[b.awaiting] || b.priority - a.priority)

  const running = executions.filter(e => e.status === "running").length
  const queued = executions.filter(e => e.status === "pending" || e.status === "queued").length
  const health: CabinHealth = {
    running, queued,
    dormant: cabin.status === "dormant" ? 1 : 0,
    workers: running, max: maxWorkers,
  }

  const derivedIterations: CabinIteration[] = iterations.map(it => {
    const members = tasks.filter(t => t.iteration_id === it.id)
    const done = members.filter(t => t.status === "done").length
    return {
      id: it.id, cabin_id: cabin.id, code: it.code, name: it.name,
      sort_order: it.sort_order, status: it.status,
      task_count: members.length,
      progress: members.length ? Math.round((done / members.length) * 100) : 0,
    }
  })

  return {
    attention, health, iterations: derivedIterations,
    open_findings: findings.filter(f => f.status === "open").length,
  }
}