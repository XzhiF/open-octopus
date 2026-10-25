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
  private pendingWakes = new Map<string, { target: ChatWakeTarget; event: ActivityEvent }>()
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private db: SqliteLike | null = null

  attach(db: SqliteLike): void {
    this.db = db
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
    const high =
      status === "done" ? ("task.completed" as ActivityKind)
        : status === "failed" || status === "aborted" ? ("task.failed" as ActivityKind)
          : status === "awaiting_review" ? ("task.review" as ActivityKind)
            : null
    if (!high) return

    let row: { name?: string; org?: string; source_chat_session_id?: string | null; workspace_id?: string | null } | undefined
    try {
      row = this.db.prepare(
        "SELECT name, org, source_chat_session_id, workspace_id FROM tasks WHERE id = ?",
      ).get(taskId) as typeof row
    } catch {
      return
    }
    if (!row) return

    const key = `task:${taskId}:${status}`
    if (this.seen.has(key)) return
    this.seen.add(key)

    const title =
      high === "task.completed" ? `任务完成：${row.name ?? taskId.slice(0, 8)}`
        : high === "task.review" ? `任务等待验收：${row.name ?? taskId.slice(0, 8)}`
          : `任务失败：${row.name ?? taskId.slice(0, 8)}`
    const severity: ActivitySeverity = high === "task.failed" ? "critical" : high === "task.review" ? "warn" : "info"
    const event = getActivityBus().publish({
      kind: high,
      severity,
      title,
      workspaceId: row.workspace_id ?? null,
      taskId,
      sessionId: row.source_chat_session_id ?? null,
    })
    if (row.source_chat_session_id && row.org) {
      void this.wake({ sessionId: row.source_chat_session_id, org: row.org, workspaceId: row.workspace_id }, event)
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

  private queueWake(target: ChatWakeTarget, event: ActivityEvent, delayMs = 3_000): void {
    this.pendingWakes.set(target.sessionId, { target, event })
    if (this.pendingTimers.has(target.sessionId)) return
    const timer = setTimeout(() => {
      this.pendingTimers.delete(target.sessionId)
      const pending = this.pendingWakes.get(target.sessionId)
      if (!pending) return
      if (isStreamActive(pending.target.sessionId)) {
        this.queueWake(pending.target, pending.event, delayMs)
        return
      }
      this.pendingWakes.delete(pending.target.sessionId)
      void this.wake(pending.target, pending.event)
    }, delayMs)
    if (typeof timer.unref === "function") timer.unref()
    this.pendingTimers.set(target.sessionId, timer)
  }

  private async wake(target: ChatWakeTarget, event: ActivityEvent): Promise<void> {
    if (process.env.OCTOPUS_CHAT_AUTO_WAKE === "0") return
    // The agent may still be finishing the turn that started the workflow —
    // retry after it goes idle instead of dropping the completion event.
    if (isStreamActive(target.sessionId)) {
      this.queueWake(target, event)
      return
    }

    const last = this.lastWakeAt.get(target.sessionId) ?? 0
    if (Date.now() - last < WAKE_COALESCE_MS) {
      this.queueWake(target, event)
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
    const message = [
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
          activity: {
            kind: event.kind,
            severity: event.severity,
            title: event.title,
            executionId: event.executionId,
            taskId: event.taskId,
            nodeId: event.nodeId,
            workspaceId: event.workspaceId ?? target.workspaceId ?? null,
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

/** Start once at server boot: global SSE fan-in → activity bus + chat wake. */
export function initChatEventBridge(sse: SSEService, db: SqliteLike): ChatEventBridge {
  const instance = getChatEventBridge()
  instance.attach(db)
  sse.subscribeAll((event) => instance.handleSse(event))
  return instance
}
