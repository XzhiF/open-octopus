import { randomUUID } from "crypto"
import { isStreamActive } from "../agent/agent-service"
import { getActivityBus, type ActivityEvent, type ActivityKind, type ActivitySeverity } from "./activity-bus"
import type { SSEService } from "../sse"

export interface ChatWakeTarget {
  sessionId: string
  org: string
  workspaceId?: string | null
  workflowRef?: string
}

interface SqliteLike {
  prepare(sql: string): { get(...params: unknown[]): unknown }
}

const WAKE_COALESCE_MS = 5_000
const MAX_WAKES_PER_EXECUTION = 3
const STALL_MS = 10 * 60 * 1000

// ── Task status cards (2026-10-28 task-thread) ──────────────────────
// Every persisted→derived transition gets a transcript card. High-signal
// transitions additionally wake the agent (one turn), but the card itself is
// deterministic and costs zero LLM. The web renders `payload.actions` as
// buttons (M4); the ids are the contract.

export interface TaskCardAction {
  id: string
  label: string
}

const TASK_STATUS_TITLE: Record<string, string> = {
  draft: "任务已回到草稿",
  ready: "任务已入列 · 待触发",
  running: "任务开始执行",
  paused: "任务已暂停",
  awaiting_review: "本轮完成 · 待验收",
  archiving: "末 phase 已通过 · 归档中",
  done: "任务完成 · 已归档",
  aborted: "任务已中止",
  failed: "任务失败",
}

const TASK_STATUS_SEVERITY: Record<string, ActivitySeverity> = {
  draft: "info",
  ready: "info",
  running: "info",
  paused: "warn",
  awaiting_review: "warn",
  archiving: "warn",
  done: "info",
  aborted: "warn",
  failed: "critical",
}

const TASK_STATUS_ACTIONS: Record<string, TaskCardAction[]> = {
  draft: [{ id: "open_spec", label: "打开规格" }],
  ready: [
    { id: "trigger", label: "⚡ 立即触发" },
    { id: "schedule", label: "⏱ 定时触发" },
    { id: "reopen", label: "↩ 回草稿" },
  ],
  running: [
    { id: "open_run", label: "打开运行窗" },
    { id: "pause", label: "⏸ 暂停" },
    { id: "abort", label: "■ 中止" },
  ],
  paused: [
    { id: "resume", label: "▶ 恢复" },
    { id: "open_run", label: "打开运行窗" },
    { id: "abort", label: "■ 中止" },
  ],
  awaiting_review: [
    { id: "open_acceptance", label: "✓ 去验收" },
    { id: "open_changes", label: "打开本轮变更" },
  ],
  archiving: [
    { id: "open_archive", label: "打开归档" },
    { id: "retry_archive", label: "↻ 重试归档" },
  ],
  done: [
    { id: "open_archive", label: "打开归档报告" },
    { id: "open_usage", label: "看消耗" },
    { id: "new_task", label: "开新任务" },
  ],
  aborted: [
    { id: "open_run", label: "打开日志" },
    { id: "duplicate", label: "⧉ 复制任务" },
  ],
  failed: [
    { id: "open_run", label: "打开日志" },
    { id: "duplicate", label: "⧉ 复制任务" },
  ],
}

/**
 * Routes workflow/task activity to the chat session that owns it.
 *
 * High-signal events (approval / failure / stall / completion) append an
 * append-only event card and, unless disabled, start an agent turn through the
 * normal chat endpoint — same system prompt, role card, MCP tools and safety
 * path a user message takes. Low-signal node progress only reaches ActivityBus.
 */
class ChatEventBridge {
  private targets = new Map<string, ChatWakeTarget>()
  private lastWakeAt = new Map<string, number>()
  private wakeCount = new Map<string, number>()
  private seen = new Set<string>()
  private stallTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private stallWarned = new Set<string>()
  private pendingWakes = new Map<string, { target: ChatWakeTarget; event: ActivityEvent; ephemeral?: boolean }>()
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private db: SqliteLike | null = null
  private sse: SSEService | null = null
  /** taskId → last status we carded, so repeat SSE frames stay one card. */
  private lastTaskStatus = new Map<string, string>()
  /** 验收引导唤醒去重：task:phase:round → 已唤醒。 */
  private acceptanceGuided = new Set<string>()

