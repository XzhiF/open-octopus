// packages/server/src/services/chat/task-tools.ts
//
// 2026-10-28 task-thread: in-process MCP tools for the ONE main chat.
//
// Two principles:
//   1. READ tools are free; WRITE/ACTION tools are identity-gated and the
//      destructive ones do NOT execute — they append a confirmation card that
//      the human clicks (request_task_action). The model can respond to
//      "stop it" but never bypasses the gate.
//   2. Spec writes go through TasksService (validation + version + SSE + home
//      backfill), not raw SQL. The service is created later in index.ts, so the
//      provider is a late-bound registry.

import { randomUUID } from "crypto"
import type Database from "better-sqlite3"
import { z } from "zod"
import { createSdkMcpServer, tool } from "@octopus/providers"
import { TaskSpecFieldSchema } from "@octopus/shared"
import type { TaskThreadIdentity, TaskThreadProfile } from "../tasks/task-thread-service"
import type { ServerSpecField } from "../tasks/tasks-service"
import { writeReflectionStore, type ReflectionStore } from "../tasks/reflection-store"

export interface TaskToolsService {
  updateSpecField(
    id: string,
    input: { field: ServerSpecField; value: unknown; source: "agent" },
  ): { version: number }
}

let serviceProvider: (() => TaskToolsService | null) | null = null

/** index.ts wires the real TasksService once it exists. Tests inject a fake. */
export function setTaskToolsServiceProvider(fn: (() => TaskToolsService | null) | null): void {
  serviceProvider = fn
}

export interface TaskToolAction {
  id: string
  label: string
}

export interface TaskToolCard {
  kind: string
  severity: "info" | "warn" | "critical"
  title: string
  message?: string
  taskId: string
  phaseIndex?: number | null
  roundIndex?: number | null
  workspaceId?: string | null
  actions: TaskToolAction[]
  payload?: Record<string, unknown>
}

/** Append an event card (same message shape as the bridge: displayType:'event'). */
export function appendTaskToolCard(
  db: Database.Database,
  sessionId: string,
  card: TaskToolCard,
): void {
  const now = new Date().toISOString()
  const activity = {
    kind: card.kind,
    severity: card.severity,
    title: card.title,
    message: card.message ?? null,
    taskId: card.taskId,
    phaseIndex: card.phaseIndex ?? null,
    roundIndex: card.roundIndex ?? null,
    workspaceId: card.workspaceId ?? null,
    actions: card.actions,
    ...(card.payload ? { payload: card.payload } : {}),
  }
  db.prepare(
    "INSERT INTO messages (id, session_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    randomUUID(),
    sessionId,
    "user",
    `[任务工具 · ${card.kind}] ${card.title}\n${card.message ?? ""}`.trimEnd(),
    JSON.stringify({ displayType: "event", activity }),
    now,
  )
  db.prepare(
    "UPDATE sessions SET last_message_at = ?, updated_at = ? WHERE id = ?",
  ).run(now, now, sessionId)
}

const STATUS_ACTIONS: Record<string, TaskToolAction[]> = {
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
  ],
  aborted: [{ id: "open_run", label: "打开日志" }],
  failed: [{ id: "open_run", label: "打开日志" }],
}

export interface TaskToolServerInput {
  db: Database.Database
  sessionId: string
  profile: TaskThreadProfile
  identity: TaskThreadIdentity
}

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
})

export type TaskActionId =
  | "pause" | "resume" | "abort" | "trigger" | "retry_archive" | "inject"

/** Pure gate shared by the tool and tests. */
export function canRunTaskAction(
  identity: TaskThreadIdentity,
  displayStatus: string,
  action: TaskActionId,
): { ok: boolean; reason?: string } {
  if (identity !== "doer") return { ok: false, reason: "当前身份不是执行者，不能发起任务动作。" }
  const allowed =
    action === "pause" ? displayStatus === "running"
      : action === "resume" ? displayStatus === "paused"
        : action === "abort" ? ["ready", "running", "paused"].includes(displayStatus)
          : action === "trigger" ? displayStatus === "ready"
            : action === "retry_archive" ? displayStatus === "archiving"
              : action === "inject" ? ["running", "paused"].includes(displayStatus)
                : false
  return allowed ? { ok: true } : { ok: false, reason: `当前状态 ${displayStatus} 不允许 ${action}。` }
}

