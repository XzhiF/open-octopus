// packages/server/src/services/tasks/task-lifecycle-service.ts
//
// ADR-0021 票03 — the built-in `task-lifecycle` job's body.
//
// This is the ONE unit in the system allowed to know both worlds: it reads `tasks`
// (what to run, when) and writes `executions` (that it ran). The scheduler knows
// neither — it fires this job on a cron like any other job — and the task board knows
// no scheduling at all. That replaces the v39 envelope: `readyTask` used to pre-create a
// private `schedules` row per task and parking/flipping/claiming/reflecting that row WAS
// the coupling (180 references in one file, three schedule tables written from the task
// domain, `config` doubling as both the frozen phase binding and the "which round is
// running now" cursor).
//
// Four duties, all idempotent, all safe to run every minute and twice in parallel:
//
//   ① ARM     due-scan `tasks.next_fire_at` → one `executions` row per due task, status
//             'pending', carrying task_id + (phase, round). The insert either succeeds
//             (this task now has an instance) or hits ux_exec_task_active (an instance is
//             already live → this fire is suppressed, which is exactly the cron
//             double-fire rule the old code enforced with ~10 guard queries).
//   ② LAUNCH  claim queued rows oldest-first while the shared concurrency gate has room
//             (countActiveWork spans job fires AND launched task rows), then start.
//   ③ WATCH   a terminal engine callback finalizes the round (collect artifacts, emit
//             待验收, mirror tasks.status) with zero latency; the tick's ④ backstops it.
//   ④ RECONCILE  resolve rows whose engine is not in this process — crashed, restarted,
//             or cancelled out of band. Same source as the old orphan reaper, but with
//             the executions table as its only input, so a deleted row can no longer hide
//             a live task and a live row can no longer be counted as work by two owners.
//
// Every step is a synchronous better-sqlite3 transaction segment, so two overlapping
// rounds (wake() + the 60s tick) cannot interleave inside a step; where a step DOES span
// an await (engine start), the state transition is a guarded UPDATE so the loser of the
// race sees changes===0 and stands down.

import type Database from "better-sqlite3"
import path from "path"
import type { TaskSpec, ResourceRef, WorkflowConfig, TriggerMode } from "@octopus/shared"
import {
  TERMINAL_EXECUTION_STATUSES,
  WAITING_EXECUTION_STATUSES,
  TASK_STATUS_EVENT,
  TASK_EXECUTION_EVENT,
  TASK_TRIGGER_FAILED_EVENT,
  TASK_ARTIFACTS_UPDATE_EVENT,
} from "@octopus/shared"
import type { TaskRow, ExecutionRow } from "../../db/types"
import { TaskDAO } from "../../db/dao/task-dao"
import { ExecutionDAO } from "../../db/dao/execution-dao"
import { ScheduleRunDAO } from "../../db/dao/schedule-run-dao"
import type { SSEService } from "../sse"
import type { WorkspaceService } from "../workspace"
import { getExecutionService } from "../execution-service-registry"
import { getResourceRegistry } from "../resource-registry"
import { BuiltInWorkflowService } from "../builtin-workflow"
import { TaskHomeService } from "./task-home-service"
import { resolveWorkflowRef } from "./workflow-ref-resolver"
import {
  batchRelPath,
  seedPhaseToWorkspace,
  collectFromWorkspace,
  copyTaskWorkflowsToWs,
  emitPhaseAwaitingReview,
} from "./task-artifact-sync"
import {
  buildTaskLaunchConfig,
  buildCompositeInputValues,
  resolveV4Phases,
  resolveTaskLaunchStep,
  type TaskV4PhaseConfig,
} from "./task-materialize"
import { computeTaskWsLaunchParams, isCompositeWorkflowConfig } from "../scheduler/ws-launch"
import { startChildRun, resumeParentFromChild } from "./task-child-run"
import { calculateNextExecutions } from "../cron-utils"
// The cap constant + the stale threshold are pure numbers (no schedule state); see the
// boundary rule in __tests__/task-scheduler-boundary.test.ts for what is and is not
// allowed to cross from the tasks domain.
import { MAX_PARALLEL_WORKSPACES, STALE_CLAIMED_THRESHOLD_MS } from "../scheduler/concurrency"

/** Why an arm was refused — the route maps these to HTTP codes / user-facing copy. */
export type TaskArmRefusal =
  | "not-found"        // task row gone (or soft-deleted)
  | "not-ready"        // only an enqueued task can run
  | "in-flight"        // ux_exec_task_active: a live instance already exists
  | "no-workflow"      // nothing bound to run (v3 without workflow_ref)
  | "gate"             // the v4 phase contract no longer resolves (spec deleted…)
  | "workspace"        // the workspace/worktrees could not be prepared

export class TaskLifecycleError extends Error {
  constructor(readonly reason: TaskArmRefusal, message: string) {
    super(message)
    this.name = "TaskLifecycleError"
  }
}

export interface ArmOptions {
  phaseIndex?: number
  roundIndex?: number
  feedback?: string
  /** ADR-0018 打回二分路由: swap this round's workflow (e.g. built-in/task-fix). */
  workflowRefOverride?: string
  /** Replace the phase's input_values wholesale (fix-round synthesis). */
  inputOverride?: Record<string, string>
  /** 阶段衔接信道: accepted predecessor handoff.md paths. */
  prevHandoffPaths?: string[]
  /** Who asked, for the execution's `triggered_by` audit column. */
  triggeredBy?: string
}

export interface TickMetrics {
  armed: number
  launched: number
  resynced: number
  reaped: number
  /** Arming attempts refused (in-flight suppressions and gate failures); each carries a
   *  log line — the count is for the ops page's "why did nothing happen" answer. */
  refused: number
  /** True when the tick ended because the shared cap was reached; the next tick (or a
   *  completion callback) retries, so a full board never loses an armed task. */
  capped: boolean
}

const isTerminal = (status: string): boolean => TERMINAL_EXECUTION_STATUSES.includes(status)
/**
 * Parse a timestamp out of the DB. Two dialects live in these columns: the DAO writes
 * `new Date().toISOString()` (marker-carrying), while anything that lets SQLite fill the
 * column — `datetime('now')`, a table DEFAULT — writes UTC **without** a marker, which
 * `Date.parse` then reads as *local* time. On a UTC+8 deployment that is 8 hours of
 * phantom age on a row born one second ago, and the stranded-row reaper would kill live
 * runs a tick after they start. SQLite's `datetime('now')` means UTC, so a naive string
 * is read as UTC.
 */
