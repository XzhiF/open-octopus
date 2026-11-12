// packages/server/src/services/cabin/cabin-comm-service.ts
//
// Cabin P3（C6/C9/D6）：orchestrator ↔ doer 通信语义层。传输层复用现有异构通道
// （task 主线程 / 内部 chat wake），语义层统一落 cabin_jobs + cabin_job_events：
//   outbound dispatch/input(note)/resume → 建真实任务/steer/触发 + 审计事件
//   inbound  report/attention/handback  → bridge G2 hook 落审计（wake 由 bridge 负责）
// 派生纪律 K3：不镜像任务状态，status 一律读底层实体。

import { randomUUID } from "crypto"
import type { CabinMandate } from "@octopus/shared"
import type { CabinDAO } from "../../db/dao/cabin-dao"
import type { TaskDAO, AgentSessionDAO } from "../../db/dao"
import type { CabinJobRow, CabinJobEventRow, CabinJobKind, CabinJobEventKind } from "../../db/types"
import type { TasksService } from "../tasks/tasks-service"
import { getSessionService } from "../agent/session-service"
import { readCabinConfig } from "./cabin-repos"
import { CabinNotFoundError } from "./cabin-service"

const now = () => new Date().toISOString()

export interface CabinCommDeps {
  cabin: CabinDAO
  taskDAO: TaskDAO
  agentSessionDAO: AgentSessionDAO
  tasksService: TasksService
}

export class CabinJobNotFoundError extends Error {
  constructor(id: string) { super(`cabin job not found: ${id}`); this.name = "CabinJobNotFoundError" }
}

export class CabinCommService {
  constructor(private deps: CabinCommDeps) {}

  private mustCabin(id: string) {
    const row = this.deps.cabin.findById(id)
    if (!row) throw new CabinNotFoundError(id)
    return row
  }

  private mustJob(cabinId: string, jobId: string): CabinJobRow {
    const job = this.deps.cabin.findJob(jobId)
    if (!job || job.cabin_id !== cabinId) throw new CabinJobNotFoundError(jobId)
    return job
  }

  private appendEvent(jobId: string, cabinId: string, kind: CabinJobEventKind, actor: string, payload: unknown): CabinJobEventRow {
    const row: CabinJobEventRow = {
      id: randomUUID(), job_id: jobId, cabin_id: cabinId, kind, actor,
      payload: JSON.stringify(payload ?? {}), created_at: now(),
    }
    this.deps.cabin.appendEvent(row)
    return row
  }

  /** C2 派发：task → 真实 Octopus 任务 + 作者主线程 + 首回合 wake（复用现有
   *  authoring/launch/执行生命周期，舱不持有执行逻辑）。workflow/subagent →
   *  仅账本登记（ref 由调用方提供，传输层各自异构通道）。 */
  dispatch(cabinId: string, input: {
    kind: CabinJobKind
    title: string
    prompt?: string | null
    ref_id?: string | null
    session_id?: string | null
    iteration_id?: string | null
    priority?: number
    mandate?: CabinMandate | null
  }): CabinJobRow {
    const cabin = this.mustCabin(cabinId)
    let refId = input.ref_id ?? null
    let sessionId = input.session_id ?? null

    if (input.kind === "task" && !refId) {
      const repos = readCabinConfig(cabin.path).repos.map((r) => r.name).filter(Boolean)
      const task = this.deps.tasksService.createTask({
        name: input.title,
        repo_group: cabin.org ?? undefined,
        cabin_id: cabinId,
        iteration_id: input.iteration_id ?? null,
        task_type: "coding",
        preset: { org: cabin.org ?? undefined, projects: repos },
        workspace_id: cabin.workspace_id ?? undefined,
      })
      refId = task.id
      const session = getSessionService().createSession({
        cwd: cabin.path,
        workspace_id: task.workspace_id ?? cabin.workspace_id,
      })
      this.deps.agentSessionDAO.updateSession(session.id, {
        cabin_id: cabinId,
        title: `${input.title} · 任务主线程`,
        scope_id: task.id,
      })
      this.deps.taskDAO.bindSourceChatSession(task.id, session.id)
      sessionId = session.id
    }

    const row: CabinJobRow = {
      id: randomUUID(), cabin_id: cabinId, kind: input.kind,
      ref_id: refId, session_id: sessionId,
      iteration_id: input.iteration_id ?? null, title: input.title,
      mandate: input.mandate ? JSON.stringify(input.mandate) : null,
      prompt: input.prompt ?? null, priority: input.priority ?? 0,
      created_at: now(), ended_at: null,
    }
    this.deps.cabin.insertJob(row)
    this.appendEvent(row.id, cabinId, "dispatch", "orchestrator", {
      title: row.title, mandate: input.mandate ?? null, ref_id: refId,
    })

    if (input.kind === "task" && sessionId) {
      const strength = input.mandate?.strength ?? "explicit"
      const message = [
        `[舱派发 · mandate=${strength}] 任务「${input.title}」`,
        "需求原文（转发，不改写）：",
        input.prompt?.trim() || input.title,
        strength === "explicit"
          ? "舱调度者已代表用户明确授权：按 task-author 纪律完成规格后直接入列并立即执行，无需再向人确认（C5 explicit 自决）。"
          : "授权为 inferred：规格完成后先出确认卡，等人放行再执行。",
        "执行隔离：worktree 从舱主线切出；回报/attention 会汇聚到舱主对话（单线程收件箱）。",
      ].join("\n")
      void this.wakeSession(sessionId, cabin.org ?? "", message)
    }
    return row
  }

