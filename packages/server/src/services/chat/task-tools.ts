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
import type { PlanDetail } from "../tasks/acceptance-plan-service"
import type { ChecksFile, ProbeRunResult } from "../tasks/playbook-types"
import type { AcceptanceResult } from "../tasks/tasks-service"
import type { ProjectDelta } from "../tasks/archive-delta"

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

// ── 验收引导工具（2026-10-30 AI-native 验收）──────────────────────────
// 只在该任务的会话处于 acceptanceGuide 时注册。读自由、写（recordCheck）需人
// 明确表态；升级只出确认卡，不执行。

export interface AcceptanceToolsService {
  getPlanDetail(taskId: string): PlanDetail
  recordCheck(taskId: string, input: { itemId: string; decision: "pass" | "fail" | "skip"; note?: string }): {
    checks: ChecksFile
  }
  /** 最终放行 / 退回（与 POST /:id/acceptance 同一套步骤：✗ 硬闸 + 台账 + 重开票）。 */
  finalizeAcceptance(
    taskId: string,
    input: { decision: "accepted" | "rejected"; feedback?: string; reopen_tickets?: string[] },
  ): Promise<{ result: AcceptanceResult; ledger_written: boolean; undecided: string[] }>
  runProbe(taskId: string, itemId: string): Promise<ProbeRunResult>
  startPreview(taskId: string): Promise<{ state: string; url?: string; views?: unknown }>
  stopPreview(taskId: string): unknown
  /** 放行前终检：末轮 end → 当前 HEAD 的提交 + dirty 文件（只读）。 */
  getPostRoundDelta(taskId: string): ProjectDelta[]
}

let acceptanceProvider: (() => AcceptanceToolsService | null) | null = null

export function setAcceptanceToolsProvider(fn: (() => AcceptanceToolsService | null) | null): void {
  acceptanceProvider = fn
}

function acceptanceService(): AcceptanceToolsService | null {
  try {
    return acceptanceProvider?.() ?? null
  } catch {
    return null
  }
}

// ── 归档引导工具（2026-10-31 AI-native 归档）─────────────────────────
// Chat 里只留一张「归档总框」；git 进度 / 术语冲突 / 反思 / 知识包都从
// get_archive_state 读。人的口头决定（落 / 跳过 / 重试）由 Agent 在
// confirmed=true 后**直接执行**并回执 —— 不再铺按钮矩阵或确认卡。

export interface ArchiveToolsService {
  readArchive(taskId: string): unknown
  decideReflection(
    taskId: string,
    input: { entry_id: string; action: "ingest" | "skip"; title?: string; content?: string },
  ): Promise<{ ok: true; store: ReflectionStore; decision: unknown }>
  retryArchive(taskId: string): unknown
  resolveArchiveDelta(
    taskId: string,
    action: "include" | "exclude",
  ): { ok: true; decision: "include" | "exclude"; dirty_projects: string[] }
  /** done 之后的只增不改增补（可选同时落 wiki）。 */
  recordAmendment(
    taskId: string,
    input: { reason: string; content: string; title?: string; target?: string; ingest?: boolean },
  ): Promise<{ ok: true; amendment: unknown; amendments: unknown[] }>
  /** done 之后开跟进任务（复制 spec + 新主会话 + 绑定）。 */
  openFollowupTask(taskId: string): { task_id: string; session_id: string; name: string }
}

let archiveProvider: (() => ArchiveToolsService | null) | null = null

export function setArchiveToolsProvider(fn: (() => ArchiveToolsService | null) | null): void {
  archiveProvider = fn
}