  attach(db: SqliteLike): void {
    this.db = db
  }

  attachSse(sse: SSEService): void {
    this.sse = sse
  }

  bindExecution(executionId: string, target: ChatWakeTarget): void {
    this.targets.set(executionId, target)
    this.resetStall(executionId)
  }

  unbindExecution(executionId: string): void {
    this.targets.delete(executionId)
    const timer = this.stallTimers.get(executionId)
    if (timer) clearTimeout(timer)
    this.stallTimers.delete(executionId)
    this.stallWarned.delete(executionId)
  }

  private resetStall(executionId: string): void {
    const old = this.stallTimers.get(executionId)
    if (old) clearTimeout(old)
    const timer = setTimeout(() => void this.checkStall(executionId), STALL_MS)
    if (typeof timer.unref === "function") timer.unref()
    this.stallTimers.set(executionId, timer)
  }

  private executionStatus(executionId: string): string | null {
    if (!this.db) return null
    try {
      const row = this.db.prepare("SELECT status FROM executions WHERE id = ?").get(executionId) as
        | { status?: string }
        | undefined
      return row?.status ?? null
    } catch {
      return null
    }
  }

  private async checkStall(executionId: string): Promise<void> {
    const target = this.targets.get(executionId)
    if (!target) return
    const status = this.executionStatus(executionId)
    if (!status || !["running", "pending", "paused"].includes(status)) {
      this.unbindExecution(executionId)
      return
    }
    if (this.stallWarned.has(executionId)) return
    this.stallWarned.add(executionId)
    const event = getActivityBus().publish({
      kind: "workflow.stalled",
      severity: "warn",
      title: `工作流长时间无进展：${target.workflowRef ?? executionId.slice(0, 8)}`,
      message: `执行 ${executionId} 已超过 10 分钟没有新的节点事件。`,
      workspaceId: target.workspaceId,
      executionId,
      sessionId: target.sessionId,
    })
    await this.wake(target, event)
  }

  /** SSE fan-in: turn low-level engine frames into activity + wake decisions. */
  handleSse(event: { event: string; data: unknown }): void {
    const data = (event.data ?? {}) as Record<string, unknown>

    if (event.event === "task_status") {
      this.handleTaskStatus(data)
      return
    }

    const executionId = typeof data.executionId === "string" ? data.executionId : undefined
    if (!executionId) return
    const target = this.targets.get(executionId)
    const workflowName = target?.workflowRef ?? executionId.slice(0, 8)
    if (target) this.resetStall(executionId)

    switch (event.event) {
      case "execution_status": {
        const status = String(data.status ?? "")
        if (status === "running") {
          this.emitOnce(executionId, "started", {
            kind: "workflow.started",
            severity: "info",
            title: `工作流开始：${workflowName}`,
            workspaceId: target?.workspaceId,
            executionId,
            sessionId: target?.sessionId,
          })
        } else if (status === "budget_exceeded" || status === "failed") {
          void this.highSignal(executionId, target, "workflow.failed", "critical", `工作流失败：${workflowName}`, String(data.reason ?? status))
        }
        break
      }
      case "complete": {
        const finalStatus = String(data.finalStatus ?? "")
        if (["completed", "completed_with_failures"].includes(finalStatus)) {
          void this.highSignal(executionId, target, "workflow.completed", "info", `工作流完成：${workflowName}`, finalStatus)
        } else if (["failed", "rejected"].includes(finalStatus)) {
          void this.highSignal(executionId, target, "workflow.failed", "critical", `工作流失败：${workflowName}`, String(data.error ?? finalStatus))
        }
        // A terminal execution is no longer a wake target (task events route separately).
        this.unbindExecution(executionId)
        break
      }
      case "execution_pending_approval": {
        const approval = (data.approval ?? {}) as Record<string, unknown>
        void this.highSignal(
          executionId,
          target,
          "workflow.approval",
          "warn",
          `工作流等待审批：${workflowName}`,
          String(approval.prompt ?? approval.message ?? "请在 chat 中决定 approve/reject"),
          String(data.nodeId ?? ""),
        )
        break
      }
      case "execution_paused": {
        void this.highSignal(executionId, target, "workflow.paused", "warn", `工作流已暂停：${workflowName}`, "执行被暂停，等待人工处理。")
        break
      }
      case "node_end": {
        if (String(data.status ?? "") === "failed") {
          const nodeId = String(data.nodeId ?? "")
          getActivityBus().publish({
            kind: "workflow.node_failed",
            severity: "warn",
            title: `节点失败：${nodeId}`,
            workspaceId: target?.workspaceId,
            executionId,
            nodeId,
            sessionId: target?.sessionId,
          })
        }
        break
      }
      default:
        break
    }
  }

