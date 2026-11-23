// packages/server/src/services/cabin/cabin-decision-service.ts
//
// design 25 §7 / §7.1：决策票据、账本、状态机、队列与 watchdog。
//
// 三个真相源，主次必须分明：
//   · 票据（askId）—— 唯一权威，决定这条答案属于哪一问；
//   · 焦点（focus）—— 仅 UI 提示，绝不参与归属判断；
//   · 账本（cabin_job_events kind='decision'）—— 幂等、可重放、可审计。
//
// 账本不新开表：cabin_job_events 是 append-only 的审计序列，正好当 ledger 用。
// 每条状态迁移追加一条事件，当前状态 = 该 askId 上最后一条事件的 stage。
//
// 保底纪律（§6.2）：20s 未转达 → 机械转发。**绝不丢答案**。

import { randomUUID } from "crypto"
import type Database from "better-sqlite3"
import { isStreamActive } from "../agent/agent-service"
import type { CabinDAO } from "../../db/dao/cabin-dao"
import type { CabinJobEventRow } from "../../db/types"
import type { CabinService } from "./cabin-service"
import { askOptionLabels, formatReceiptLine, formatRelayMessage, firstAskQuestion } from "./cabin-brief"

const now = () => new Date().toISOString()

export class CabinDecisionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = "CabinDecisionError"
  }
}

export type DecisionStage = "decided" | "relayed" | "fallback_relayed" | "expired"

export interface AskCardPayload {
  authorAsk?: boolean
  askMessageId?: string
  authorSessionId?: string
  taskId?: string
  taskName?: string
  subject?: { kind: "task" | "delegation"; id: string }
  handle?: string
  decision?: string
  recommendation?: { label?: string; reason?: string }
  options?: Array<{ label?: string; impact?: string }>
  blocking?: boolean
  intent?: string
  phase?: { index?: number; round?: number } | null
  origin?: string
  questions?: unknown
}

export interface DecisionRecord {
  decisionId: string
  askId: string
  subject: { kind: "task" | "delegation"; id: string }
  handle: string
  taskName: string
  choice: string
  note?: string
  source: string
  focusAtSubmit?: string | null
  submittedAt: string
  stage: DecisionStage
  relayedAt?: string
  framing?: string
}

export interface SubmitDecisionInput {
  askId: string
  choice: string
  note?: string
  source?: "card" | "composer" | "thread_fallback"
  focusAtSubmit?: string | null
  /** 兼容旧调用：显式 taskId（新代码从卡片 subject 取）。 */
  taskId?: string
}

export interface CabinDecisionDeps {
  cabin: CabinDAO
  service: CabinService
  /** 20s watchdog；测试可缩短。 */
  watchdogMs?: number
  /** 主会话是否仍在流式（busy 时延长 watchdog，避免和自己的回合抢跑）。 */
  isBusy?: (sessionId: string) => boolean
  /** 消息落库后通知前端（bridge.notifySession 同语义）。 */
  onAppend?: (sessionId: string, workspaceId: string | null) => void
  /** 委派的提问被转达后回到 running（送完答案它就该继续干活）。 */
  onDelegationRelayed?: (delegationId: string) => void
}

const DEFAULT_WATCHDOG_MS = 20_000
const MAX_WATCHDOG_EXTENSIONS = 3