function archiveService(): ArchiveToolsService | null {
  try {
    return archiveProvider?.() ?? null
  } catch {
    return null
  }
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

/**
 * 用户在**对话里口语表态**（而不是点卡片）时，把最近一张同项验收卡标成「已选」。
 * 不这样做的话，历史里的卡片会一直显示可点，跟盘上真相（checks 已记录）打架。
 * 只看最近 50 条含 task.acceptance_check 的消息；写失败不影响核对本身。
 */
function markAcceptanceCardDecided(
  db: Database.Database,
  sessionId: string,
  itemId: string,
  decision: "pass" | "fail" | "skip",
): void {
  try {
    const rows = db.prepare(
      "SELECT id, metadata FROM messages WHERE session_id = ? AND metadata LIKE ? ORDER BY created_at DESC LIMIT 50",
    ).all(sessionId, '%"kind":"task.acceptance_check"%') as Array<{ id: string; metadata: string | null }>
    for (const row of rows) {
      let meta: Record<string, unknown>
      try {
        meta = JSON.parse(row.metadata ?? "{}") as Record<string, unknown>
      } catch {
        continue
      }
      const act = meta.activity as Record<string, unknown> | undefined
      if (!act || act.kind !== "task.acceptance_check" || act.decision) continue
      const p = (act.payload ?? {}) as Record<string, unknown>
      if (p.itemId !== itemId) continue
      act.decision = {
        id: `acceptance_${decision}`,
        label: decision === "pass" ? "通过" : decision === "fail" ? "不通过" : "跳过",
        at: new Date().toISOString(),
        via: "chat",
      }
      meta.activity = act
      db.prepare("UPDATE messages SET metadata = ? WHERE id = ?").run(JSON.stringify(meta), row.id)
      return
    }
  } catch {
    /* 历史卡片标注是锦上添花 —— 核对写入才是权威 */
  }
}

const STATUS_ACTIONS: Record<string, TaskToolAction[]> = {  draft: [{ id: "open_spec", label: "打开规格" }],
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

  const acceptanceTools = profile.acceptanceGuide ? [
    tool(
      "get_acceptance_plan",
      "Read the current round's acceptance plan: `cases` are the 1–3 human scenarios (open → do → observe) you walk the human through; `checks` are machine evidence already recorded this round — report them in one line, never ask the human to confirm them one by one. Also returns progress (over cases), evidence summary (total/missing), and the post-round site (postRound: commits after the last round's end anchor + uncommitted files). Read-only.",
      {},
      async () => {
        const svc = acceptanceService()
        if (!svc) return text({ ok: false, error: "验收服务未就绪" })
        try {
          const detail = svc.getPlanDetail(task.id)
          let postRound: ProjectDelta[] = []
          try {
            postRound = svc.getPostRoundDelta(task.id)
          } catch {
            postRound = []
          }
          return text({ ok: true, ...detail, postRound })
        } catch (err: unknown) {
          return text({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
    tool(
      "ask_acceptance_check",
      "Ask the human to confirm ONE human scenario (`case`). Appends a self-contained card (场景步骤 / 通过标准 / 证据) with 通过 / 不通过 / 跳过. Ask one case at a time; never batch. Machine evidence (`checks`) must NOT be asked this way — summarize it in one line instead. The human may answer in words instead of clicking — if they say 通过/可以/不行, record it yourself with record_acceptance_check.",
      {
        item_id: z.string().min(1).describe("The plan case id (e.g. case:1)"),
      },
      async ({ item_id }) => {
        const svc = acceptanceService()
        if (!svc) return text({ ok: false, error: "验收服务未就绪" })
        try {
          const detail = svc.getPlanDetail(task.id)
          const item = detail.plan?.cases.find((it) => it.id === item_id)
          if (!item) return text({ ok: false, error: `未知验收场景: ${item_id}（机器证据项不需要人工确认）` })
          const all = detail.plan?.cases ?? []
          const index = all.findIndex((it) => it.id === item_id) + 1
          appendTaskToolCard(db, sessionId, {
            kind: "task.acceptance_check",
            severity: "info",
            title: `验收场景 ${index}/${all.length} · ${item.title}`,
            message: [
              item.story ? `场景：${item.story}` : "",
              item.setup ? `起点：${item.setup}` : "",
              `通过标准：${item.expect}`,
              "也可以直接在对话里说「通过 / 不行，因为… / 跳过」，我会记录。",
            ].filter(Boolean).join("\n"),
            taskId: task.id,
            phaseIndex: task.phaseIndex,
            roundIndex: task.roundIndex,
            workspaceId: task.workspaceId,
            actions: [
              { id: "acceptance_pass", label: "✓ 通过" },
              { id: "acceptance_fail", label: "✕ 不通过" },
              { id: "acceptance_skip", label: "⊘ 跳过" },
              { id: "acceptance_open_window", label: "打开验收台" },
            ],
            payload: {
              acceptanceCheck: true,
              itemId: item.id,
              title: item.title,
              story: item.story,
              setup: item.setup,
              ticket: item.tickets[0],
              tickets: item.tickets,
              index,
              total: all.length,
              expect: item.expect,
              steps: item.steps.map((s) => ({
                kind: s.kind, text: s.text, target: s.target, value: s.value, expect: s.expect,
              })),
              evidence: item.evidenceRefs.slice(0, 4).map((e) => ({
                kind: e.kind, label: e.label, missing: !!e.missing,
              })),
              phaseIndex: task.phaseIndex,
              roundIndex: task.roundIndex,
            },
          })
          return text({ ok: true, card: "task.acceptance_check", item_id })
        } catch (err: unknown) {
          return text({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
    tool(
      "record_acceptance_check",
      "Record the human's explicit decision for ONE acceptance scenario (`case`). ONLY call after the human has clearly answered (clicked the card or said so). fail/skip require a reason. Machine evidence (`checks`) is never signed. Set confirmed=true to assert you have that explicit answer.",
      {
        item_id: z.string().min(1).describe("The plan case id (e.g. case:1)"),
        decision: z.enum(["pass", "fail", "skip"]),
        note: z.string().max(2000).optional().describe("Required for fail/skip: what went wrong / why skipped"),
        confirmed: z.boolean().describe("true only when the human explicitly said this — never infer"),
      },
      async ({ item_id, decision, note, confirmed }) => {
        if (!confirmed) {
          return text({ ok: false, error: "必须等用户明确表态后才能记录（confirmed=true）；不要代替人判断。" })
        }
        const svc = acceptanceService()
        if (!svc) return text({ ok: false, error: "验收服务未就绪" })
        try {
          svc.recordCheck(task.id, { itemId: item_id, decision, note })
          // 口语表态也要让历史卡片对上：最近一张同项卡标「已选」。
          markAcceptanceCardDecided(db, sessionId, item_id, decision)
          const detail = svc.getPlanDetail(task.id)
          return text({ ok: true, item_id, decision, progress: detail.progress })
        } catch (err: unknown) {
          return text({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
    tool(
      "submit_acceptance_decision",
      "Finalize this round's acceptance decision: accepted = 放行/通过 (advance or archive), rejected = 退回修改 (dispatches the task-fix round). Call ONLY when the human explicitly says so in this chat (e.g. 「全部通过，放行」「可以了，收」「退回，让他改…」). The acceptance window click is their fallback, not a requirement — but never infer consent: no explicit instruction, no call. accepted is refused while any item is ✗. rejected requires feedback, which becomes the fix-round instruction.",
      {
        decision: z.enum(["accepted", "rejected"]).describe("accepted = 放行 (advance/archive); rejected = 退回修改 (dispatch task-fix)"),
        feedback: z.string().max(20000).optional().describe("Required for rejected: what must be fixed (becomes the fix-round instruction)"),
        reopen_tickets: z
          .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/))
          .max(20)
          .optional()
          .describe("Optional ticket bases to reopen on reject; derived from ✗ items when omitted"),
        confirmed: z.boolean().describe("true only when the human explicitly instructed this — never infer"),
      },
      async ({ decision, feedback, reopen_tickets, confirmed }) => {
        if (!confirmed) {
          return text({ ok: false, error: "必须等用户明确说放行/退回后才能执行（confirmed=true）—— 不要代替人签字。" })
        }
        if (decision === "rejected" && !(feedback ?? "").trim()) {
          return text({ ok: false, error: "退回必须给出反馈（feedback）—— 它会成为修复轮的指令。" })
        }
        const svc = acceptanceService()
        if (!svc) return text({ ok: false, error: "验收服务未就绪" })
        try {
          const out = await svc.finalizeAcceptance(task.id, { decision, feedback, reopen_tickets })
          return text({
            ok: true,
            decision,
            next_action: out.result.next_action,
            acceptance_id: out.result.acceptance_id,
            ledger_written: out.ledger_written,
            // 放行时若仍有未勾项，如实回传 —— 让用户知道这次放行覆盖了什么。
            undecided: out.undecided,
          })
        } catch (err: unknown) {
          return text({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
    tool(
      "run_acceptance_probe",
      "Run the on-demand recheck command for ONE plan entry (a machine evidence `check`, or a legacy scenario step that carries a command) inside the task workspace, returning exit code + tail. Only run when the human asks for a fresh result — never auto-run or batch-run the evidence table (e2e / slow commands especially). Read-only / re-runnable.",
      {
        item_id: z.string().min(1),
        timeout_s: z.number().int().min(5).max(600).optional().describe("Optional timeout in seconds (default 300)"),
      },
      async ({ item_id }) => {
        const svc = acceptanceService()
        if (!svc) return text({ ok: false, error: "验收服务未就绪" })
        try {
          const r = await svc.runProbe(task.id, item_id)
          return text({ ok: true, item_id, ...r })
        } catch (err: unknown) {
          return text({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
    tool(
      "start_acceptance_preview",
      "Start the task's configured preview runbook so the human can look at the running app. Never auto-runs outside an explicit acceptance step; stop it when done.",
      {},
      async () => {
        const svc = acceptanceService()
        if (!svc) return text({ ok: false, error: "验收服务未就绪" })
        try {
          return text({ ok: true, ...(await svc.startPreview(task.id) as Record<string, unknown>) })
        } catch (err: unknown) {
          return text({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
    tool(
      "stop_acceptance_preview",
      "Stop the running preview started via start_acceptance_preview (runs the runbook teardown).",
      {},
      async () => {
        const svc = acceptanceService()
        if (!svc) return text({ ok: false, error: "验收服务未就绪" })
        try {
          return text({ ok: true, ...(svc.stopPreview(task.id) as Record<string, unknown>) })
        } catch (err: unknown) {
          return text({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
    tool(
      "propose_acceptance_escalation",
      "When a problem is beyond a ≤2-file small fix (needs spec change, 3+ files, or repeated failed fixes), ask the human to confirm escalating to the task-fix big-fix workflow. Appends a confirmation card; does NOT execute — the human clicks to dispatch.",
      {
        feedback: z.string().min(1).max(4000).describe("What is wrong and why it needs a fix round"),
        item_ids: z.array(z.string()).max(20).optional().describe("Acceptance items this feedback relates to"),
      },
      async ({ feedback, item_ids }) => {
        appendTaskToolCard(db, sessionId, {
          kind: "task.acceptance_escalation",
          severity: "warn",
          title: "升级为大修复（task-fix）？",
          message: feedback,
          taskId: task.id,
          phaseIndex: task.phaseIndex,
          roundIndex: task.roundIndex,
          workspaceId: task.workspaceId,
          actions: [
            { id: "acceptance_escalate_confirm", label: "确认升级 · 开修复轮" },
            { id: "cancel_action", label: "取消" },
          ],
          payload: {
            feedback,
            itemIds: item_ids ?? [],
            phaseIndex: task.phaseIndex,
            roundIndex: task.roundIndex,
          },
        })
        return text({ ok: true, card: "task.acceptance_escalation" })
      },
    ),
  ] : []

  // 归档阶段（archiving / done）才注册：读自由；口头决定经 confirmed=true 直接执行。
  const archiveTools = (task.status === "archiving" || task.status === "done") ? [
    tool(
      "get_archive_state",
      "Read the archive read-model: task status, in-flight, per-project ids, state.json (completed projects + commits), report.json (failures / term conflicts / PR destinations), reflection entries + decisions, and knowledge pack/compile status. Use this before summarizing archive progress or asking the human about reflection entries. Read-only.",
      {},
      async () => {
        const svc = archiveService()
        if (!svc) return text({ ok: false, error: "归档服务未就绪" })
        try {
          // 读模型给的是事实，不是全文：report.md 可能 200KB、反思正文可能 5×20KB，
          // 直接塞进对话会烧掉大量 token。这里只保留指针/摘要；需要全文时模型可
          // 用 Read 打开 task home 里的 archive/report.md。
          const dto = svc.readArchive(task.id) as Record<string, unknown> & {
            report_md?: string | null
            reflection?: {
              entries?: Array<{ id: string; title: string; target?: string; content?: string }>
              decisions?: Record<string, unknown>
            } | null
          }
          const { report_md: reportMd, reflection, ...rest } = dto
          const compactReflection = reflection
            ? {
                entries: (reflection.entries ?? []).map((e) => ({
                  id: e.id,
                  title: e.title,
                  ...(e.target ? { target: e.target } : {}),
                  preview: (e.content ?? "").slice(0, 400),
                })),
                decisions: reflection.decisions ?? {},
              }
            : null
          return text({
            ok: true,
            ...rest,
            reflection: compactReflection,
            ...(reportMd ? { report_md_chars: reportMd.length, report_md_hint: "全文在 task home 的 archive/report.md（需要时用 Read 打开）" } : {}),
          })
        } catch (err: unknown) {
          return text({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
    tool(
      "record_reflection_decision",
      "Record the human's explicit decision for ONE archive reflection entry: ingest (落 wiki) or skip. Call ONLY after the human clearly said so in this chat (e.g. 「落」「跳过」「剩下的都跳过」); set confirmed=true to assert that. Do NOT infer consent and do NOT batch on your own — when the user says 「都跳过」, call once per remaining entry or state how many you are skipping.",
      {
        entry_id: z.string().min(1).describe("Reflection entry id from get_archive_state (e.g. refl-1)"),
        action: z.enum(["ingest", "skip"]),
        title: z.string().max(200).optional().describe("Optional edited title before ingest"),
        content: z.string().max(50_000).optional().describe("Optional edited body before ingest"),
        confirmed: z.boolean().describe("true only when the human explicitly said this — never infer"),
      },
      async ({ entry_id, action, title, content, confirmed }) => {
        if (!confirmed) {
          return text({ ok: false, error: "必须等用户明确说「落 / 跳过」后才能记录（confirmed=true）—— 不要代替人决定。" })
        }
        if (task.status !== "archiving" && task.status !== "done") {
          return text({ ok: false, error: "反思决策只在归档阶段（archiving / done）可用。" })
        }
        const svc = archiveService()
        if (!svc) return text({ ok: false, error: "归档服务未就绪" })
        try {
          const out = await svc.decideReflection(task.id, {
            entry_id,
            action,
            ...(title ? { title } : {}),
            ...(content ? { content } : {}),
          })
          const remaining = out.store.entries.filter((e) => !out.store.decisions[e.id]).length
          return text({
            ok: true,
            entry_id,
            action,
            decision: out.decision,
            remaining,
            decided: Object.keys(out.store.decisions).length,
            total: out.store.entries.length,
          })
        } catch (err: unknown) {
          return text({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
    tool(
      "retry_archive",
      "Retry the archive orchestration (project-granular, idempotent) AFTER the human explicitly said 「重试」 in this chat. Set confirmed=true to assert that. Only valid while the task is parked in archiving; completion (done) is written by the server when every project is green — never claim it yourself.",
      {
        confirmed: z.boolean().describe("true only when the human explicitly asked to retry — never infer"),
      },
      async ({ confirmed }) => {
        if (!confirmed) {
          return text({ ok: false, error: "必须等用户明确说「重试」后才能执行（confirmed=true）—— 不要自己重试。" })
        }
        if (task.status !== "archiving") {
          return text({ ok: false, error: `只有停在 archiving 的任务可以重试（当前 ${task.status}）。` })
        }
        const svc = archiveService()
        if (!svc) return text({ ok: false, error: "归档服务未就绪" })
        try {
          svc.retryArchive(task.id)
          return text({ ok: true, started: true, hint: "续跑已触发；完成以服务端 task_status = done 为准。" })
        } catch (err: unknown) {
          return text({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
    tool(
      "resolve_archive_delta",
      "Resolve the archive preflight block for uncommitted worktree changes AFTER the human explicitly chose: include (commit them into the archive) or exclude (record the file list and archive without them). Set confirmed=true to assert the human said so. Only valid while the task is parked in archiving.",
      {
        decision: z.enum(["include", "exclude"]).describe("include = 纳入归档；exclude = 排除并记录"),
        confirmed: z.boolean().describe("true only when the human explicitly chose include/exclude — never infer"),
      },
      async ({ decision, confirmed }) => {
        if (!confirmed) {
          return text({ ok: false, error: "必须等用户明确说「纳入 / 排除」后才能执行（confirmed=true）—— 不要代替人决定。" })
        }
        if (task.status !== "archiving") {
          return text({ ok: false, error: `只有归档中(archiving)的任务可以决定放行后改动（当前 ${task.status}）。` })
        }
        const svc = archiveService()
        if (!svc) return text({ ok: false, error: "归档服务未就绪" })
        try {
          const out = svc.resolveArchiveDelta(task.id, decision)
          return text({
            ok: true,
            decision: out.decision,
            dirty_projects: out.dirty_projects,
            hint: "续跑已触发；完成以服务端 task_status = done 为准。",
          })
        } catch (err: unknown) {
          return text({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
    ...(task.status === "done" ? [
    tool(
      "record_archive_amendment",
      "Done only. Append an amendment to the closed archive AFTER the human explicitly asks to add/correct a note, decision, or glossary/ADR-style content. Append-only: never rewrites report.json/state.json. Set confirmed=true only when the human clearly asked. For code changes, use open_followup_task instead.",
      {
        reason: z.string().min(1).max(500).describe("Why this amendment is being added"),
        content: z.string().min(1).max(20_000).describe("The amendment body"),
        title: z.string().max(200).optional().describe("Optional title (used when ingest=true)"),
        target: z.string().max(200).optional().describe("Destination hint, e.g. 'GLOSSARY · term X' or 'ADR · follow-up'"),
        ingest: z.boolean().optional().describe("true = also send this amendment to the knowledge center (raw + compile queue)"),
        confirmed: z.boolean().describe("true only when the human explicitly asked for this amendment"),
      },
      async ({ reason, content, title, target, ingest, confirmed }) => {
        if (!confirmed) {
          return text({ ok: false, error: "必须等用户明确要求补充/修正归档内容后才能记录（confirmed=true）。" })
        }
        if (task.status !== "done") {
          return text({ ok: false, error: `归档增补只在任务完成(done)后可用（当前 ${task.status}）。` })
        }
        const svc = archiveService()
        if (!svc) return text({ ok: false, error: "归档服务未就绪" })
        try {
          const out = await svc.recordAmendment(task.id, {
            reason,
            content,
            ...(title ? { title } : {}),
            ...(target ? { target } : {}),
            ...(ingest ? { ingest: true } : {}),
          })
          return text({ ok: true, amendment: out.amendment, total: out.amendments.length })
        } catch (err: unknown) {
          return text({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
    tool(
      "open_followup_task",
      "Done only. Create a follow-up draft task that inherits this task's spec/artifacts and gets a fresh bound main chat, AFTER the human explicitly confirms they want to keep working. The closed task stays untouched. Set confirmed=true only when the human asked for a follow-up.",
      {
        note: z.string().max(1000).optional().describe("Optional context to carry into the follow-up (shown on the card)"),
        confirmed: z.boolean().describe("true only when the human explicitly asked to continue in a follow-up task"),
      },
      async ({ note, confirmed }) => {
        if (!confirmed) {
          return text({ ok: false, error: "必须等用户明确说「开跟进任务 / 继续改」后才能创建（confirmed=true）。" })
        }
        if (task.status !== "done") {
          return text({ ok: false, error: `跟进任务只在归档完成(done)后创建（当前 ${task.status}）。` })
        }
        const svc = archiveService()
        if (!svc) return text({ ok: false, error: "归档服务未就绪" })
        try {
          const out = svc.openFollowupTask(task.id)
          appendTaskToolCard(db, sessionId, {
            kind: "task.followup",
            severity: "info",
            title: "跟进任务已创建",
            message: note?.trim() || `${out.name} · 继承上一任务的 spec，旧归档保持不变`,
            taskId: task.id,
            workspaceId: task.workspaceId,
            actions: [{ id: "open_task", label: "打开跟进任务" }],
            payload: { followupTaskId: out.task_id, followupSessionId: out.session_id },
          })
          return text({ ok: true, task_id: out.task_id, session_id: out.session_id, name: out.name })
        } catch (err: unknown) {
          return text({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    ),
    ] : []),
  ] : []

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
      "Archiving only (reflection turn). Propose 2–5 concise knowledge entries worth preserving in the wiki (decisions, pitfalls, glossary terms). Writes the proposals to the task home; it does NOT write the wiki and does NOT append a card. After calling it, ask the human in plain chat — one entry at a time — whether to 落 wiki or skip; the human decides per entry.",
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
        // 2026-10-31 AI-native：不再往对话里塞逐条按钮卡 —— 总框 + 口述引导。
        return text({
          ok: true,
          entries: store.entries.map((e) => ({ id: e.id, title: e.title, ...(e.target ? { target: e.target } : {}) })),
          next: "逐条用消息问用户：落 wiki 还是跳过（一次一条）。",
        })
      },
    ),
    ...acceptanceTools,
    ...archiveTools,
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