  private handleTaskStatus(data: Record<string, unknown>): void {
    const taskId = typeof data.task_id === "string" ? data.task_id : undefined
    if (!taskId || !this.db) return
    const status = String(data.status ?? "")
    if (!status) return
    // One card per TRANSITION. SSE repeats the current status on several
    // channels; a second episode of 'running' (next phase) must still card.
    if (this.lastTaskStatus.get(taskId) === status) return
    this.lastTaskStatus.set(taskId, status)

    let row: {
      name?: string
      repo_group?: string | null
      source_chat_session_id?: string | null
      workspace_id?: string | null
    } | undefined
    try {
      row = this.db.prepare(
        "SELECT name, repo_group, source_chat_session_id, workspace_id FROM tasks WHERE id = ?",
      ).get(taskId) as typeof row
    } catch {
      return
    }
    if (!row) return

    // A task thread is a MAIN session bound to the task. Legacy task-author
    // clone sessions keep the old high-signal-wake-only behavior.
    let threadSession: { clone_name: string | null; workspace_id: string | null } | undefined
    if (row.source_chat_session_id) {
      try {
        threadSession = this.db.prepare(
          "SELECT clone_name, workspace_id FROM sessions WHERE id = ?",
        ).get(row.source_chat_session_id) as typeof threadSession
      } catch {
        /* no sessions table in a stripped test DB — treat as legacy */
      }
    }
    const isThread = !!threadSession && (threadSession.clone_name ?? null) === null

    let latest: { id?: string; phase_index?: number | null; round_index?: number | null } | undefined
    try {
      latest = this.db.prepare(
        "SELECT id, phase_index, round_index FROM executions WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      ).get(taskId) as typeof latest
    } catch {
      /* no executions table — fine */
    }

    const high: ActivityKind | null =
      status === "done" ? "task.completed"
        : status === "failed" || status === "aborted" ? "task.failed"
          : status === "awaiting_review" ? "task.review"
            : null
    const kind: ActivityKind = high ?? "task.status"
    const title = TASK_STATUS_TITLE[status] ?? `任务状态：${status}`
    const severity: ActivitySeverity = TASK_STATUS_SEVERITY[status] ?? "info"
    const actions = TASK_STATUS_ACTIONS[status] ?? []
    const coord = latest?.phase_index != null
      ? `P${latest.phase_index}${latest.round_index != null ? ` · R${latest.round_index}` : ""}`
      : "未开始"
    const detail = `任务：${row.name ?? taskId.slice(0, 8)} · ${coord}`
    const workspaceId = row.workspace_id ?? threadSession?.workspace_id ?? null

    const event = getActivityBus().publish({
      kind,
      severity,
      title,
      message: detail,
      workspaceId,
      taskId,
      executionId: latest?.id ?? null,
      sessionId: row.source_chat_session_id ?? null,
      payload: {
        status,
        actions,
        phaseIndex: latest?.phase_index ?? null,
        roundIndex: latest?.round_index ?? null,
      },
    })

    if (isThread && row.source_chat_session_id) {
      this.appendTaskCard({
        sessionId: row.source_chat_session_id,
        workspaceId,
        title,
        detail,
        event,
        status,
        actions,
      })
      this.notifySession(row.source_chat_session_id, workspaceId)
    }

    if (high && row.source_chat_session_id) {
      void this.wake(
        { sessionId: row.source_chat_session_id, org: row.repo_group ?? '', workspaceId },
        event,
        // The thread already has the deterministic card; the wake turn is the
        // model seeing the same event without persisting a duplicate message.
        isThread ? { ephemeral: true } : undefined,
      )
    }
  }

  /** Append-only transcript card (zero LLM). Shape matches the wake route's
   *  displayType:'event' messages so the web renders one component. */
  private appendTaskCard(input: {
    sessionId: string
    workspaceId: string | null
    title: string
    detail: string
    event: ActivityEvent
    status: string
    actions: TaskCardAction[]
  }): void {
    if (!this.db) return
    const now = new Date().toISOString()
    const payload = (input.event.payload ?? {}) as Record<string, unknown>
    const activity = {
      kind: input.event.kind,
      severity: input.event.severity,
      title: input.title,
      message: input.detail,
      workspaceId: input.workspaceId,
      taskId: input.event.taskId ?? null,
      executionId: input.event.executionId ?? null,
      status: input.status,
      // 对话里的运行卡要显示「P1 · R1」—— 事件载荷里有，落卡片时别丢。
      phaseIndex: typeof payload.phaseIndex === 'number' ? payload.phaseIndex : null,
      roundIndex: typeof payload.roundIndex === 'number' ? payload.roundIndex : null,
      actions: input.actions,
    }
    try {
      this.db.prepare(
        "INSERT INTO messages (id, session_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        randomUUID(),
        input.sessionId,
        "user",
        `[任务状态 · ${input.status}] ${input.title}\n${input.detail}`,
        JSON.stringify({ displayType: "event", activity }),
        now,
      )
      this.db.prepare(
        "UPDATE sessions SET last_message_at = ?, updated_at = ? WHERE id = ?",
      ).run(now, now, input.sessionId)
    } catch (err: unknown) {
      if (process.env.NODE_ENV !== "test") {
        console.warn(
          `[ChatEventBridge] task card insert failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  /** Archiving start: wake the main thread ONCE for knowledge reflection.
   *  The status card is already written by handleTaskStatus; this turn only
   *  asks the model to call propose_wiki_entries (ephemeral, no duplicate card). */
  requestArchiveReflection(taskId: string): void {
    if (!this.db) return
    let row: {
      name?: string
      repo_group?: string | null
      source_chat_session_id?: string | null
      workspace_id?: string | null
    } | undefined
    try {
      row = this.db.prepare(
        "SELECT name, repo_group, source_chat_session_id, workspace_id FROM tasks WHERE id = ?",
      ).get(taskId) as typeof row
    } catch {
      return
    }
    if (!row?.source_chat_session_id) return
    let session: { clone_name?: string | null } | undefined
    try {
      session = this.db.prepare("SELECT clone_name FROM sessions WHERE id = ?")
        .get(row.source_chat_session_id) as typeof session
    } catch {
      return
    }
    if (!session || session.clone_name) return // legacy clone thread — untouched

    const title = "归档反思 · 知识沉淀"
    const event = getActivityBus().publish({
      kind: "task.status",
      severity: "info",
      title,
      message: `任务：${row.name ?? taskId.slice(0, 8)} · 末 phase 已通过，归档编排中`,
      workspaceId: row.workspace_id ?? null,
      taskId,
      sessionId: row.source_chat_session_id,
      payload: { status: "archiving", reflection: true },
    })
    const message = [
      `[归档反思] 任务 ${taskId} 已进入归档阶段。`,
      "请读 task home、本轮 git 变更与 spec，调用 propose_wiki_entries 给出 2–5 条值得落 wiki 的建议（决策 / 坑 / 术语）。",
      "不要改代码；落不落由人逐条决定。自动投喂已在后台进行，不必重复它。",
    ].join("\n")
    void this.wake(
      { sessionId: row.source_chat_session_id, org: row.repo_group ?? '', workspaceId: row.workspace_id ?? null },
      event,
      { ephemeral: true, message },
    )
  }

  /** 验收方案就绪（2026-10-30 AI-native 验收）：投一张消息流卡片 + 唤醒主
   *  Chat 开始逐项引导。只认主线程会话；legacy clone 不动；同一轮只唤醒一次。
   *  注意：不改 Chat 顶部栏 —— 引导上下文全部在消息流里表达。 */
  requestAcceptanceGuide(
    taskId: string,
    info: { phaseIndex: number; roundIndex: number; itemCount: number; goal?: string },
  ): void {
    if (!this.db) return
    const key = `${taskId}:${info.phaseIndex}:${info.roundIndex}`
    if (this.acceptanceGuided.has(key)) return
    let row: {
      name?: string
      repo_group?: string | null
      source_chat_session_id?: string | null
      workspace_id?: string | null
    } | undefined
    try {
      row = this.db.prepare(
        "SELECT name, repo_group, source_chat_session_id, workspace_id FROM tasks WHERE id = ?",
      ).get(taskId) as typeof row
    } catch {
      return
    }
    if (!row?.source_chat_session_id) return
    let session: { clone_name?: string | null } | undefined
    try {
      session = this.db.prepare("SELECT clone_name FROM sessions WHERE id = ?")
        .get(row.source_chat_session_id) as typeof session
    } catch {
      return
    }
    if (!session || session.clone_name) return // legacy clone thread — untouched
    this.acceptanceGuided.add(key)

    const title = `验收方案已就绪 · ${info.itemCount} 项`
    const detail = `任务：${row.name ?? taskId.slice(0, 8)} · P${info.phaseIndex} · R${info.roundIndex}` +
      (info.goal ? ` · ${info.goal}` : "")
    const actions: TaskCardAction[] = [{ id: "acceptance_open_window", label: "打开验收台" }]
    const event = getActivityBus().publish({
      kind: "task.review",
      severity: "info",
      title,
      message: detail,
      workspaceId: row.workspace_id ?? null,
      taskId,
      sessionId: row.source_chat_session_id,
      payload: {
        status: "awaiting_review",
        actions,
        phaseIndex: info.phaseIndex,
        roundIndex: info.roundIndex,
        acceptancePlan: true,
        itemCount: info.itemCount,
      },
    })
    this.appendTaskCard({
      sessionId: row.source_chat_session_id,
      workspaceId: row.workspace_id ?? null,
      title,
      detail,
      event,
      status: "awaiting_review",
      actions,
    })
    this.notifySession(row.source_chat_session_id, row.workspace_id ?? null)
    const message = [
      `[验收引导] 任务 ${taskId} 本轮（P${info.phaseIndex} R${info.roundIndex}）已交付，验收方案已生成（${info.itemCount} 项）。`,
      "请调用 get_acceptance_plan 读方案与进度，然后**一次只推进一项**：",
      "1. 先用 run_acceptance_probe 跑该行的机器证据（需要看页面就 start_acceptance_preview，结束后 stop_acceptance_preview），把结果讲给用户；",
      "2. 再用消息问「通过 / 不通过 / 跳过」；卡片只是快捷方式，不必强求用户点。",
      "3. 用户在对话里明确表态后直接调 record_acceptance_check(confirmed=true) —— 不要代替人判断。",
      "不通过 → 当场小修（只改直接相关的 ≤2 个文件，不改 spec），修完重跑证据再重新确认；",
      "超出小修边界 → 调 propose_acceptance_escalation 让人确认升级大修复。",
      "全部项有结论后：用户明确说「放行 / 通过 / 可以了」→ submit_acceptance_decision(decision=\"accepted\", confirmed=true)；",
      "用户明确说「退回 / 不行，让他改…」→ submit_acceptance_decision(decision=\"rejected\", feedback=他的原话, confirmed=true)。",
      "人点验收台是兜底，不是必需；但没有明确表态绝不放行、绝不退回，也不要把未勾项当成通过。",
    ].join("\n")
    void this.wake(
      { sessionId: row.source_chat_session_id, org: row.repo_group ?? "", workspaceId: row.workspace_id ?? null },
      event,
      { ephemeral: true, message },
    )
  }

  /** 方案生成失败：消息流卡片（重试 / 打开验收台），不唤醒（不烧 token）。 */
  notifyAcceptancePlanFailed(taskId: string, error: string): void {
    if (!this.db) return
    let row: {
      name?: string
      source_chat_session_id?: string | null
      workspace_id?: string | null
    } | undefined
    try {
      row = this.db.prepare(
        "SELECT name, source_chat_session_id, workspace_id FROM tasks WHERE id = ?",
      ).get(taskId) as typeof row
    } catch {
      return
    }
    if (!row?.source_chat_session_id) return
    let session: { clone_name?: string | null } | undefined
    try {
      session = this.db.prepare("SELECT clone_name FROM sessions WHERE id = ?")
        .get(row.source_chat_session_id) as typeof session
    } catch {
      return
    }
    if (!session || session.clone_name) return

    const actions: TaskCardAction[] = [
      { id: "acceptance_regenerate", label: "↻ 重新生成方案" },
      { id: "acceptance_open_window", label: "打开验收台" },
    ]
    const title = "验收方案生成失败"
    const detail = `${error}（验收不阻塞 —— 仍可用旧清单逐项核对）`
    const event = getActivityBus().publish({
      kind: "task.review",
      severity: "warn",
      title,
      message: detail,
      workspaceId: row.workspace_id ?? null,
      taskId,
      sessionId: row.source_chat_session_id,
      payload: { status: "awaiting_review", actions, acceptancePlanFailed: true },
    })
    this.appendTaskCard({
      sessionId: row.source_chat_session_id,
      workspaceId: row.workspace_id ?? null,
      title,
      detail,
      event,
      status: "awaiting_review",
      actions,
    })
    this.notifySession(row.source_chat_session_id, row.workspace_id ?? null)
  }

  /** Tell an open chat to reload its transcript (no wake turn). */
  private notifySession(sessionId: string, workspaceId: string | null): void {
    if (!this.sse || !workspaceId) return
    this.sse.emit(workspaceId, {
      event: "session_updated",
      data: { sessionId, wake: false, phase: "event" },
    })
  }

  /** Archiving failed but the task is parked in 'archiving' (no task_status
   *  transition fires). Card + one wake so the main chat can explain/retry. */
  notifyTaskArchiveFailure(taskId: string, detail?: string): void {
    if (!this.db) return
    let row: {
      name?: string
      repo_group?: string | null
      source_chat_session_id?: string | null
      workspace_id?: string | null
    } | undefined
    try {
      row = this.db.prepare(
        "SELECT name, repo_group, source_chat_session_id, workspace_id FROM tasks WHERE id = ?",
      ).get(taskId) as typeof row
    } catch {
      return
    }
    if (!row?.source_chat_session_id) return
    let session: { clone_name?: string | null } | undefined
    try {
      session = this.db.prepare("SELECT clone_name FROM sessions WHERE id = ?")
        .get(row.source_chat_session_id) as typeof session
    } catch {
      return
    }
    if (!session || session.clone_name) return // legacy clone thread — untouched

    const title = "归档停在 archiving"
    const message = detail ? `失败原因：${detail}` : "有 project 未归档成功，可幂等重试。"
    const actions: TaskCardAction[] = [
      { id: "retry_archive", label: "↻ 重试归档" },
      { id: "open_archive", label: "打开归档" },
    ]
    const event = getActivityBus().publish({
      kind: "task.failed",
      severity: "warn",
      title,
      message,
      workspaceId: row.workspace_id ?? null,
      taskId,
      sessionId: row.source_chat_session_id,
      payload: { status: "archiving", actions },
    })
    this.appendTaskCard({
      sessionId: row.source_chat_session_id,
      workspaceId: row.workspace_id ?? null,
      title,
      detail: message,
      event,
      status: "archiving",
      actions,
    })
    this.notifySession(row.source_chat_session_id, row.workspace_id ?? null)
    {
      void this.wake(
        { sessionId: row.source_chat_session_id, org: row.repo_group ?? '', workspaceId: row.workspace_id ?? null },
        event,
        { ephemeral: true },
      )
    }
  }

  private emitOnce(executionId: string, suffix: string, input: Omit<ActivityEvent, "id" | "createdAt">): void {
    const key = `${executionId}:${suffix}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    getActivityBus().publish(input)
  }

  private async highSignal(
    executionId: string,
    target: ChatWakeTarget | undefined,
    kind: ActivityKind,
    severity: ActivitySeverity,
    title: string,
    message?: string,
    nodeId?: string,
  ): Promise<void> {
    // Approval fires from two engine layers (node_end + lifecycle); the node
    // id can be present in one and absent in the other — dedupe per execution.
    const key = kind === "workflow.approval"
      ? `${executionId}:${kind}`
      : `${executionId}:${kind}:${nodeId ?? ""}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    const event = getActivityBus().publish({
      kind,
      severity,
      title,
      message,
      workspaceId: target?.workspaceId,
      executionId,
      nodeId,
      sessionId: target?.sessionId,
    })
    if (target) await this.wake(target, event)
  }

  private queueWake(
    target: ChatWakeTarget,
    event: ActivityEvent,
    delayMs = 3_000,
    opts?: { ephemeral?: boolean },
  ): void {
    this.pendingWakes.set(target.sessionId, { target, event, ephemeral: opts?.ephemeral })
    if (this.pendingTimers.has(target.sessionId)) return
    const timer = setTimeout(() => {
      this.pendingTimers.delete(target.sessionId)
      const pending = this.pendingWakes.get(target.sessionId)
      if (!pending) return
      if (isStreamActive(pending.target.sessionId)) {
        this.queueWake(pending.target, pending.event, delayMs, { ephemeral: pending.ephemeral })
        return
      }
      this.pendingWakes.delete(pending.target.sessionId)
      void this.wake(pending.target, pending.event, { ephemeral: pending.ephemeral })
    }, delayMs)
    if (typeof timer.unref === "function") timer.unref()
    this.pendingTimers.set(target.sessionId, timer)
  }

  private async wake(
    target: ChatWakeTarget,
    event: ActivityEvent,
    opts?: { ephemeral?: boolean; message?: string },
  ): Promise<void> {
    if (process.env.OCTOPUS_CHAT_AUTO_WAKE === "0") return
    // The agent may still be finishing the turn that started the workflow —
    // retry after it goes idle instead of dropping the completion event.
    if (isStreamActive(target.sessionId)) {
      this.queueWake(target, event, 3_000, opts)
      return
    }

    const last = this.lastWakeAt.get(target.sessionId) ?? 0
    if (Date.now() - last < WAKE_COALESCE_MS) {
      this.queueWake(target, event, 3_000, opts)
      return
    }

    if (event.executionId) {
      const count = (this.wakeCount.get(event.executionId) ?? 0) + 1
      if (count > MAX_WAKES_PER_EXECUTION) return
      this.wakeCount.set(event.executionId, count)
    }
    this.lastWakeAt.set(target.sessionId, Date.now())

    const detail = [
      event.message ? `详情：${event.message}` : null,
      event.executionId ? `execution_id：${event.executionId}` : null,
      event.taskId ? `task_id：${event.taskId}` : null,
    ].filter(Boolean).join("\n")
    const message = opts?.message ?? [
      `[活动通知 · ${event.kind}] ${event.title}`,
      detail,
      "请判断是否需要处理。需要时调用工作流工具（get_execution / respond_approval / retry_node / cancel_execution），并把结论简短告诉用户。",
    ].filter(Boolean).join("\n")

    const port = process.env.PORT ?? "3001"
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/sessions/${target.sessionId}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer agent",
          "X-Octopus-Org": target.org,
        },
        body: JSON.stringify({
          message,
          wake: true,
          ...(opts?.ephemeral ? { ephemeral: true } : {}),
          activity: {
            kind: event.kind,
            severity: event.severity,
            title: event.title,
            executionId: event.executionId,
            taskId: event.taskId,
            nodeId: event.nodeId,
            workspaceId: event.workspaceId ?? target.workspaceId ?? null,
            status: (event.payload as Record<string, unknown> | undefined)?.status ?? null,
            actions: (event.payload as Record<string, unknown> | undefined)?.actions ?? null,
          },
        }),
      })
      if (response.ok && response.body) {
        const reader = response.body.getReader()
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
      }
    } catch (err: unknown) {
      if (process.env.NODE_ENV !== "test") {
        console.warn(`[ChatEventBridge] wake failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}

let bridge: ChatEventBridge | null = null

export function getChatEventBridge(): ChatEventBridge {
  if (!bridge) bridge = new ChatEventBridge()
  return bridge
}

/** Test seam: drop the singleton so each test starts with fresh in-memory state. */
export function resetChatEventBridgeForTests(): void {
  bridge = null
}

/** Start once at server boot: global SSE fan-in → activity bus + chat wake. */
export function initChatEventBridge(sse: SSEService, db: SqliteLike): ChatEventBridge {
  const instance = getChatEventBridge()
  instance.attach(db)
  instance.attachSse(sse)
  sse.subscribeAll((event) => instance.handleSse(event))
  return instance
}