export function buildLaunchProposalCard(profile: TaskThreadProfile, note?: string): TaskToolCard {
  const task = profile.task
  return {
    kind: "task.launch_proposal",
    severity: "info",
    title: "启动方式待选择",
    message: note ?? "规格已齐。选择启动方式，或继续改规格。",
    taskId: task.id,
    phaseIndex: task.phaseIndex,
    roundIndex: task.roundIndex,
    workspaceId: task.workspaceId,
    actions: [
      { id: "launch_now", label: "立即执行" },
      { id: "enqueue", label: "入列，等我手动触发" },
      { id: "schedule", label: "定时触发…" },
      { id: "keep_editing", label: "继续改规格" },
    ],
    payload: { proposal: "launch" },
  }
}

const ACTION_LABELS: Record<TaskActionId, string> = {
  pause: "暂停任务",
  resume: "恢复任务",
  abort: "中止任务",
  trigger: "触发任务",
  retry_archive: "重试归档",
  inject: "注入干预并恢复",
}

export function buildActionRequestCard(
  profile: TaskThreadProfile,
  action: TaskActionId,
  reason: string,
  intervention?: string,
): { card?: TaskToolCard; error?: string } {
  const gate = canRunTaskAction(profile.identity, profile.task.displayStatus, action)
  if (!gate.ok) return { error: gate.reason }
  if (action === "inject" && !intervention?.trim()) {
    return { error: "inject 需要 intervention 文本。" }
  }
  const task = profile.task
  return {
    card: {
      kind: "task.action_request",
      severity: action === "abort" ? "warn" : "info",
      title: `请求：${ACTION_LABELS[action]}`,
      message: reason,
      taskId: task.id,
      phaseIndex: task.phaseIndex,
      roundIndex: task.roundIndex,
      workspaceId: task.workspaceId,
      actions: [
        { id: "confirm_action", label: "确认执行" },
        { id: "cancel_action", label: "取消" },
      ],
      payload: { action, reason, ...(intervention ? { intervention } : {}) },
    },
  }
}