  /** D6 note：不授权 steer。subagent 一次性无 mid-run input（C9 风险12）→ 只留痕。 */
  note(cabinId: string, jobId: string, text: string, actor: "orchestrator" | "human" = "orchestrator"): CabinJobEventRow {
    this.mustCabin(cabinId)
    const job = this.mustJob(cabinId, jobId)
    const event = this.appendEvent(jobId, cabinId, "note", actor, { summary: text })
    if (job.kind !== "subagent" && job.session_id) {
      void this.wakeSession(job.session_id, this.mustCabin(cabinId).org ?? "", `[舱备注 · 不授权] ${text}`)
    }
    return event
  }

  /** D6 resume：task → ready 触发 / paused 恢复；其余只留痕 + wake。 */
  async resume(cabinId: string, jobId: string): Promise<CabinJobEventRow> {
    this.mustCabin(cabinId)
    const job = this.mustJob(cabinId, jobId)
    if (job.kind === "task" && job.ref_id) {
      const task = this.deps.taskDAO.getById(job.ref_id)
      if (task) {
        if (task.status === "ready") await this.deps.tasksService.triggerTask(task.id)
        else if (task.status === "running") await this.deps.tasksService.resumeTask(task.id)
      }
    }
    const event = this.appendEvent(jobId, cabinId, "resume", "orchestrator", { ref_id: job.ref_id })
    if (job.kind !== "subagent" && job.session_id) {
      void this.wakeSession(job.session_id, this.mustCabin(cabinId).org ?? "", "[舱恢复] 阻塞解除后自主恢复推进；完成后回报舱主对话。")
    }
    return event
  }

  /** G2 inbound hook（bridge 调用）：doer 高信号 → 审计事件。job 缺失时自动
   *  登记（UI 直建任务带 cabin_id 但未经 dispatch 的路径）。wake/卡路由由
   *  bridge 的舱主会话覆写负责，这里只留痕。 */
  recordTaskSignal(taskId: string, status: string, summary: string): void {
    const task = this.deps.taskDAO.getById(taskId)
    if (!task?.cabin_id) return
    const kind: CabinJobEventKind | null =
      status === "awaiting_review" ? "attention"
        : status === "done" ? "report"
          : status === "failed" || status === "aborted" ? "handback"
            : null
    if (!kind) return
    const cabinId = task.cabin_id
    let job = this.deps.cabin.findJobByRef(cabinId, taskId)
    if (!job) {
      job = {
        id: randomUUID(), cabin_id: cabinId, kind: "task", ref_id: taskId,
        session_id: task.source_chat_session_id ?? null, iteration_id: task.iteration_id ?? null,
        title: task.name, mandate: JSON.stringify({ strength: "inferred", scope: "task", basis: "auto-register" }),
        prompt: null, priority: 0, created_at: now(), ended_at: null,
      }
      this.deps.cabin.insertJob(job)
      this.appendEvent(job.id, cabinId, "dispatch", "system", { title: job.title, auto: true })
    }
    this.appendEvent(job.id, cabinId, kind, "doer", { status, summary })
    if (status === "done" || status === "failed" || status === "aborted") {
      this.deps.cabin.endJob(job.id, now())
    }
  }

  /** 与 bridge.wake 同一内部通道（Bearer agent chat endpoint）。 */
  private async wakeSession(sessionId: string, org: string, message: string): Promise<void> {
    if (process.env.OCTOPUS_CHAT_AUTO_WAKE === "0") return
    const port = process.env.PORT ?? "3001"
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer agent", "X-Octopus-Org": org },
        body: JSON.stringify({ message, wake: true }),
      })
      if (response.ok && response.body) {
        const reader = response.body.getReader()
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
      }
    } catch (err) {
      if (process.env.NODE_ENV !== "test") {
        console.warn(`[CabinComm] wake failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}