function dbTimeMs(s: string | null | undefined): number {
  if (!s) return NaN
  const t = s.trim()
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t)) {
    return Date.parse(`${t.replace(" ", "T")}Z`)
  }
  return Date.parse(t)
}

const isWaiting = (status: string): boolean => WAITING_EXECUTION_STATUSES.includes(status)

/** K3's subject — a v4 task's card is human-decided, so no machine outcome writes it. */
function isV4Spec(raw: string | null | undefined): boolean {
  return parseJSON<{ format?: string }>(raw, {}).format === "v4"
}

function parseJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export class TaskLifecycleService {
  private taskDAO: TaskDAO
  private execDAO: ExecutionDAO
  private runDAO: ScheduleRunDAO
  private home: TaskHomeService
  private builtIn: BuiltInWorkflowService | null = null

  constructor(private deps: {
    db: Database.Database
    sse: SSEService
    /** Absent in unit tests that only exercise arming (no git, no worktrees). */
    workspaceService?: WorkspaceService | null
    builtInWorkflows?: BuiltInWorkflowService | null
    /** Injectable for the same reason TasksService takes it: the home root is derived
     *  from $HOME, which tests redirect rather than touch. */
    taskHomeService?: TaskHomeService
  }) {
    this.taskDAO = new TaskDAO(deps.db)
    this.execDAO = new ExecutionDAO(deps.db)
    this.runDAO = new ScheduleRunDAO(deps.db)
    this.builtIn = deps.builtInWorkflows ?? null
    this.home = deps.taskHomeService ?? new TaskHomeService()
  }

  // ── ①+②+④ the tick ────────────────────────────────────────────────

  /**
   * One round of the built-in job. Ordered deliberately: reconcile BEFORE arming so a
   * round whose engine died releases the task's slot before this tick tries to arm the
   * next one (arming first would report a spurious 在飞 refusal for a task that is
   * actually dead on disk).
   */
  tick(nowIso = new Date().toISOString()): TickMetrics {
    const m: TickMetrics = { armed: 0, launched: 0, resynced: 0, reaped: 0, refused: 0, capped: false }

    const rec = this.reconcile(nowIso)
    m.resynced = rec.resynced
    m.reaped = rec.reaped

    for (const task of this.taskDAO.findDueTriggers(nowIso, 50)) {
      try {
        this.armTask(task.id, { triggeredBy: "task-lifecycle" })
        m.armed++
        // The cursor is retired on the SUCCESS path, not incidentally: leaving a due
        // cursor in place would re-scan this task on every tick until the latch happened
        // to refuse it, which is a retry loop masquerading as a scheduler.
        this.retireFireCursor(task, new Date().toISOString())
      } catch (err: unknown) {
        if (err instanceof TaskLifecycleError && err.reason === "in-flight") {
          // A previous round of this task is still live. Suppress THIS fire but still
          // advance the cursor for a cron task, or the same task would be re-scanned
          // (and re-suppressed) every minute forever. A once task retires either way.
          this.retireFireCursor(task, nowIso)
          m.refused++
          console.log(`[task-lifecycle] ${task.id}: 上一轮仍在运行,本次触发跳过`)
          continue
        }
        this.failArm(task, err)
        m.refused++
      }
    }

    const claim = this.launchQueued()
    m.launched = claim.launched
    m.capped = claim.capped

    return m
  }

  /**
   * ② Claim armed root launches, oldest first, until the shared gate is full.
   *
   * The gate is `countActiveWork()` — job fires plus task rows that are actually running
   * (an armed 'pending' row is excluded there on purpose: it holds the task's identity
   * slot, not a compute slot; counting it would make the queue block itself).
   */
  launchQueued(limit = MAX_PARALLEL_WORKSPACES * 2): { launched: number; capped: boolean } {
    let launched = 0
    for (const row of this.execDAO.listClaimableTaskLaunches(limit)) {
      if (this.runDAO.countActiveWork() >= MAX_PARALLEL_WORKSPACES) {
        return { launched, capped: true }
      }
      // Guarded flip: two overlapping rounds can both see the same queued row, and only
      // the one whose UPDATE lands gets to start it. Without this guard a wake() racing
      // the 60s tick launches a task twice — the concurrency case the whole design is
      // gated on.
      if (this.execDAO.claimLaunch(row.id).changes === 0) continue
      try {
        // A composite child needs the PARENT-resume wiring, not the task finalize — the
        // parent is what decides what a finished subunit means. Claimed here rather than
        // in TaskDispatchService so an over-cap child has exactly one owner.
        if (row.parent_id && row.parent_id !== "0") {
          const iv = parseJSON<Record<string, string>>(row.input_values, {})
          // alreadyClaimed=true: this loop moved the row pending→running just above,
          // under the guarded claim that keeps two owners from both starting it.
          if (!startChildRun(this.deps.db, row.id, row.workspace_id, iv, true)) continue
        } else {
          this.startRow(row)
        }
        launched++
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[task-lifecycle] launch failed for execution ${row.id}:`, message)
        this.execDAO.setLaunchStatus(row.id, "failed", {
          completedAt: new Date().toISOString(),
          error: `领取后启动失败: ${message}`,
        })
        this.finishTaskOutcome(row.task_id as string, "failed")
      }
    }
    return { launched, capped: false }
  }

  /** Start an already-claimed row on its workspace. */
  private startRow(row: ExecutionRow): void {
    const registry = getExecutionService(row.workspace_id)
    if (!registry) throw new Error(`workspace ${row.workspace_id} 不可用（行缺失或路径失效）`)
    const inputValues = parseJSON<Record<string, string>>(row.input_values, {})

    // The `as never` pair below is the engine-callback arity mismatch the pre-票03
    // dispatchPhaseRound had too: ExecutionService takes Partial<EngineCallbacks>, whose
    // onComplete is typed for the engine's own finalization payload, while the task side
    // only needs the terminal status string. Typing it properly belongs to the engine
    // boundary, not here — casting keeps one narrow lie instead of a fake wrapper.
    registry.service.registerExternalCallbacks(
      {
        onComplete: ((engineFinalStatus?: string) => {
          this.finalizeLaunch(row.id, engineFinalStatus)
        }) as unknown as (finalStatus?: string) => void,
      } as never,
      row.id,
    )

    registry.service.start(row.id, inputValues).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[task-lifecycle] start failed for execution ${row.id}:`, message)
      this.execDAO.setLaunchStatus(row.id, "failed", {
        completedAt: new Date().toISOString(),
        error: `启动失败: ${message}`,
      })
      registry.service.clearExternalCallbacks(row.id)
      this.finalizeLaunch(row.id, "failed")
    })

    // The board's own status column moves when the engine actually starts — not when the
    // row is armed. Under the envelope these were the same moment (flipping the row to
    // 'queued' mirrored 'running' immediately, so a queued task LOOKED like it was
    // working while the cap had it parked). Splitting them is the visible half of the
    // decoupling: 排队中 and 执行中 are now different facts.
    this.mirrorTaskStatus(row.task_id as string, "running")
    this.deps.sse.emit("taskpool", {
      event: TASK_EXECUTION_EVENT,
      data: {
        task_id: row.task_id,
        execution_id: row.id,
        status: "running",
        phase_index: row.phase_index,
        round_index: row.round_index,
      },
    })
  }

  // ── ① arm ──────────────────────────────────────────────────────────

  /**
   * Create the task's next instance as an armed `executions` row. This is the whole of
   * what `triggerTask` used to do by flipping an envelope, minus the envelope.
   *
   * The launch plan is materialized HERE rather than read back off a stored definition:
   * `buildTaskLaunchConfig` + `resolveV4Phases` are deterministic functions of
   * (task_spec, task home), so the phases binding needs no storage location at all. That
   * also fixes a latent staleness — under the envelope, editing a phase spec between
   * rounds only took effect if something remembered to rewrite chain[0].
   */
  armTask(taskId: string, opts: ArmOptions = {}): string {
    const task = this.taskDAO.getById(taskId)
    if (!task) throw new TaskLifecycleError("not-found", "任务不存在")
    // ready OR running. A v4 task stays 'running' between rounds on purpose (its 待验收
    // state is derived, and mirroring a machine transition onto the card is exactly what
    // K3 forbids) — so 验收打回 / 自动推进 / advance, which are all HUMAN authorizations
    // that happen while the row says 'running', must still be able to arm the next round.
    // Refusing them here would silently break the whole v4 flow: the pre-check used to be
    // moot because dispatch rewrote an envelope instead of arming a row.
    //
    // The human entry point (POST /:id/trigger) keeps its own stricter ready-only gate,
    // so this is not a loosening of 「触发」 — done/failed/aborted/archiving still cannot
    // arm anything, and a re-run remains a re-enqueue.
    if (task.status !== "ready" && task.status !== "running") {
      throw new TaskLifecycleError(
        "not-ready",
        `任务当前状态 '${task.status}' 不可起新一轮（仅 ready/running；已完成/已中止/归档中需重新入队）`,
      )
    }

    // Pre-check for a human-readable refusal; ux_exec_task_active below is the actual
    // serializer (the pre-check cannot close the race, the index can).
    const latest = this.execDAO.findLatestTaskRoot(taskId)
    if (latest && !isTerminal(latest.status)) {
      throw new TaskLifecycleError(
        "in-flight",
        `任务已有进行中的实例（${latest.status === "pending" ? "排队中" : "执行中"}），请等待本轮结束或先中止`,
      )
    }

    const spec = parseJSON<TaskSpec>(task.task_spec, { goal: "", ac: [] } as unknown as TaskSpec)
    const isV3OrV4 = spec.task_type !== undefined || spec.format === "v4"
    const artifactsDir = isV3OrV4 ? this.home.artifactsDir(taskId) : undefined
    const workflowsDir = isV3OrV4 ? this.home.workflowsDir(taskId) : undefined

    let v4Phases: TaskV4PhaseConfig[] | undefined
    if (spec.format === "v4") {
      const { missing, phases } = resolveV4Phases({
        taskSpec: spec,
        homeDir: this.home.homePath(taskId),
        taskArtifactsDir: this.home.artifactsDir(taskId),
        resolveRef: (ref) => this.resolveRef(taskId, ref),
      })
      if (missing.length > 0) {
        throw new TaskLifecycleError("gate", `任务契约已不再满足: missing ${missing.join(", ")}`)
      }
      v4Phases = phases
    }

    const plan = buildTaskLaunchConfig(
      spec,
      parseJSON<string[]>(task.project_ids, []),
      task.org ?? "",
      task.workflow_ref ?? undefined,
      parseJSON<string[]>(task.skills, []),
      parseJSON<ResourceRef[]>(task.resources, []),
      artifactsDir,
      workflowsDir,
      v4Phases,
    )

    const isComposite = isCompositeWorkflowConfig(plan)
    const wantsPhase = spec.format === "v4" && !isComposite
    // A phase index must exist BEFORE the step is resolved. resolveTaskLaunchStep
    // falls back to the generic chain[0] branch when it finds no such phase, which
    // would launch phase 1's workflow UNTAGGED — the row would hold the latch forever
    // while deriveTaskView and the acceptance ledger never see it (a silent dead-end the
    // pre-票03 code refused loudly with 「phase N 不在信封已解析的 phases[] 中」).
    if (wantsPhase && opts.phaseIndex != null) {
      const known = (v4Phases ?? []).some((ph) => ph.index === opts.phaseIndex)
      if (!known) {
        throw new TaskLifecycleError(
          "gate",
          `phase ${opts.phaseIndex} 不在任务已解析的 phases[] 中（共 ${(v4Phases ?? []).length} 项）`,
        )
      }
    }
    const step = resolveTaskLaunchStep({
      plan,
      phaseIndex: wantsPhase ? (opts.phaseIndex ?? 1) : undefined,
      roundIndex: wantsPhase ? (opts.roundIndex ?? 1) : undefined,
      feedback: opts.feedback,
      workflowRefOverride: opts.workflowRefOverride,
      inputOverride: opts.inputOverride,
      prevHandoffPaths: opts.prevHandoffPaths,
    })
    if (!step.workflowRef) {
      throw new TaskLifecycleError("no-workflow", "任务未绑定可执行的工作流（workflow_ref 为空）")
    }
    const inputValues: Record<string, string> = isComposite
      ? {
          ...(buildCompositeInputValues(spec, plan) as Record<string, string>),
          ...step.inputValues,
        }
      : step.inputValues

    const workspaceId = this.prepareWorkspace(task, plan)
    const registry = getExecutionService(workspaceId)
    if (!registry) {
      throw new TaskLifecycleError("workspace", `工作区 ${workspaceId} 不可用（行缺失或路径失效）`)
    }

    // ADR-0013: agent-authored workflow YAMLs must be inside the ws before the engine
    // resolves the ref. Non-fatal (the resolver reports "Workflow not found" clearly).
    if (workflowsDir) {
      try {
        copyTaskWorkflowsToWs(workflowsDir, registry.wsPath)
      } catch (err: unknown) {
        console.error(`[task-lifecycle] task_workflows copy failed (non-fatal):`, errMessage(err))
      }
    }
    // ADR-0018 seed 下行: mirror this phase's batch dir into the ws at the same relative
    // position (home OVERWRITES ws same-names — home is the draft baseline or the last
    // collected final state). Seeded per arm, so a spec edit lands on the next round.
    if (step.specDir) {
      try {
        const rel = batchRelPath(this.home.homePath(taskId), step.specDir)
        if (rel) {
          const seeded = seedPhaseToWorkspace(step.specDir, registry.wsPath, rel)
          if (seeded > 0) {
            console.log(
              `[task-lifecycle] seeded ${seeded} file(s) into ${registry.wsPath}/${rel} (task ${taskId} phase ${step.phaseIndex} round ${step.roundIndex})`,
            )
          }
        }
      } catch (err: unknown) {
        console.error(`[task-lifecycle] phase seed failed (non-fatal):`, errMessage(err))
      }
    }

    const nowIso = new Date().toISOString()
    // create() returns the execution-layer row shape (services/execution/types), which is
    // a different declaration from db/types' ExecutionRow; only the id is needed here.
    let executionId: string
    try {
      executionId = registry.service.create(workspaceId, {
        workflow_ref: step.workflowRef,
        triggered_by: opts.triggeredBy ?? "task-lifecycle",
        input_values: inputValues,
        // v4 rounds are independent roots on the task's ONE workspace; the v1
        // "one root per ws" invariant is the wrong serialization for a task (it would
        // allow two live instances of one task in separate ws while forbidding two
        // sequential rounds in the same one). task_id makes the exemption permanent —
        // ux_exec_task_active is what actually serializes this task.
        allow_existing_root: true,
        task_id: taskId,
        phase_index: step.phaseIndex,
        round_index: step.roundIndex,
        initial_var_pool: {
          "task.id": taskId,
          "task.name": task.name ?? "",
          "execution.trigger_type": step.phaseIndex != null ? "phase_round" : "task_launch",
          "task.triggered_at": nowIso,
        },
      }).id
    } catch (err: unknown) {
      // ux_exec_task_active is the answer to "is this task already running?"; a
      // SQLITE_CONSTRAINT_UNIQUE here is that answer arriving as an exception. Narrowed
      // to UNIQUE on purpose: reporting a NOT NULL or FK violation as "already running"
      // would turn a bug into a plausible-looking refusal.
      const message = errMessage(err)
      if (isUniqueViolation(err)) {
        throw new TaskLifecycleError("in-flight", `任务已有进行中的实例（本轮在飞），请等待结束或先中止: ${message}`)
      }
      throw new TaskLifecycleError("workspace", `执行创建失败: ${message}`)
    }

    const armed = this.execDAO.findById(executionId)
    this.deps.sse.emit("taskpool", {
      event: TASK_EXECUTION_EVENT,
      data: {
        task_id: taskId,
        execution_id: executionId,
        status: "pending",
        phase_index: armed?.phase_index ?? null,
        round_index: armed?.round_index ?? null,
      },
    })
    return executionId
  }

  /** The workspace a task's run happens in: the bound one if it lives (with worktree
   *  self-heal), otherwise a fresh build bound back to the task.
   *
   *  Names come from the shared ws-launch pure function so a workspace built here and one
   *  inspected by the git layer agree byte-for-byte; the instance key is the TASK id, so
   *  every round of a task inherits one branch lineage (it used to be the envelope id,
   *  which changed on reopen + re-enqueue). */
  prepareWorkspace(task: TaskRow, plan: WorkflowConfig): string {
    const ws = this.deps.workspaceService
    if (!ws) throw new TaskLifecycleError("workspace", "WorkspaceService 未注入，无法准备工作区")

    const bound = task.workspace_id ? ws.getById(task.workspace_id) : undefined
    if (bound) {
      try {
        ws.ensureWorktreesForReuse(bound)
        return bound.id
      } catch (err: unknown) {
        // A bound row that cannot self-heal is not "reuse and continue" — the run would
        // fail mid-workflow with a confusing git error. Surface it as the arm refusal it
        // is, so a scheduled task reports 启动失败 at the point of cause.
        throw new TaskLifecycleError("workspace", `预建工作区失败: ${errMessage(err)}`)
      }
    }

    const composite = isCompositeWorkflowConfig(plan)
    const { branchPrefix, branchSuffix, workspaceName } = computeTaskWsLaunchParams({
      instanceKey: task.id,
      naming: "task",
      config: plan,
      taskRow: task,
    })
    const projects = (plan.workspace_spec?.projects ?? []).filter(
      (p) => p.name && p.name !== "default",
    )
    try {
      const created = ws.createFromSpec({
        org: plan.workspace_spec?.org ?? task.org ?? "",
        name: workspaceName,
        // A coordinator workspace has NO projects by design (spec D4) — it only runs the
        // composition workflow, which fans out per-subunit workspaces itself.
        projects: composite ? [] : projects,
        branch_prefix: branchPrefix,
        branch_suffix: branchSuffix,
        source: "task",
        task_id: task.id,
        workflow_chain: plan.workflow_chain ?? [],
      })
      // Binding is a system event: no version bump, or an armed task would 409 the
      // authoring agent's next spec-field write.
      this.taskDAO
        .getDb()
        .prepare("UPDATE tasks SET workspace_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(created.id, new Date().toISOString(), task.id)
      // v41: the reverse pointer, so 「这个工作区属于哪个任务」 is a column read instead
      // of the old workspaces → schedules.origin_id join bridge.
      this.taskDAO
        .getDb()
        .prepare("UPDATE workspaces SET task_id = ? WHERE id = ?")
        .run(task.id, created.id)
      console.log(
        `[task-lifecycle] workspace ${created.id} (${workspaceName}) built for task ${task.id} — ${composite ? "coordinator" : `${projects.length} worktree(s)`}`,
      )
      return created.id
    } catch (err: unknown) {
      throw new TaskLifecycleError("workspace", `预建工作区失败: ${errMessage(err)}`)
    }
  }

  // ── ③ finalize ─────────────────────────────────────────────────────

  /**
   * A task round reached an end. Called synchronously from the engine callback (zero
   * latency) and idempotently from ④ (crash/missed-event backstop) — so it must never
   * assume it is the only caller, and never throw.
   */
  finalizeLaunch(executionId: string, engineFinalStatus?: string): void {
    try {
      const row = this.execDAO.findById(executionId)
      if (!row || !row.task_id) return
      // Re-entry: a terminal row was already finalized (the callback and the tick race,
      // and both are supposed to be safe). Everything below — collect, 待验收, mirrors —
      // already fired, and re-emitting it is exactly the SSE flood the old listener had
      // an explicit idempotence fast-path to avoid.
      if (isTerminal(row.status)) return
      // An approval/interaction pause is the engine ALIVE and waiting, not an end:
      // finalizing here would flip the card to 完成 and arm a next phase that could
      // never dispatch behind a live instance of the same task.
      if (isWaiting(row.status)) return
      const taskId = row.task_id
      // A composite child is not a round: its outcome belongs to the parent's waiting
      // node, and it must never drive the task card or open 待验收.
      const isChild = !!row.parent_id && row.parent_id !== "0"
      // Status resolution (goal-task-dev status-mirror lesson, verbatim ordering):
      // the persisted row wins when it already holds a FINAL status — it is written
      // after ExecutionLifecycle's allSkipped→failed adjustment and covers resume
      // re-entry; the engine's in-flight report covers the race where onComplete fires
      // before the persistence lands (the DB would still read 'running'). Anything else
      // normalizes to 'completed', which is what the old finalize did — a status the
      // engine reported that this list does not recognize must NOT be written verbatim,
      // or a new engine status silently becomes a task outcome nobody audited.
      const FINAL_REPORTABLE: readonly string[] = [
        "completed", "completed_with_failures", "failed", "cancelled", "rejected",
      ]
      const rowIsFinal = FINAL_REPORTABLE.includes(row.status)
      let status = rowIsFinal ? row.status : (engineFinalStatus ?? "completed")
      if (!FINAL_REPORTABLE.includes(status)) status = "completed"
      if (!rowIsFinal && status === "completed") {
        // Mirror ExecutionLifecycle's allSkipped→failed rule while trusting the in-flight
        // value: completed with zero real completed nodes but some skipped achieved
        // nothing. (Zero real nodes at all stays completed — the rule's length>0 guard.)
        const outcomes = this.execDAO.countRealNodeOutcomes(executionId)
        if (outcomes.completed === 0 && outcomes.skipped > 0) status = "failed"
      }

      let ok = status === "completed" || status === "completed_with_failures"
      // 票04 (父失败聚合, 取代 WorkflowExecutor 的 findFailedChildSchedules): composite
      // coordinator 自己的 workflow 即使有子失败也照样 completed —— 失败子单元会以 EMPTY
      // 输出回填 task_dispatch 节点,Loop 只管往下走。不在这里聚合,半个任务都没跑完的任务
      // 会显示「完成」。只查根(子没有子),且读子行自己的终态,重启后仍然成立。
      let failedChildren = 0
      if (ok && !isChild) {
        failedChildren = this.execDAO.findChildren(executionId).filter((c) =>
          ["failed", "aborted", "cancelled", "rejected"].includes(c.status),
        ).length
        if (failedChildren > 0) {
          ok = false
          status = "failed"
          console.log(
            `[task-lifecycle] task ${taskId}: ${executionId} 聚合 ${failedChildren} 条失败子执行 → failed`,
          )
        }
      }
      // A red run carries its reason on the row (var_pool.error), which is what the
      // badge's error_summary reads — see failureReason.
      const errorSummary = ok ? null : this.failureReason(row, executionId, failedChildren)
      this.execDAO.setLaunchStatus(executionId, status, {
        completedAt: new Date().toISOString(),
        duration: row.started_at ? Date.now() - dbTimeMs(row.started_at) : undefined,
        error: errorSummary ?? undefined,
      })

      const spec = parseJSON<TaskSpec>(this.taskDAO.getById(taskId)?.task_spec ?? "", {} as TaskSpec)
      const isV4 = spec.format === "v4"

      // task-phase-redesign (K9) collect 上行 — BEFORE any retention could reclaim the
      // ws: recover what the execution side changed in the batch dir back into the home.
      if (isChild) {
        // A child's outcome belongs to its parent's waiting node, not to the task card:
        // mirroring tasks.status or opening 待验收 for a subunit would be nonsense (in a
        // composite the COORDINATOR is the round; the children are its internals).
        resumeParentFromChild(this.deps.db, executionId).catch((err: unknown) =>
          console.error(`[task-lifecycle] child resume after finalize failed for ${executionId}:`, errMessage(err)))
        return
      }
      if (row.phase_index != null) {
        this.collectRound(row, taskId)
        // P3: terminal = the round awaits its human decision. Emit regardless of whether
        // collect moved a file (K3: 待验收 is human-decision state, not file flow).
        emitPhaseAwaitingReview(
          (c, p) => this.deps.sse.emit(c, p as { event: string; data: unknown }),
          taskId,
          row.phase_index,
          row.round_index ?? 1,
        )
      }

      // K3: a v4 round ending is NOT a human decision — the card goes to 待验收 (derived),
      // never to done/failed, or acceptance would become unreachable. v3/legacy tasks have
      // no acceptance gate, so their round IS the task outcome.
      this.finishTaskOutcome(taskId, ok ? "done" : "failed")

      this.deps.sse.emit("taskpool", {
        event: TASK_EXECUTION_EVENT,
        data: {
          task_id: taskId,
          execution_id: executionId,
          status: ok ? "completed" : status,
          phase_index: row.phase_index,
          round_index: row.round_index,
          ...(errorSummary ? { reason: errorSummary } : {}),
        },
      })
      // A slot just freed, so drain the queue now instead of letting the next armed
      // launch wait up to a cron minute. Re-entrancy is safe: claimLaunch is a guarded
      // UPDATE, and finalizeLaunch never throws (the guard is inside this try).
      try {
        this.launchQueued(1)
      } catch (err: unknown) {
        console.error(`[task-lifecycle] queue drain after ${executionId} failed:`, errMessage(err))
      }
      try {
        getExecutionService(row.workspace_id)?.service.clearExternalCallbacks(executionId)
      } catch { /* registry gone — the engine drops stale callbacks after terminal anyway */ }
    } catch (err: unknown) {
      console.error(
        `[task-lifecycle] finalizeLaunch failed for ${executionId} (non-fatal — the tick's reconcile backstops):`,
        errMessage(err),
      )
    }
  }

  private collectRound(row: ExecutionRow, taskId: string): void {
    try {
      const specDir = this.phaseSpecDir(taskId, row.phase_index as number)
      if (!specDir) return
      const rel = batchRelPath(this.home.homePath(taskId), specDir)
      if (!rel) return
      const registry = getExecutionService(row.workspace_id)
      if (!registry) return // ws gone out of band — home already holds the last collect
      const collected = collectFromWorkspace(path.join(registry.wsPath, rel), specDir)
      if (collected.length === 0) return
      this.deps.sse.emit("taskpool", {
        event: TASK_ARTIFACTS_UPDATE_EVENT,
        data: { task_id: taskId },
      })
      console.log(
        `[task-lifecycle] collected ${collected.length} file(s) back to home (task ${taskId} phase ${row.phase_index})`,
      )
    } catch (err: unknown) {
      console.error(`[task-lifecycle] collect failed (non-fatal):`, errMessage(err))
    }
  }

  /** The home batch directory of phase `i`, straight off task_spec — the position the
   *  envelope used to keep a materialized copy of. Relative specPaths resolve under the
   *  task home (ADR-0011/0018); absolute ones verbatim. */
  private phaseSpecDir(taskId: string, phaseIndex: number): string | null {
    const task = this.taskDAO.getById(taskId)
    if (!task) return null
    const spec = parseJSON<TaskSpec>(task.task_spec, {} as TaskSpec)
    const phase = (spec.phases ?? [])[phaseIndex - 1]
    if (!phase?.specPath) return null
    const homeDir = this.home.homePath(taskId)
    const abs = path.isAbsolute(phase.specPath) ? phase.specPath : path.join(homeDir, phase.specPath)
    return path.dirname(abs)
  }

  // ── ④ reconcile ────────────────────────────────────────────────────

  /**
   * Resolve task rows the DB says are alive but this process holds no engine for.
   *
   * Three outcomes, all of which the old design needed a separate reaper, a status
   * listener and a stale-claim sweep to approximate:
   *   - terminal in the DB but tasks.status never mirrored   → resync (a callback died)
   *   - alive, past the stale threshold, no engine, ws gone  → reap as 'aborted'
   *   - alive, past the stale threshold, no engine, ws fine  → reap as 'failed' with a
   *     reason, because silently re-starting a half-run workflow is worse than stopping:
   *     the workflow may have already pushed, and re-running is a human decision.
   * Rows YOUNGER than the stale threshold are left alone — they may legitimately be
   * mid-boot-recovery or mid-start on another tick.
   */
  reconcile(nowIso = new Date().toISOString()): { resynced: number; reaped: number } {
    let resynced = 0
    let reaped = 0
    const liveRoots = this.execDAO.listLiveTaskRootsNotIn(TERMINAL_EXECUTION_STATUSES)

    for (const row of liveRoots) {
      try {
        const full = this.execDAO.findById(row.id)
        if (!full) continue

        if (isTerminal(full.status)) continue // flipped between the scan and now

        const registry = this.safeRegistry(row.workspace_id)
        const engineAlive = registry?.service.hasLiveEngine?.(row.id) ?? false
        if (engineAlive) continue

        // Armed and waiting for a slot is not a strand — it is the queue working as
        // designed. Only a row that already started can be orphaned.
        if (full.status === "pending") continue

        // dbTimeMs, not Date.parse: see the helper for why a naive timestamp here is
        // 8 hours of phantom age on a UTC+8 box — enough to reap a live run one tick
        // after it started.
        const startedMs = dbTimeMs(full.started_at) || dbTimeMs(full.created_at)
        if (Number.isNaN(startedMs) || dbTimeMs(nowIso) - startedMs < STALE_CLAIMED_THRESHOLD_MS) continue

        const reason = registry
          ? `执行已失去引擎进程（崩溃或重启），超过 ${Math.round(STALE_CLAIMED_THRESHOLD_MS / 60000)} 分钟未归位`
          : "工作区已不可用（行缺失或路径失效）"
        this.execDAO.setLaunchStatus(row.id, "aborted", { completedAt: nowIso, error: reason })
        this.deps.sse.emit("taskpool", {
          event: TASK_EXECUTION_EVENT,
          data: { task_id: row.task_id, execution_id: row.id, status: "aborted", reason },
        })
        this.finishTaskOutcome(row.task_id as string, "aborted")
        reaped++
        console.warn(`[task-lifecycle] reaped stranded execution ${row.id}: ${reason}`)
      } catch (err: unknown) {
        console.error(`[task-lifecycle] reconcile failed for ${row.id} (non-fatal):`, errMessage(err))
      }
    }

    // Resync direction the other way: a terminal row whose task never moved (a callback
    // that died between the execution write and the status mirror). Only for tasks that
    // are still sitting in 'running' with no live instance.
    for (const task of this.taskDAO.listByStatus("running")) {
      const latest = this.execDAO.findLatestTaskRoot(task.id)
      if (!latest || !isTerminal(latest.status)) continue
      this.finishTaskOutcome(task.id, isTerminalStatusOk(latest.status) ? "done" : "failed")
      resynced++
    }

    resynced += this.recoverStuckDispatchParents()

    return { resynced, reaped }
  }

  /**
   * A composite parent paused on `pending_task_dispatch` whose children are ALL settled
   * is a lost wake-up: the child's completion callback fires exactly once, in the child's
   * process-time, and if it throws — or the child was finalized through the job's own
   * claim path and the wiring missed — the parent sits waiting for a waiter that is gone.
   * RecoveryManager does not cover it: it restarts *interrupted* engines, and a paused
   * parent is not interrupted, it is waiting.
   *
   * 票03's row shape is what makes this repairable at all: the parent→child link is a
   * queryable `parent_id` instead of a marker buried in a schedule config, so the
   * reconciliation pass can ask the only question that matters — "is anybody still owed
   * to this paused node?" — and answer no. Idempotent: `resumeTaskDispatch` on a node
   * that already moved on is a no-op.
   *
   * Two deliberate non-cases:
   *   - a child still live or waiting (parked behind the cap, or itself awaiting
   *     approval) — declaring the fan-out over mid-flight would resume the parent with
   *     the wrong subunit's output;
   *   - a parent whose ENGINE is also gone. Nothing can receive the resume, so pretending
   *     otherwise would report a recovery that did not happen. That row belongs to the
   *     strand reap above, which ends it once it is past the stale threshold.
   */
  private recoverStuckDispatchParents(): number {
    let recovered = 0
    const paused = this.taskDAO
      .getDb()
      .prepare(
        `SELECT id, workspace_id FROM executions
         WHERE task_id IS NOT NULL AND status = 'pending_task_dispatch'`,
      )
      .all() as Array<{ id: string; workspace_id: string }>
    for (const parent of paused) {
      try {
        const children = this.execDAO.findChildren(parent.id)
        if (children.length === 0) continue // never dispatched anything — nothing lost
        const unsettled = children.filter((c) => !isTerminal(c.status))
        if (unsettled.length > 0) continue
        const node = this.execDAO.findWaitingDispatchNode(parent.id)
        if (!node) continue
        // Re-forward the LAST settled child's output: the composition Loop consumes one
        // subunit per node visit, and the node that paused is waiting for exactly one.
        const last = children[children.length - 1]
        let output: Record<string, unknown> = {}
        try {
          output = JSON.parse(last.var_pool ?? "{}") as Record<string, unknown>
        } catch {
          output = {}
        }
        const registry = this.safeRegistry(parent.workspace_id)
        // Only a parent with an engine still in THIS process can take the resume.
        if (!registry?.service.hasLiveEngine?.(parent.id)) continue
        // Counted on ISSUE, not on completion: the metric answers "how many stuck parents
        // did this round touch", and the resume resolves on the microtask queue after
        // tick() has already returned. Counting inside .then() would report 0 forever.
        recovered++
        console.log(
          `[task-lifecycle] recovered lost wake-up: parent ${parent.id} node ${node.node_id} after ${children.length} settled child run(s)`,
        )
        void registry.service
          .resumeTaskDispatch(parent.id, node.node_id, output)
          .catch((err: unknown) =>
            console.error(`[task-lifecycle] parent recovery resume failed for ${parent.id}:`, errMessage(err)))
      } catch (err: unknown) {
        console.error(`[task-lifecycle] dispatch-parent scan failed for ${parent.id}:`, errMessage(err))
      }
    }
    return recovered
  }


  // ── cron cursor ────────────────────────────────────────────────────

  /** Next occurrence after now for a task's cron trigger; null when the expression no
   *  longer parses (a hand-edited row — the task simply stops being armed rather than
   *  throwing on every tick). */
  static nextCronFireAt(cron: string, timezone: string): string | null {
    try {
      return calculateNextExecutions(cron, timezone, 1)[0] ?? null
    } catch {
      return null
    }
  }

  /**
   * What a finished run means for the task card. Exactly one status write, so the board
   * never observes 完成 for a task that is actually 已入队 again:
   *   - v4 → nothing. The round ending opens the acceptance gate; 待验收 is derived (K3).
   *   - cron → back to 'ready' with the cursor jumped forward. The run was one occurrence
   *     of a schedule, not the task's outcome.
   *   - once/manual → done/failed, the task is over.
   * The run's own outcome is always on the executions row (and on the task_execution SSE),
   * so nothing is lost by not parking a periodic task in 完成.
   */
  private finishTaskOutcome(taskId: string, outcome: "done" | "failed" | "aborted"): void {
    // K3 first: a v4 card is moved by human decisions only. A launch that failed, a
    // round that crashed, a stranded row — all are machine observations, and writing
    // done/failed/aborted onto a v4 task would park it somewhere the acceptance gate
    // can no longer reach. The execution row already carries the truth (and 待验收 /
    // 失败轮 are derived from it), and since armTask accepts 'running' too, the human's
    // retry path is open.
    const task = this.taskDAO.getById(taskId)
    if (task && isV4Spec(task.task_spec)) return
    if (this.rearmPeriodicTrigger(taskId, new Date().toISOString())) return
    this.mirrorTaskStatus(taskId, outcome)
  }

  /**
   * A periodic task is not finished by a run — the run is one occurrence. Without this
   * the card lands in 完成 with a stale past cursor and the cron never fires again, which
   * is how the old envelope behaved structurally (a 'done' task could not be re-triggered
   * without a human, so 周期触发 was impossible; ADR-0021 背景).
   *
   * The cursor jumps to the NEXT occurrence rather than staying overdue: a run that
   * overran its window catches up with exactly one back-fire, not one per missed minute.
   * Manual and one-shot tasks are untouched.
   *
   * Not applied to v4: a v4 run ends in 待验收, which is a human holding the task. The
   * schedule resumes when the acceptance closes it (advance/归档 write 'ready' again).
   */
  private rearmPeriodicTrigger(taskId: string, nowIso: string): boolean {
    const task = this.taskDAO.getById(taskId)
    if (!task || task.trigger_mode !== "cron" || !task.cron_expression) return false
    const next = TaskLifecycleService.nextCronFireAt(task.cron_expression, task.cron_timezone || "Asia/Shanghai")
    if (!next) return false // unparseable after the fact — fall through to the normal mirror
    this.taskDAO
      .getDb()
      .prepare(
        `UPDATE tasks SET status = 'ready', next_fire_at = ?, trigger_enabled = 1,
           completed_at = NULL, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(next, nowIso, taskId)
    this.deps.sse.emit("taskpool", {
      event: TASK_STATUS_EVENT,
      data: { task_id: taskId, status: "ready" },
    })
    return true
  }

  /** Retire the due cursor after a fire: once → NULL (the pump must never re-enqueue it),
   *  cron → the next occurrence. */
  private retireFireCursor(task: TaskRow, firedAt: string): void {
    const next = task.trigger_mode === "cron" && task.cron_expression
      ? TaskLifecycleService.nextCronFireAt(task.cron_expression, task.cron_timezone || "Asia/Shanghai")
      : null
    this.taskDAO.markFired(task.id, next, firedAt)
  }

  /** A fire that could not be armed at all: retire the cursor too (so it does not retry
   *  every minute forever) and tell the board why, in the row's own status. */
  private failArm(task: TaskRow, err: unknown): void {
    const message = errMessage(err)
    console.error(`[task-lifecycle] arm failed for task ${task.id}: ${message}`)
    this.retireFireCursor(task, new Date().toISOString())
    // A task that cannot start is not "running" — park it back at 已入队 with the reason
    // logged + emitted, so a broken spec shows up as one clear failure instead of a
    // minute-by-minute retry storm against the concurrency gate.
    this.deps.sse.emit("taskpool", {
      event: TASK_TRIGGER_FAILED_EVENT,
      // trigger_mode, not action: what the event says is "a fire of THIS kind could not
      // happen"; the task_status/task_trigger events are the ones with an action.
      data: { task_id: task.id, reason: message, trigger_mode: task.trigger_mode as TriggerMode },
    })
  }

  // ── helpers ────────────────────────────────────────────────────────

  /** Arm + claim in one call — what the manual 触发 route uses so a user pressing the
   *  button does not wait for the next cron minute (the same job does the launch, so
   *  there is exactly one code path that ever starts a task).
   *
   *  Deliberately does NOT touch the trigger cursor: a manual launch of a cron task is
   *  not that task's scheduled fire, so the schedule must go on firing as armed. */
  armAndLaunch(taskId: string, opts: ArmOptions = {}): string {
    const executionId = this.armTask(taskId, opts)
    this.launchQueued(1)
    return executionId
  }

  /** Stop a task's live instance(s). Returns how many rows were affected. Queued rows are
   *  retired outright (they never started); running rows are cancelled through the engine
   *  so the worktree/branch state is written back properly. */
  abortTask(taskId: string): { cancelled: string[]; retired: string[] } {
    const cancelled: string[] = []
    const retired: string[] = []
    for (const row of this.execDAO.listTaskRoots(taskId, 5)) {
      if (isTerminal(row.status)) continue
      if (row.status === "pending") {
        if (this.execDAO.retireLaunch(row.id, "aborted", "任务被中止（排队中）").changes > 0) retired.push(row.id)
        continue
      }
      const registry = this.safeRegistry(row.workspace_id)
      if (registry) {
        try {
          registry.service.cancel(row.id)
        } catch (err: unknown) {
          // The engine may already be gone (restart) — the row still has to stop
          // holding the task's slot, so fall through to the direct write.
          console.error(`[task-lifecycle] engine cancel failed for ${row.id}:`, errMessage(err))
        }
      }
      this.execDAO.setLaunchStatus(row.id, "aborted", {
        completedAt: new Date().toISOString(),
        error: "用户中止",
      })
      registry?.service.clearExternalCallbacks(row.id)
      cancelled.push(row.id)
    }
    return { cancelled, retired }
  }

  /** The one row a human is looking at: the task's current instance. */
  currentInstance(taskId: string): ExecutionRow | null {
    return this.execDAO.findLatestTaskRoot(taskId)
  }

  history(taskId: string, limit = 50): ExecutionRow[] {
    return this.execDAO.listTaskRoots(taskId, limit)
  }

  /**
   * One line for a red run, in preference order: the reason the job itself already wrote
   * on the row (retire, start failure, reap), then why the 票04 aggregation turned a green
   * coordinator red, then the engine's failed node. NULL when nothing knows — the node
   * list is where the detail page looks, and inventing a generic string here would put
   * words on the badge that nothing can unsay later.
   */
  private failureReason(row: ExecutionRow, executionId: string, failedChildren: number): string | null {
    const stored = parseJSON<Record<string, unknown>>(row.var_pool, {}).error
    if (typeof stored === "string" && stored.trim()) return stored
    if (failedChildren > 0) return `${failedChildren} 个子单元执行失败`
    return this.execDAO.findFirstNodeErrorByStatus(executionId, "failed")?.error ?? null
  }

  /** The task's subunit runs (composite fan-out), for the detail/history read model.
   *  This is where 票05 sends the UI instead of the envelope's `origin_role='subunit'`
   *  rows: the arms of a fan-out are child executions of the round that dispatched them. */
  childRuns(taskId: string): ExecutionRow[] {
    return this.execDAO.listTaskChildRuns(taskId)
  }

  /** The board's badge source: the newest instance of each task, one query. */
  latestInstances(taskIds: readonly string[]): ExecutionRow[] {
    return this.execDAO.findLatestTaskRoots(taskIds)
  }

  private mirrorTaskStatus(taskId: string, status: "running" | "done" | "failed" | "aborted"): void {
    const nowIso = new Date().toISOString()
    const terminal = status === "done" || status === "failed" || status === "aborted"
    const changed = this.taskDAO
      .getDb()
      .prepare(
        `UPDATE tasks SET status = ?, updated_at = ?, completed_at = ?
         WHERE id = ? AND deleted_at IS NULL AND status != ?`,
      )
      .run(status, nowIso, terminal ? nowIso : null, taskId, status)
    if (changed.changes === 0) return
    this.deps.sse.emit("taskpool", {
      event: TASK_STATUS_EVENT,
      data: { task_id: taskId, status },
    })
  }

  private safeRegistry(workspaceId: string) {
    try {
      return getExecutionService(workspaceId)
    } catch {
      return undefined // registry not initialized (unit-test context) — treat as gone
    }
  }

  private resolveRef(taskId: string, ref: string): { content: string } | null {
    return resolveWorkflowRef(ref, {
      builtIn: this.builtIn ?? this.lazyBuiltIn(),
      taskHome: this.home,
      taskId,
    })
  }

  /** Same defensive fallback TasksService uses: production injects the global service,
   *  an ad-hoc caller (or a unit test that never arms a v4 task) never pays for it. */
  private lazyBuiltIn(): BuiltInWorkflowService | null {
    try {
      this.builtIn = new BuiltInWorkflowService(getResourceRegistry().get())
      return this.builtIn
    } catch {
      return null
    }
  }

}

/** Execution statuses that mean "the work succeeded" for the resync pass. */
function isTerminalStatusOk(status: string): boolean {
  return status === "completed" || status === "completed_with_failures"
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** UNIQUE only — the `SQLITE_CONSTRAINT` prefix alone also covers NOT NULL and FK, and
 *  reporting those as 「已在运行」 would hide a real bug behind a plausible refusal. */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? ""
  return code.startsWith("SQLITE_CONSTRAINT_UNIQUE") || code.endsWith("_UNIQUE")
}

/**
 * The built-in job's handler body — registered by the composition root (index.ts), which
 * is what makes this the system's one bridge: a `job_type='job'` schedule row names the
 * handler, the handler calls this, and the scheduler itself never learns that a task
 * exists. `tick()` is idempotent, so the pump's cron cadence, a manual "跑一轮" and the
 * trigger route's wake() are all safe ways to reach it.
 */
export function taskLifecycleHandlerFor(service: TaskLifecycleService) {
  return async (): Promise<{ summary: string; metrics: Record<string, number> }> => {
    const m = service.tick()
    const summary =
      `排队 ${m.armed} · 启动 ${m.launched} · 对账 ${m.resynced} · 回收 ${m.reaped}` +
      (m.refused ? ` · 拒绝 ${m.refused}` : "") +
      (m.capped ? " · 并发已满(下轮续领)" : "")
    return {
      summary,
      metrics: {
        armed: m.armed,
        launched: m.launched,
        reconciled: m.resynced,
        reaped: m.reaped,
        refused: m.refused,
      },
    }
  }
}