export function createTaskToolServer(input: TaskToolServerInput) {
  const { db, sessionId, profile, identity } = input
  const task = profile.task

  const statusSnapshot = () => ({
    id: task.id,
    name: task.name,
    status: task.status,
    displayStatus: task.displayStatus,
    phaseIndex: task.phaseIndex,
    roundIndex: task.roundIndex,
    awaitingReview: task.awaitingReview,
    workspaceId: task.workspaceId,
    workspacePath: task.wsPath,
    taskHome: task.taskHome,
    identity,
    readOnly: profile.readOnly,
    actions: STATUS_ACTIONS[task.displayStatus] ?? [],
  })

  const tools = [
    tool(
      "get_task_status",
      "Read the bound task's current status, phase/round, workspace and available actions. Read-only; use it whenever the user asks what is happening.",
      {},
      async () => text(statusSnapshot()),
    ),
    tool(
      "update_task_spec_field",
      "Author identity only. Merge ONE task_spec field (goal/ac/phases/slug/branch/...). Goes through the server's spec-field pipeline (validation + version + SSE).",
      {
        field: TaskSpecFieldSchema.describe("The spec field to write"),
        value: z.unknown().describe("The field value (string / array / object, matching the field)"),
      },
      async ({ field, value }) => {
        if (identity !== "author") {
          return text({ ok: false, error: "只有任务作者身份可以改规格；执行期请走计划回写。" })
        }
        const service = serviceProvider?.() ?? null
        if (!service) {
          return text({ ok: false, error: "规格服务未就绪，请稍后重试。" })
        }
        try {
          const result = service.updateSpecField(task.id, { field, value, source: "agent" })
          return text({ ok: true, field, version: result.version })
        } catch (err: unknown) {
          return text({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
    tool(
      "propose_launch",
      "Author identity only. Show the user the three launch choices (run now / enqueue and wait / schedule). This appends a decision card; it does NOT start anything.",
      { note: z.string().max(500).optional().describe("Optional one-line summary shown on the card") },
      async ({ note }) => {
        if (identity !== "author") {
          return text({ ok: false, error: "只有任务作者身份可以发起入列/启动提议。" })
        }
        appendTaskToolCard(db, sessionId, buildLaunchProposalCard(profile, note))
        return text({ ok: true, card: "task.launch_proposal" })
      },
    ),
    tool(
      "request_task_action",
      "Doer identity only. Ask the human to confirm a task action (pause/resume/abort/trigger/retry_archive/inject). This appends a confirmation card; it does NOT execute. Use it when the user says stop / resume / rerun / change course.",
      {
        action: z.enum(["pause", "resume", "abort", "trigger", "retry_archive", "inject"]),
        reason: z.string().max(1000).describe("Why this action is needed (shown to the human)"),
        intervention: z.string().max(2000).optional().describe("For inject: the instruction to give the interrupted node"),
      },
      async ({ action, reason, intervention }) => {
        const built = buildActionRequestCard(profile, action, reason, intervention)
        if (!built.card) return text({ ok: false, error: built.error })
        appendTaskToolCard(db, sessionId, built.card)
        return text({ ok: true, card: "task.action_request", action })
      },
    ),
    tool(
      "propose_wiki_entries",
      "Archiving only (reflection turn). Propose 2–5 concise knowledge entries worth preserving in the wiki (decisions, pitfalls, glossary terms). The human decides per entry whether to ingest or skip; this does NOT write the wiki by itself.",
      {
        entries: z.array(
          z.object({
            title: z.string().min(1).max(200),
            content: z.string().min(1).max(20_000).describe("The full wiki body"),
            target: z.string().max(200).optional().describe("Destination hint, e.g. 'GLOSSARY · 敏感词匹配' or 'ADR · 打回单路径'"),
          }),
        ).min(1).max(5),
      },
      async ({ entries }) => {
        if (identity !== "doer" || task.status !== "archiving") {
          return text({ ok: false, error: "知识反思只在任务归档阶段（archiving）由执行者发起。" })
        }
        const store: ReflectionStore = {
          task_id: task.id,
          created_at: new Date().toISOString(),
          entries: entries.map((e, i) => ({
            id: `refl-${i + 1}`,
            title: e.title,
            content: e.content,
            ...(e.target ? { target: e.target } : {}),
          })),
          decisions: {},
        }
        try {
          writeReflectionStore(task.taskHome, store)
        } catch (err: unknown) {
          return text({ ok: false, error: `反思结果落盘失败：${err instanceof Error ? err.message : String(err)}` })
        }
        appendTaskToolCard(db, sessionId, {
          kind: "task.reflection",
          severity: "info",
          title: `归档反思 · ${store.entries.length} 条沉淀建议`,
          message: "逐条选择：落 wiki / 跳过。系统自动投喂仍在后台进行。",
          taskId: task.id,
          phaseIndex: task.phaseIndex,
          roundIndex: task.roundIndex,
          workspaceId: task.workspaceId,
          actions: [],
          payload: { entries: store.entries, autoIngest: true },
        })
        return text({ ok: true, entries: store.entries.length })
      },
    ),
  ]

  return createSdkMcpServer({
    name: "octopus-task",
    version: "1.0.0",
    instructions:
      "These tools operate on the task bound to this chat. Read status freely. Spec writes are author-only. Actions (pause/resume/abort/trigger/retry_archive/inject) only append a confirmation card — the human decides; never claim the action already happened.",
    tools,
    alwaysLoad: true,
  })
}