export class CabinDecisionService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly extensions = new Map<string, number>()

  constructor(private readonly deps: CabinDecisionDeps) {}

  private db(): Database.Database { return this.deps.cabin.getDb() }

  private mainSession(cabinId: string): { sessionId: string; workspaceId: string | null; org: string } {
    const cabin = this.deps.cabin.findById(cabinId)
    if (!cabin) throw new CabinDecisionError(`cabin not found: ${cabinId}`, 404)
    if (!cabin.main_session_id) throw new CabinDecisionError("舱还没有主会话（先初始化）", 409)
    return { sessionId: cabin.main_session_id, workspaceId: cabin.workspace_id, org: cabin.org ?? "" }
  }

  // ── 读：卡片 / 账本 ──────────────────────────────────────────────

  /** 在舱主会话里按 askId 找那张镜像卡（信封的落点）。 */
  findAskCard(cabinId: string, askId: string): { messageId: string; payload: AskCardPayload } | null {
    const { sessionId } = this.mainSession(cabinId)
    let rows: Array<{ id: string; metadata: string | null }> = []
    try {
      rows = this.db().prepare(
        `SELECT id, metadata FROM messages
          WHERE session_id = ? AND metadata LIKE '%"authorAsk":true%'
          ORDER BY created_at DESC, rowid DESC LIMIT 100`,
      ).all(sessionId) as typeof rows
    } catch {
      return null
    }
    for (const row of rows) {
      if (!row.metadata) continue
      let meta: Record<string, unknown>
      try { meta = JSON.parse(row.metadata) as Record<string, unknown> } catch { continue }
      const payload = (meta.activity as Record<string, unknown> | undefined)?.payload as AskCardPayload | undefined
      if (!payload?.authorAsk) continue
      if ((payload.askMessageId ?? row.id) !== askId) continue
      return { messageId: row.id, payload }
    }
    return null
  }

  /** 舱内会话里的原生 AskUserQuestion 行（没有镜像卡的提问）：汐音主对话
   *  自己问的不走 requestAuthorAskCard，旧载的镜像卡也可能已被清理。
   *  消息 id 就是 derive 侧用的 askId（authorAskId 的兜底规则）。 */
  private findNativeAsk(cabinId: string, askId: string): {
    id: string
    sessionId: string
    isMain: boolean
  } | null {
    try {
      const main = this.mainSession(cabinId)
      const row = this.db().prepare(
        `SELECT m.id, m.session_id FROM messages m
           JOIN sessions s ON s.id = m.session_id
          WHERE m.id = ? AND s.cabin_id = ? AND m.tool_calls LIKE '%AskUserQuestion%'
          LIMIT 1`,
      ).get(askId, cabinId) as { id: string; session_id: string } | undefined
      if (!row) return null
      return { id: row.id, sessionId: row.session_id, isMain: row.session_id === main.sessionId }
    } catch {
      return null
    }
  }

  /** 舱主会话里所有「已投卡、未答」的提问（reminder / 队列用）。 */
  listAskCards(cabinId: string): Array<{
    askId: string
    handle: string | null
    title: string
    subject: { kind: "task" | "delegation"; id: string } | null
    question: string
    decision?: string
  }> {
    const { sessionId } = this.mainSession(cabinId)
    let rows: Array<{ id: string; metadata: string | null }> = []
    try {
      rows = this.db().prepare(
        `SELECT id, metadata FROM messages
          WHERE session_id = ? AND metadata LIKE '%"authorAsk":true%'
          ORDER BY created_at ASC, rowid ASC`,
      ).all(sessionId) as typeof rows
    } catch {
      return []
    }
    const seen = new Set<string>()
    const out: ReturnType<CabinDecisionService["listAskCards"]> = []
    for (const row of rows) {
      if (!row.metadata) continue
      let meta: Record<string, unknown>
      try { meta = JSON.parse(row.metadata) as Record<string, unknown> } catch { continue }
      const activity = meta.activity as Record<string, unknown> | undefined
      const payload = activity?.payload as AskCardPayload | undefined
      if (!payload?.authorAsk) continue
      if (activity?.decision) continue
      const askId = payload.askMessageId ?? row.id
      if (seen.has(askId)) continue
      seen.add(askId)
      const first = firstAskQuestion(payload.questions)
      out.push({
        askId,
        handle: payload.handle ?? null,
        title: payload.taskName ?? "任务",
        subject: payload.subject ?? (payload.taskId ? { kind: "task", id: payload.taskId } : null),
        question: typeof first?.question === "string" ? first.question : "",
        ...(payload.decision ? { decision: payload.decision } : {}),
      })
    }
    return out
  }

  /** 当前舱的所有决策记录（每个 askId 取最后一条事件）。 */
  listDecisions(cabinId: string): DecisionRecord[] {
    let rows: CabinJobEventRow[] = []
    try {
      rows = this.db().prepare(
        `SELECT * FROM cabin_job_events
          WHERE cabin_id = ? AND kind = 'decision'
          ORDER BY created_at ASC, rowid ASC`,
      ).all(cabinId) as CabinJobEventRow[]
    } catch {
      return []
    }
    const byAsk = new Map<string, DecisionRecord>()
    for (const row of rows) {
      let payload: Record<string, unknown>
      try { payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown> } catch { continue }
      const askId = typeof payload.askId === "string" ? payload.askId : null
      if (!askId) continue
      const stage = typeof payload.stage === "string" ? payload.stage as DecisionStage : "decided"
      const prev = byAsk.get(askId)
      byAsk.set(askId, {
        decisionId: String(payload.decisionId ?? prev?.decisionId ?? ""),
        askId,
        subject: (payload.subject as DecisionRecord["subject"]) ?? prev?.subject ?? { kind: "task", id: "" },
        handle: String(payload.handle ?? prev?.handle ?? "#?"),
        taskName: String(payload.taskName ?? prev?.taskName ?? "任务"),
        choice: String(payload.choice ?? prev?.choice ?? ""),
        note: typeof payload.note === "string" ? payload.note : prev?.note,
        source: String(payload.source ?? prev?.source ?? "card"),
        focusAtSubmit: (payload.focusAtSubmit as string | null | undefined) ?? prev?.focusAtSubmit,
        submittedAt: String(payload.submittedAt ?? prev?.submittedAt ?? row.created_at),
        stage,
        ...(typeof payload.relayedAt === "string" ? { relayedAt: payload.relayedAt } : prev?.relayedAt ? { relayedAt: prev.relayedAt } : {}),
        ...(typeof payload.framing === "string" ? { framing: payload.framing } : {}),
      })
    }
    return [...byAsk.values()]
  }

  /** reminder / 队列要用的「待转达」列表。 */
  pendingRelays(cabinId: string): DecisionRecord[] {
    return this.listDecisions(cabinId).filter((d) => d.stage === "decided")
  }

  recordForAsk(cabinId: string, askId: string): DecisionRecord | null {
    return this.listDecisions(cabinId).find((d) => d.askId === askId) ?? null
  }

  // ── 写：提交决策（票据校验 → 账本 → 结构化消息 → watchdog）──────────

  async submitDecision(cabinId: string, input: SubmitDecisionInput): Promise<{
    record: DecisionRecord
    already: boolean
  }> {
    const askId = input.askId?.trim()
    if (!askId) throw new CabinDecisionError("缺少 askId：归属必须是票据，不能靠焦点猜", 400)
    const choice = input.choice?.trim()
    if (!choice) throw new CabinDecisionError("缺少 choice", 400)

    // 幂等：同一 askId 只认第一条。先查账本 —— 镜像卡可能已过期/被清理，
    // 但账本里的决定仍然是权威答案。
    const existing = this.recordForAsk(cabinId, askId)
    if (existing) return { record: existing, already: true }

    const card = this.findAskCard(cabinId, askId)
    if (!card) {
      // 没有镜像卡的原生提问：汐音主对话自己问的（requestAuthorAskCard 只覆盖
      // 任务/委派作者），或镜像卡已被清理的旧载。derive 侧会用最小信封把这类
      // 提问列进「等你答」，所以提交必须同样认得它 —— 否则 inbox 里点了就报
      // 「还不在决策端点」（2026-11-20 用户 #17）。
      const native = this.findNativeAsk(cabinId, askId)
      if (native) return this.submitNativeAsk(cabinId, native, input, choice)
      throw new CabinDecisionError(
        `ask ${askId} 不在本舱主对话里（可能已过期，或不属于这个舱）`,
        404,
        { askId },
      )
    }
    const payload = card.payload
    const subject = payload.subject
      ?? { kind: "task" as const, id: payload.taskId ?? "" }
    if (!subject.id) throw new CabinDecisionError(`ask ${askId} 缺少 subject/taskId`, 409, { askId })

    // 票据一致性：调用方给了 taskId 就必须与卡片一致。
    if (input.taskId && subject.kind === "task" && input.taskId !== subject.id) {
      throw new CabinDecisionError(
        `ask ${askId} 属于 ${subject.kind}:${subject.id}，不是 ${input.taskId}`,
        409,
        this.mapping(cabinId, askId, payload, subject),
      )
    }

    // choice 逐字命中 options（卡片没带 options 的旧数据放宽：非空即可）。
    // 「Other / 自由文本」是显式的例外路径（source=composer）：它不是选项选择，
    // 不该被选项集合卡死；选项卡的正常点选仍要逐字命中。
    const labels = this.optionLabels(payload)
    const freeText = input.source === "composer"
    if (!freeText && labels.length > 0 && !labels.includes(choice)) {
      throw new CabinDecisionError(
        `「${choice}」不在 ${payload.handle ?? "该卡"} 的可选范围内`,
        400,
        this.mapping(cabinId, askId, payload, subject),
      )
    }

    // 幂等已在入口处按账本判过（镜像卡不一定还在）。

    const record: DecisionRecord = {
      decisionId: `d-${randomUUID().slice(0, 8)}`,
      askId,
      subject,
      handle: payload.handle ?? "#?",
      taskName: payload.taskName ?? this.subjectTitle(subject) ?? "任务",
      choice,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      source: input.source ?? "card",
      focusAtSubmit: input.focusAtSubmit ?? null,
      submittedAt: now(),
      stage: "decided",
    }

    // 诊断：focusAtSubmit 与 askId 不一致不报错，只留痕（归错责任在提交体）。
    if (record.focusAtSubmit && record.focusAtSubmit !== askId) {
      console.warn(
        `[CabinDecision] focus/ask mismatch at submit: focus=${record.focusAtSubmit} ask=${askId} (票据为准)`,
      )
    }

    this.appendDecisionEvent(cabinId, record, "decided")
    try { this.deps.service.notifyViewChanged(cabinId) } catch { /* view hook optional */ }

    // 卡片立刻只读：把 decision 写回镜像卡 metadata（前端 100ms 内可见）。
    this.writeMirrorDecision(card.messageId, record)
    // 作者线程里的**原卡**也写一笔：任务线程 / 对话悬浮条只看自己会话的
    // metadata，镜像卡置灰管不到那边 —— 不写的话同一张提问会在别处还挂着。
    this.writeOriginalAskDecision(card.payload, record)

    // 结构化用户消息（§7.1）：助理回合看到的第一手材料。
    await this.injectDecisionMessage(cabinId, record)

    this.armWatchdog(cabinId, record)
    return { record, already: false }
  }

  /** 原生提问就地作答：答案落回提问所在会话（主对话的就是它自己），
   *  账本照记、消息 metadata 写 decision（attention 立刻消项）。 */
  private async submitNativeAsk(
    cabinId: string,
    native: { id: string; sessionId: string; isMain: boolean },
    input: SubmitDecisionInput,
    choice: string,
  ): Promise<{ record: DecisionRecord; already: boolean }> {
    const prev = this.readAskDecision(native.id)
    if (prev) {
      return {
        record: {
          decisionId: `d-answered-${native.id.slice(0, 8)}`,
          askId: native.id,
          subject: { kind: "task", id: native.id },
          handle: "#?",
          taskName: this.nativeAskLabel(native),
          choice: prev.label ?? choice,
          source: input.source ?? "card",
          submittedAt: now(),
          stage: "decided",
        },
        already: true,
      }
    }

    const main = this.mainSession(cabinId)
    const record: DecisionRecord = {
      decisionId: `d-${randomUUID().slice(0, 8)}`,
      askId: native.id,
      // 原生提问没有任务/委派主体：审计分区用 askId 自身（委派同款做法）。
      subject: { kind: "task", id: native.id },
      handle: "#?",
      taskName: this.nativeAskLabel(native),
      choice,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      source: input.source ?? "card",
      focusAtSubmit: input.focusAtSubmit ?? null,
      submittedAt: now(),
      stage: "decided",
    }

    this.writeAskDecision(native.id, record)
    this.appendDecisionEvent(cabinId, record, "decided")
    try { this.deps.service.notifyViewChanged(cabinId) } catch { /* view hook optional */ }

    if (native.isMain) {
      // 提问者就是主对话：结构化消息 + 唤醒同一套（不给自己再转发一轮）。
      await this.injectDecisionMessage(cabinId, record)
    } else {
      const delivered = await this.postTurn(native.sessionId, main.org, this.decisionMessageText(record))
      if (delivered.ok) this.appendDecisionEvent(cabinId, record, "relayed", { channel: "fallback" })
    }
    return { record, already: false }
  }

  private nativeAskLabel(native: { isMain: boolean }): string {
    return native.isMain ? "舱主对话" : "任务线程"
  }

  /**
   * 用户 #20：「还需讨论」—— 不作答，先请提问的 agent 把选项讲清楚。
   *
   * 语义（对齐 Claude Code 的 Chat about this）：提问**仍然待答**，不写决策账本；
   * 只把一段讨论请求送进提问所在会话（主对话 → 落库 + 唤醒；任务线程 → 直发）。
   * agent 解释完再请人选择，人在对话里接着输入。
   */
  async discussAsk(cabinId: string, input: { askId: string; note?: string }): Promise<{
    ok: true
    target: "main" | "thread"
    delivered: boolean
    receipt: string
  }> {
    const askId = input.askId?.trim()
    if (!askId) throw new CabinDecisionError("缺少 askId", 400)
    const main = this.mainSession(cabinId)
    const answered = this.recordForAsk(cabinId, askId)
    if (answered) {
      throw new CabinDecisionError(`这条提问已经答过了（${answered.choice}）`, 409)
    }

    const card = this.findAskCard(cabinId, askId)
    const native = card ? null : this.findNativeAsk(cabinId, askId)
    if (!card && !native) {
      throw new CabinDecisionError(`ask ${askId} 不在本舱里（可能已过期，或不属于这个舱）`, 404)
    }

    const questions = card ? (card.payload.questions ?? null) : this.questionsOfMessage(native!.id)
    const first = firstAskQuestion(questions)
    const decision = card?.payload.decision
      ?? (typeof first?.question === "string" ? first.question : "")
    const labels = card ? this.optionLabels(card.payload) : askOptionLabels(questions)
    const authorSessionId = card?.payload.authorSessionId ?? native?.sessionId ?? ""
    if (!authorSessionId) throw new CabinDecisionError("这条提问没有可送达的作者线程", 409)
    const target: "main" | "thread" = authorSessionId === main.sessionId ? "main" : "thread"
    const handle = card?.payload.handle ?? "#?"
    const taskName = card?.payload.taskName
      ?? this.nativeAskLabel({ isMain: target === "main" })

    const content = [
      `[讨论 · ${handle} ${taskName} · ${askId}] 用户想先讨论，暂不选择`,
      ...(decision ? [`（问题）${decision}`] : []),
      ...(labels.length > 0 ? [`（选项）${labels.join(" / ")}`] : []),
      ...(input.note?.trim() ? [`（用户说明）${input.note.trim()}`] : []),
      "",
      "请先把这几个选项分别是什么意思、影响与取舍讲清楚；缺关键信息就指出需要用户补充什么。",
      "说明完再请用户做选择（重新 AskUserQuestion，或让用户直接回复都可以）。用户会接着输入。",
    ].join("\n")

    let delivered = false
    if (target === "main") {
      // 落库 + 唤醒（与决策消息同一条路，但**没有** decisionTicket —— 提问仍未答）。
      const ts = now()
      try {
        this.db().prepare(
          "INSERT INTO messages (id, session_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          randomUUID(), main.sessionId, "user", content,
          JSON.stringify({ cabinDiscuss: { askId } }), ts,
        )
        this.db().prepare("UPDATE sessions SET last_message_at = ?, updated_at = ? WHERE id = ?")
          .run(ts, ts, main.sessionId)
        this.deps.onAppend?.(main.sessionId, main.workspaceId)
      } catch (err) {
        console.warn("[CabinDecision] discuss message insert failed:", err instanceof Error ? err.message : String(err))
      }
      delivered = (await this.postTurn(main.sessionId, main.org, content)).ok
    } else {
      delivered = (await this.postTurn(authorSessionId, main.org, content)).ok
    }
    try { this.deps.service.notifyViewChanged(cabinId) } catch { /* view hook optional */ }

    return {
      ok: true,
      target,
      delivered,
      receipt: delivered
        ? (target === "main"
          ? "已请汐音先把这几个选项讲清楚 —— 到对话里继续"
          : `已请${taskName}先把这几个选项讲清楚 —— 切到「${taskName}」线程继续`)
        : "讨论请求已记下，对方忙完这一轮就会看到",
    }
  }

  /** 原生提问行里的 questions（tool_calls → AskUserQuestion.input.questions）。 */
  private questionsOfMessage(messageId: string): unknown {
    try {
      const row = this.db().prepare("SELECT tool_calls FROM messages WHERE id = ?")
        .get(messageId) as { tool_calls?: string | null } | undefined
      if (!row?.tool_calls) return null
      const parsed = JSON.parse(row.tool_calls) as unknown
      const list = Array.isArray(parsed)
        ? parsed
        : (parsed as { tool_calls?: unknown } | null)?.tool_calls
      if (!Array.isArray(list)) return null
      for (const entry of list) {
        const tc = entry as { name?: unknown; input?: unknown; result?: unknown } | null
        if (tc?.name !== "AskUserQuestion") continue
        const questions = ((tc.input ?? tc.result) as { questions?: unknown } | null)?.questions
        return Array.isArray(questions) ? questions : null
      }
      return null
    } catch {
      return null
    }
  }

  /** 原生提问行上已写的 decision（幂等 / already 回执用）。 */
  private readAskDecision(askId: string): { label?: string } | null {
    try {
      const row = this.db().prepare("SELECT metadata FROM messages WHERE id = ?")
        .get(askId) as { metadata?: string | null } | undefined
      if (!row?.metadata) return null
      const meta = JSON.parse(row.metadata) as { activity?: { decision?: unknown } }
      const d = meta.activity?.decision
      return d && typeof d === "object" ? d as { label?: string } : null
    } catch {
      return null
    }
  }

  /** 把 decision 写回提问消息（derive 的 attention 判据之一）。 */
  private writeAskDecision(askId: string, record: DecisionRecord): void {
    try {
      const row = this.db().prepare("SELECT metadata FROM messages WHERE id = ?")
        .get(askId) as { metadata?: string | null } | undefined
      if (!row) return
      let meta: Record<string, unknown> = {}
      try { meta = row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : {} } catch { meta = {} }
      const activity = (meta.activity && typeof meta.activity === "object")
        ? meta.activity as Record<string, unknown>
        : {}
      if (activity.decision) return
      activity.decision = {
        id: record.decisionId,
        label: record.choice,
        note: record.note ?? null,
        source: record.source,
        at: record.submittedAt,
      }
      meta.activity = activity
      this.db().prepare("UPDATE messages SET metadata = ? WHERE id = ?")
        .run(JSON.stringify(meta), askId)
    } catch { /* best effort：置灰失败不阻断决策 */ }
  }

  private optionLabels(payload: AskCardPayload): string[] {
    const fromPayload = Array.isArray(payload.options)
      ? payload.options.map((o) => (typeof o?.label === "string" ? o.label.trim() : "")).filter(Boolean)
      : []
    return fromPayload.length ? fromPayload : askOptionLabels(payload.questions)
  }

  private mapping(
    cabinId: string,
    askId: string,
    payload: AskCardPayload,
    subject: { kind: "task" | "delegation"; id: string },
  ): Record<string, unknown> {
    return {
      askId,
      subject,
      handle: payload.handle ?? null,
      title: payload.taskName ?? null,
      choices: this.optionLabels(payload),
      pending: this.pendingRelays(cabinId).map((d) => ({
        askId: d.askId, handle: d.handle, choice: d.choice,
      })),
    }
  }

  private subjectTitle(subject: { kind: string; id: string }): string | null {
    try {
      if (subject.kind === "task") {
        const row = this.db().prepare("SELECT name FROM tasks WHERE id = ?").get(subject.id) as { name?: string } | undefined
        return row?.name ?? null
      }
      const row = this.db().prepare("SELECT title FROM cabin_delegations WHERE id = ?").get(subject.id) as { title?: string } | undefined
      return row?.title ?? null
    } catch {
      return null
    }
  }

  private appendDecisionEvent(cabinId: string, record: DecisionRecord, stage: DecisionStage, extra: Record<string, unknown> = {}): void {
    const jobId = this.jobIdFor(cabinId, record.subject)
    this.deps.service.appendEvent(jobId, cabinId, "decision", "human", {
      stage,
      decisionId: record.decisionId,
      askId: record.askId,
      subject: record.subject,
      handle: record.handle,
      taskName: record.taskName,
      choice: record.choice,
      note: record.note ?? null,
      source: record.source,
      focusAtSubmit: record.focusAtSubmit ?? null,
      submittedAt: record.submittedAt,
      ...(stage !== "decided" ? { relayedAt: now() } : {}),
      ...extra,
    })
  }

  private jobIdFor(cabinId: string, subject: { kind: string; id: string }): string {
    if (subject.kind === "task") {
      const job = this.deps.cabin.findJobByRef(cabinId, subject.id)
      if (job) return job.id
    }
    // 委派没有 cabin_jobs 行：审计序列用实体自身 id 作分区键（表无 FK）。
    return subject.id
  }

  private writeMirrorDecision(messageId: string, record: DecisionRecord): void {
    try {
      const row = this.db().prepare("SELECT metadata FROM messages WHERE id = ?")
        .get(messageId) as { metadata?: string | null } | undefined
      if (!row?.metadata) return
      const meta = JSON.parse(row.metadata) as Record<string, unknown>
      const activity = meta.activity as Record<string, unknown> | undefined
      if (!activity) return
      activity.decision = {
        id: record.decisionId,
        label: record.choice,
        note: record.note ?? null,
        source: record.source,
        at: record.submittedAt,
      }
      meta.activity = activity
      this.db().prepare("UPDATE messages SET metadata = ? WHERE id = ?")
        .run(JSON.stringify(meta), messageId)
    } catch { /* best effort：卡片置灰失败不阻断决策 */ }
  }

  /** 作答本身是「跨会话事实」：作者线程的原卡也写 activity.decision。
   *
   *  cockpit 的决策卡只改主会话镜像卡；任务线程里的原卡若不同步，会同时出现
   *  「决策记录已答」和「对话悬浮条还挂着这张提问」两种真相（2026-11-16 用户
   *  反馈：同一个任务反复累加）。原卡 id 就是 askId（chat-routes 的契约）。 */
  private writeOriginalAskDecision(payload: AskCardPayload, record: DecisionRecord): void {
    const authorSessionId = payload.authorSessionId
    if (!authorSessionId) return
    const askId = payload.askMessageId
    if (!askId) return
    try {
      const row = this.db().prepare(
        "SELECT id, metadata FROM messages WHERE id = ? AND session_id = ?",
      ).get(askId, authorSessionId) as { id: string; metadata?: string | null } | undefined
      if (!row) return
      let meta: Record<string, unknown> = {}
      try { meta = row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : {} } catch { meta = {} }
      const activity = (meta.activity && typeof meta.activity === "object")
        ? meta.activity as Record<string, unknown>
        : {}
      if (activity.decision) return
      activity.decision = {
        id: record.decisionId,
        label: record.choice,
        note: record.note ?? null,
        source: record.source,
        at: record.submittedAt,
      }
      meta.activity = activity
      this.db().prepare("UPDATE messages SET metadata = ? WHERE id = ?")
        .run(JSON.stringify(meta), row.id)
    } catch { /* best effort */ }
  }

  /** `[决策 · #1 支付回调 · ask_7f3a] 短信` 结构化用户消息。 */
  private decisionMessageText(record: DecisionRecord): string {
    return [
      `[决策 · ${record.handle} ${record.taskName} · ${record.askId}] ${record.choice}`,
      `（逐字）${record.choice}`,
      ...(record.note ? [`（补充）${record.note}`] : []),
    ].join("\n")
  }

  private async injectDecisionMessage(cabinId: string, record: DecisionRecord): Promise<void> {
    const main = this.mainSession(cabinId)
    const content = this.decisionMessageText(record)
    const ts = now()
    try {
      this.db().prepare(
        "INSERT INTO messages (id, session_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        randomUUID(), main.sessionId, "user", content,
        JSON.stringify({ decisionTicket: record }), ts,
      )
      this.db().prepare("UPDATE sessions SET last_message_at = ?, updated_at = ? WHERE id = ?")
        .run(ts, ts, main.sessionId)
      this.deps.onAppend?.(main.sessionId, main.workspaceId)
    } catch (err) {
      console.warn("[CabinDecision] decision message insert failed:", err instanceof Error ? err.message : String(err))
    }
    // 唤醒汐音。ephemeral：消息已落库，这一轮只是让它「现在就看见」，
    // 不再重复插一条。忙（409）也不丢 —— 下个回合会从转录里看到。
    void this.postTurn(main.sessionId, main.org, content)
  }

  /**
   * 送进一个会话一轮。只等「已被受理」的信号（首块或被拒），不等整轮跑完 ——
   * 否则提交决策会卡在 doer 的整段生成上（design 25 §5.6 第 5 步要求提交即回执）。
   */
  private async postTurn(sessionId: string, org: string, message: string): Promise<{ ok: boolean; status: number }> {
    if (process.env.OCTOPUS_CHAT_AUTO_WAKE === "0") return { ok: false, status: 0 }
    const port = process.env.PORT ?? "3001"
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer agent", "X-Octopus-Org": org },
        body: JSON.stringify({ message, wake: true, ephemeral: true }),
      })
      if (!response.ok) return { ok: false, status: response.status }
      if (!response.body) return { ok: true, status: response.status }
      const reader = response.body.getReader()
      const firstRead = reader.read().catch(() => ({ done: true as const, value: undefined }))
      await Promise.race([
        firstRead,
        new Promise((resolve) => setTimeout(resolve, 4_000)),
      ])
      // 受理后把剩余流读掉（不阻塞提交）；只读一次 reader，避免并发 read。
      void (async () => {
        try {
          const first = await firstRead
          if (first.done) return
          for (;;) { const { done } = await reader.read(); if (done) break }
        } catch { /* 受理后的读失败不影响送达 */ }
      })()
      return { ok: true, status: response.status }
    } catch (err) {
      if (process.env.NODE_ENV !== "test") {
        console.warn(`[CabinDecision] wake failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return { ok: false, status: 0 }
    }
  }

  // ── 转达（汐音主路径）────────────────────────────────────────────

  /**
   * `cabin_relay_decision` 的服务端实现。硬校验三件事（§7.1）：
   *   1. askId 存在且状态是 decided（或已转达 → 幂等返回）；
   *   2. 卡片 subject 与调用方一致；
   *   3. 传入的 choice 必须与用户逐字选择一致（允许只补 framing）。
   */
  async relayDecision(cabinId: string, input: {
    askId: string
    choice?: string
    subject?: { kind: "task" | "delegation"; id: string }
    framing?: string
    actor?: string
  }): Promise<{ record: DecisionRecord; already: boolean; delivered: boolean }> {
    const askId = input.askId?.trim()
    if (!askId) throw new CabinDecisionError("缺少 askId", 400)
    const record = this.recordForAsk(cabinId, askId)
    if (!record) {
      throw new CabinDecisionError(
        `ask ${askId} 还没有人的决定 —— 先在主对话提交决策，再转达`,
        409,
        { askId, pending: this.pendingRelays(cabinId).map((d) => d.askId) },
      )
    }
    if (record.stage !== "decided") return { record, already: true, delivered: true }
    if (input.choice && input.choice.trim() !== record.choice) {
      throw new CabinDecisionError(
        `choice 与用户逐字选择不一致：用户选的是「${record.choice}」，不是「${input.choice}」。请原样转达。`,
        400,
        { askId, choice: record.choice },
      )
    }
    if (input.subject && input.subject.id !== record.subject.id) {
      throw new CabinDecisionError(
        `ask ${askId} 属于 ${record.subject.kind}:${record.subject.id}（${record.handle}），不是 ${input.subject.id}`,
        409,
        { askId, subject: record.subject },
      )
    }

    const card = this.findAskCard(cabinId, askId)
    const { content, delivered } = await this.deliverToDoer(cabinId, record, card?.payload, "assistant", input.framing)

    this.appendDecisionEvent(cabinId, record, delivered ? "relayed" : "decided", {
      channel: "assistant", framing: input.framing ?? null, delivered,
    })
    if (delivered) {
      this.clearWatchdog(askId)
      this.appendReceipt(cabinId, record, "assistant")
      try { this.deps.service.notifyViewChanged(cabinId) } catch { /* view hook optional */ }
      if (record.subject.kind === "delegation") {
        try { this.deps.onDelegationRelayed?.(record.subject.id) } catch { /* best effort */ }
      }
    }
    return { record, already: false, delivered }
  }

  private async deliverToDoer(
    cabinId: string,
    record: DecisionRecord,
    payload: AskCardPayload | undefined,
    channel: "assistant" | "fallback",
    framing?: string,
  ): Promise<{ content: string; delivered: boolean }> {
    const authorSessionId = payload?.authorSessionId
    const content = channel === "assistant"
      ? formatRelayMessage({
        handle: record.handle, askId: record.askId, choice: record.choice,
        note: record.note, framing,
      })
      : [
        `用户回答了以下问题：${record.choice}`,
        `[决策 · ${record.handle} · ${record.askId}] ${record.choice}（机械转达：汐音未参与本轮）`,
        ...(record.note ? [`（补充）${record.note}`] : []),
      ].join("\n")
    if (!authorSessionId) {
      // 没有 doer 会话（历史卡 / 委派未开会话）：只留消息，不假称送达。
      return { content, delivered: false }
    }
    const main = this.mainSession(cabinId)
    const delays = [0, 2_000, 5_000]
    for (const delay of delays) {
      if (delay) await new Promise((r) => setTimeout(r, delay))
      const res = await this.postTurn(authorSessionId, main.org, content)
      if (res.ok) return { content, delivered: true }
    }
    return { content, delivered: false }
  }

  private appendReceipt(cabinId: string, record: DecisionRecord, relayed: "assistant" | "fallback"): void {
    const main = this.mainSession(cabinId)
    const ts = now()
    try {
      this.db().prepare(
        "INSERT INTO messages (id, session_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        randomUUID(), main.sessionId, "user",
        formatReceiptLine({
          handle: record.handle, title: record.taskName,
          choice: record.choice, relayed,
        }),
        JSON.stringify({
          displayType: "event",
          activity: {
            kind: "cabin.decision_receipt",
            severity: "info",
            title: "决策已转达",
            workspaceId: main.workspaceId,
            taskId: record.subject.kind === "task" ? record.subject.id : null,
            status: "ok",
            payload: {
              decisionReceipt: {
                decisionId: record.decisionId,
                askId: record.askId,
                subject: record.subject,
                handle: record.handle,
                taskName: record.taskName,
                choice: record.choice,
                relayed,
                at: ts,
              },
            },
          },
        }),
        ts,
      )
      this.db().prepare("UPDATE sessions SET last_message_at = ?, updated_at = ? WHERE id = ?")
        .run(ts, ts, main.sessionId)
      this.deps.onAppend?.(main.sessionId, main.workspaceId)
    } catch (err) {
      console.warn("[CabinDecision] receipt insert failed:", err instanceof Error ? err.message : String(err))
    }
  }

  // ── watchdog：20s 未转达 → 机械转发 ─────────────────────────────

  private armWatchdog(cabinId: string, record: DecisionRecord): void {
    this.clearWatchdog(record.askId)
    const ms = this.deps.watchdogMs ?? DEFAULT_WATCHDOG_MS
    const timer = setTimeout(() => {
      void this.onWatchdog(cabinId, record.askId)
    }, ms)
    // 测试 / 进程退出不因 watchdog 挂住
    if (typeof timer === "object" && "unref" in timer) timer.unref()
    this.timers.set(record.askId, timer)
  }

  private clearWatchdog(askId: string): void {
    const timer = this.timers.get(askId)
    if (timer) clearTimeout(timer)
    this.timers.delete(askId)
    this.extensions.delete(askId)
  }

  private async onWatchdog(cabinId: string, askId: string): Promise<void> {
    this.timers.delete(askId)
    const record = this.recordForAsk(cabinId, askId)
    if (!record || record.stage !== "decided") return

    // 主会话还在流式：这一轮可能就是汐音在转达。延长，而不是抢跑。
    const main = this.mainSession(cabinId)
    const busy = this.deps.isBusy ? this.deps.isBusy(main.sessionId) : isStreamActive(main.sessionId)
    const extended = this.extensions.get(askId) ?? 0
    if (busy && extended < MAX_WATCHDOG_EXTENSIONS) {
      this.extensions.set(askId, extended + 1)
      const timer = setTimeout(() => { void this.onWatchdog(cabinId, askId) }, this.deps.watchdogMs ?? DEFAULT_WATCHDOG_MS)
      if (typeof timer === "object" && "unref" in timer) timer.unref()
      this.timers.set(askId, timer)
      return
    }

    await this.fallbackRelay(cabinId, askId)
  }

  /** 机械转发（watchdog 分支）。绝不丢答案。 */
  async fallbackRelay(cabinId: string, askId: string): Promise<DecisionRecord | null> {
    const record = this.recordForAsk(cabinId, askId)
    if (!record || record.stage !== "decided") return record
    const card = this.findAskCard(cabinId, askId)
    const { delivered } = await this.deliverToDoer(cabinId, record, card?.payload, "fallback")
    if (delivered) {
      this.appendDecisionEvent(cabinId, record, "fallback_relayed", { channel: "fallback" })
      this.appendReceipt(cabinId, record, "fallback")
      if (record.subject.kind === "delegation") {
        try { this.deps.onDelegationRelayed?.(record.subject.id) } catch { /* best effort */ }
      }
    }
    return record
  }

  /** 任务 / 委派结束时收口该主体名下的提问（v22 #9：此前没有任何调用方，
   *  已答未转达的卡与没人答的卡都会一直挂在「待你定」里）。
   *   · 已答未转达 → 账本 expired（答案不丢，只是不再催汐音转达）；
   *   · 作者线程里没人答的镜像卡 → activity.decision = 已结束 —— 派生的
   *     attention / 提示队列随即不再列出。 */
  expireForSubject(cabinId: string, subjectId: string): void {
    for (const record of this.pendingRelays(cabinId)) {
      if (record.subject.id !== subjectId) continue
      this.appendDecisionEvent(cabinId, record, "expired", { reason: "subject-ended" })
      this.clearWatchdog(record.askId)
      const card = this.findAskCard(cabinId, record.askId)
      if (card) {
        try {
          const row = this.db().prepare("SELECT metadata FROM messages WHERE id = ?")
            .get(card.messageId) as { metadata?: string | null } | undefined
          if (!row?.metadata) continue
          const meta = JSON.parse(row.metadata) as Record<string, unknown>
          const activity = meta.activity as Record<string, unknown> | undefined
          if (activity) {
            activity.decision = { id: "expired", label: "任务已结束", at: now() }
            meta.activity = activity
            this.db().prepare("UPDATE messages SET metadata = ? WHERE id = ?")
              .run(JSON.stringify(meta), card.messageId)
          }
        } catch { /* best effort */ }
      }
    }

    // 未答的镜像卡：主体已经结束，问题不再等人 —— 置灰，别留在「待你定」。
    let main: { sessionId: string; workspaceId: string | null }
    try { main = this.mainSession(cabinId) } catch { return }
    let expiredCards = 0
    try {
      const rows = this.db().prepare(
        `SELECT id, metadata FROM messages
          WHERE session_id = ? AND metadata LIKE '%"authorAsk":true%'
          ORDER BY created_at DESC, rowid DESC LIMIT 200`,
      ).all(main.sessionId) as Array<{ id: string; metadata: string | null }>
      const update = this.db().prepare("UPDATE messages SET metadata = ? WHERE id = ?")
      for (const row of rows) {
        if (!row.metadata) continue
        let meta: Record<string, unknown>
        try { meta = JSON.parse(row.metadata) as Record<string, unknown> } catch { continue }
        const activity = meta.activity as Record<string, unknown> | undefined
        const payload = activity?.payload as AskCardPayload | undefined
        if (!payload?.authorAsk) continue
        const subject = payload.subject
          ?? (payload.taskId ? { kind: "task" as const, id: payload.taskId } : null)
        if (!subject || subject.id !== subjectId) continue
        if (!activity || typeof activity !== "object" || activity.decision) continue
        activity.decision = { id: "expired", label: "已结束", at: now() }
        meta.activity = activity
        try {
          update.run(JSON.stringify(meta), row.id)
          expiredCards += 1
        } catch { /* best effort */ }
      }
    } catch { /* old DB — best effort */ }
    if (expiredCards > 0) {
      this.deps.onAppend?.(main.sessionId, main.workspaceId)
      try { this.deps.service.notifyViewChanged(cabinId) } catch { /* view hook optional */ }
    }
  }

  /** 供工具 / 路由展示：按 askId 的公开状态。 */
  stateOf(cabinId: string, askId: string): DecisionStage | null {
    return this.recordForAsk(cabinId, askId)?.stage ?? null
  }
}
