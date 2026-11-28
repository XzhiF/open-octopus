import { z } from "zod"

// ── Cabin (directory-bound long-lived cockpit) ──
// Shared DTOs. Persisted shape lives in server db/types.ts; derived views
// (attention/health) are computed by deriveCabinView (K3: never stored).

export const CabinStatusSchema = z.enum(["draft", "initializing", "active", "dormant", "archived"])
export type CabinStatus = z.infer<typeof CabinStatusSchema>

/** 作业种类。任务 / 工作流 / 子代理三种自有实体。
 *  会话不在这里 —— 用户在舱里自己开的会话与汐音的委派同一本账（cabin_delegations）。 */
export const CabinJobKindSchema = z.enum(["task", "workflow", "subagent"])
export type CabinJobKind = z.infer<typeof CabinJobKindSchema>

/** `brief` / `decision` 是 design 25 加的两类审计事件（追加，不改旧值）。 */
export const CabinJobEventKindSchema = z.enum([
  "dispatch", "report", "attention", "handback", "human_input", "resume",
  "brief", "decision", "note",
])
export type CabinJobEventKind = z.infer<typeof CabinJobEventKindSchema>

export const CabinAutonomySchema = z.enum(["off", "observe", "auto"])
export type CabinAutonomy = z.infer<typeof CabinAutonomySchema>

/** 托管档位（design 24 §10.3 / 25 §6.1）：每步问 / 关键点停 / 全权。 */
export const CabinAutonomyTierSchema = z.enum(["approve", "checkpoint", "hands-off"])
export type CabinAutonomyTier = z.infer<typeof CabinAutonomyTierSchema>

/** 意图编译产物（design 25 §6.1）。原文永远另存，不就地被改写（I4）。 */
export const CabinBriefSchema = z.object({
  goal: z.string(),
  done_when: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  non_goals: z.array(z.string()).default([]),
  refs: z.array(z.string()).default([]),
  autonomy: CabinAutonomyTierSchema.default("checkpoint"),
  decide_by: z.enum(["human-in-loop", "orchestrator"]).default("human-in-loop"),
})
export type CabinBrief = z.infer<typeof CabinBriefSchema>

/** 代理发言（design 25 §2）：doer 侧每条 user 消息都要能回答「谁说的 / 根据什么」。 */
export const ProxyTurnSchema = z.object({
  by: z.enum(["principal", "orchestrator"]),
  sessionId: z.string(),
  basis: z.string().nullable().default(null),
  /** verbatim = 逐字转达的选择；brief = 编译后的意图；note = 补充说明。 */
  kind: z.enum(["verbatim", "brief", "note", "receipt"]).default("note"),
})
export type ProxyTurn = z.infer<typeof ProxyTurnSchema>

/** 决策状态机（design 25 §7）。状态不落表，由 job event + 消息派生。 */
export const CabinDecisionStateSchema = z.enum([
  "asked", "shown", "decided", "relayed", "acked", "fallback_relayed", "expired",
])
export type CabinDecisionState = z.infer<typeof CabinDecisionStateSchema>

/** 提交票据（design 25 §7.1）：askId 是唯一权威，focusAtSubmit 只做诊断。 */
export const CabinDecisionTicketSchema = z.object({
  decisionId: z.string(),
  askId: z.string(),
  subject: z.object({
    kind: z.enum(["task", "delegation"]),
    id: z.string(),
  }),
  handle: z.string(),
  choice: z.string(),
  note: z.string().optional(),
  source: z.enum(["card", "composer", "thread_fallback"]).default("card"),
  focusAtSubmit: z.string().nullable().optional(),
  submittedAt: z.string(),
})
export type CabinDecisionTicket = z.infer<typeof CabinDecisionTicketSchema>

/** 独立委派（design 25 §4.2）：不是任务，没有 phase / worktree / 验收。
 *  会话有归档闸（2026-11-25 用户）：state=done 是「活跃」（交完结论、仍可交互），
 *  archived_at 有值才是「已归档」。 */
export const CabinDelegationStateSchema = z.enum([
  "queued", "running", "waiting_input", "done", "failed", "cancelled",
])
export type CabinDelegationState = z.infer<typeof CabinDelegationStateSchema>

/** 会话创建者（2026-11-27 用户）：同一种会话，只差谁开的。
 *  xiyin = 汐音委派（等你答 / 交结论 / 完成回执）；user = 人在编队里自己开的会话
 *  （回合结束落「待命」，不产待办、不发回执）。 */
export const CabinDelegationOriginSchema = z.enum(["xiyin", "user"])
export type CabinDelegationOrigin = z.infer<typeof CabinDelegationOriginSchema>

export const CabinDelegationSchema = z.object({
  id: z.string(),
  cabin_id: z.string(),
  origin: CabinDelegationOriginSchema.default("xiyin"),
  title: z.string(),
  intent_text: z.string(),
  brief: z.string().nullable(),
  autonomy: CabinAutonomyTierSchema,
  state: CabinDelegationStateSchema,
  doer_session_id: z.string().nullable(),
  result_summary: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  ended_at: z.string().nullable(),
  /** 归档时间；null = 未归档。老调用方可以不带。 */
  archived_at: z.string().nullable().optional(),
})
export type CabinDelegationDTO = z.infer<typeof CabinDelegationSchema>

/** 工作实体（design 25 §4.2）：读侧把 task 与 delegation 归一成同一种行。 */
export const CabinWorkKindSchema = z.enum(["task", "delegation"])
export type CabinWorkKind = z.infer<typeof CabinWorkKindSchema>

export interface CabinWorkRow {
  /** 工作实体 id（task id / delegation id）。 */
  id: string
  kind: CabinWorkKind
  /** `#1` / `D1` —— 给人指代用，由列表顺序派生，不落库。 */
  handle: string
  /** 仅 delegation 有：谁开的会话（xiyin 委派 / user 自开）。 */
  origin?: CabinDelegationOrigin
  /** 0..5，由 id hash 派生（与 pop 色板同族）。 */
  color: number
  title: string
  status: string
  session_id: string | null
  /** 底层 job id（delegation 无 job 时为自身 id）。 */
  job_id: string
}

/** 句柄序号：按列表顺序（= 创建顺序）分配。 */
export function cabinHandleFor(kind: CabinWorkKind, ordinal: number): string {
  return kind === "delegation" ? `D${ordinal}` : `#${ordinal}`
}

/** 颜色 = hash(id) % 6。前后端同一个纯函数，保证同一任务处处同色。 */
export function cabinHandleColor(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) % 6
}

/** 从任意较长文本里挑出 handle（`#12` / `D3`）——供自由文本改作用域用。 */
export function parseCabinHandle(text: string): { kind: CabinWorkKind; ordinal: number } | null {
  const m = /(^|\s)([#D])(\d{1,3})(?=\s|$|[:：,，.。])/.exec(text.trim())
  if (!m) return null
  return { kind: m[2] === "D" ? "delegation" : "task", ordinal: Number(m[3]) }
}

/** Immutable authorization recorded per dispatch (C5).
 *
 *  `clarify` is the spec-conversation knob added with the chat closed-loop
 *  (design 23): `explicit` authorizes CREATING/running the task, it does NOT
 *  authorize skipping the author's requirement Q&A. `ask` (default) = the
 *  task-author must ask the human about anything that affects acceptance /
 *  scope / priority; `auto` = the user explicitly said "你看着办/直接做", so
 *  the author may enqueue without asking when the brief is unambiguous. */
export const CabinMandateSchema = z.object({
  strength: z.enum(["explicit", "inferred"]),
  scope: z.string().optional(),
  basis: z.string().optional(),
  policyVersion: z.number().optional(),
  clarify: z.enum(["ask", "auto"]).optional(),
})
export type CabinMandate = z.infer<typeof CabinMandateSchema>

export const CabinSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  workspace_id: z.string().nullable(),
  main_session_id: z.string().nullable(),
  requirements: z.string(),
  status: CabinStatusSchema,
  mainline_strategy: z.string(),
  org: z.string().nullable(),
  version: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  last_active_at: z.string().nullable(),
  archived_at: z.string().nullable(),
})
export type CabinDTO = z.infer<typeof CabinSchema>

export const CabinJobSchema = z.object({
  id: z.string(),
  cabin_id: z.string(),
  kind: CabinJobKindSchema,
  ref_id: z.string().nullable(),
  session_id: z.string().nullable(),
  title: z.string(),
  mandate: CabinMandateSchema.nullable(),
  prompt: z.string().nullable(),
  created_at: z.string(),
  ended_at: z.string().nullable(),
  /** Derived from the underlying entity (task/execution/subagent), not stored. */
  status: z.string().optional(),
})
export type CabinJob = z.infer<typeof CabinJobSchema>

export const CabinJobEventSchema = z.object({
  id: z.string(),
  job_id: z.string(),
  cabin_id: z.string(),
  kind: CabinJobEventKindSchema,
  actor: z.string().nullable(),
  payload: z.record(z.unknown()).nullable(),
  created_at: z.string(),
})
export type CabinJobEvent = z.infer<typeof CabinJobEventSchema>

/**
 * 提问信封（design 26 §4.1）：`stage=answer` 的 attention 若带决策票据，就把
 * 「要定的事 / 选项 / 建议 / 原问题体」随 attention 一次带回 —— 前端不必再
 * 打开任务线程才能答。工作流执行提问没有 askId，不带本信封。
 */
export const CabinAskOptionSchema = z.object({
  label: z.string(),
  /** 选它意味着什么（design 24 信封字段）。 */
  impact: z.string().optional(),
  description: z.string().optional(),
})
export type CabinAskOption = z.infer<typeof CabinAskOptionSchema>

export const CabinAskEnvelopeSchema = z.object({
  /** 决策票据（= 镜像卡 payload.askMessageId）。 */
  ask_id: z.string(),
  /** 舱主会话镜像卡的 message.id（回执锚点）。 */
  message_id: z.string().optional(),
  /** 作者线程（旧服务端 / 无票据时的回退入口）。 */
  author_session_id: z.string().optional(),
  origin: z.enum(["session", "delegation", "workflow"]).optional(),
  /** 要定的事。 */
  decision: z.string().optional(),
  /** 人的原始要求（截断）。 */
  intent: z.string().optional(),
  options: z.array(CabinAskOptionSchema).max(12).optional(),
  recommendation: z.object({
    label: z.string().optional(),
    reason: z.string().optional(),
  }).optional(),
  blocking: z.boolean().optional(),
  phase: z.object({
    index: z.number().optional(),
    round: z.number().optional(),
  }).nullable().optional(),
  /** AskUserQuestion 原对象（`{ questions: [...] }`），直接喂现有卡组件。 */
  questions: z.unknown().optional(),
})
export type CabinAskEnvelope = z.infer<typeof CabinAskEnvelopeSchema>

/** One serial-inbox item (C4). awaiting = "whom it waits for" (superagent stage). */
export const CabinAttentionItemSchema = z.object({
  id: z.string(),
  job_id: z.string().nullable(),
  stage: z.enum(["review", "answer", "adjudicate", "approval", "blocked", "start", "notice"]),
  awaiting: z.enum(["person", "working", "idle", "ended"]),
  title: z.string(),
  question: z.string().optional(),
  detail: z.string().optional(),
  /** stage=start 的机器可读动作（2026-11-17）：
   *  `enqueue` = 任务还是 draft（可「立即开跑」或「先入列」）；
   *  `trigger` = 已 ready，待触发；`resume` = 已暂停，待恢复。
   *  前端靠它决定放行窗的按钮与 API，不再从标题后缀猜。 */
  start_kind: z.enum(["enqueue", "trigger", "resume"]).optional(),
  task_id: z.string().nullable(),
  repo: z.string().nullable(),
  wt: z.string().nullable(),
  deep_link: z.string().nullable(),
  /** design 25 §4.2：两种工作实体共用一套 attention。 */
  subject: z.object({
    kind: z.enum(["task", "delegation"]),
    id: z.string(),
  }).optional(),
  handle: z.string().optional(),
  color: z.number().optional(),
  /** design 26：可作答的提问（有决策票据时）附带完整信封。 */
  ask: CabinAskEnvelopeSchema.optional(),
})
export type CabinAttentionItem = z.infer<typeof CabinAttentionItemSchema>

export const CabinHealthSchema = z.object({
  running: z.number(),
  queued: z.number(),
  dormant: z.number(),
  workers: z.number(),
  max: z.number(),
})
export type CabinHealth = z.infer<typeof CabinHealthSchema>

/** Derived cockpit view (K3: computed, never persisted). */
export const CabinViewSchema = z.object({
  cabin: CabinSchema,
  attention: z.array(CabinAttentionItemSchema),
  health: CabinHealthSchema,
  open_findings: z.number(),
})
export type CabinView = z.infer<typeof CabinViewSchema>

/** Init gate cold-load snapshot (truth on disk .cabin/init-state.json). */
export const CabinInitItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  sub: z.string().optional(),
  state: z.enum(["pending", "running", "done", "failed"]),
  error: z.string().optional(),
  fix_hint: z.string().optional(),
  deep_link: z.string().optional(),
})
export type CabinInitItem = z.infer<typeof CabinInitItemSchema>
export const CabinInitStateSchema = z.object({
  items: z.array(CabinInitItemSchema),
})
export type CabinInitState = z.infer<typeof CabinInitStateSchema>

// ── 舱内事项（2026-11-24 用户）──────────────────────────────────────────
// 一条事项 = 随手记下的小优化 / 小修复 / 小想法。与「任务」不是一层：
// 任务是执行单位，事项是待办条目 —— 投递给主对话即 delivered，
// 主对话做完由人确认「完成 / 搁置」才关项（done / dropped）。记录保留，不硬删。
export const CabinItemKindSchema = z.enum(["optimize", "fix", "idea"])
export type CabinItemKind = z.infer<typeof CabinItemKindSchema>

export const CabinItemStatusSchema = z.enum(["todo", "delivered", "done", "dropped"])
export type CabinItemStatus = z.infer<typeof CabinItemStatusSchema>

export const CabinItemSchema = z.object({
  id: z.string(),
  cabin_id: z.string(),
  /** 舱内自增序号（#IT-12 的 12）；删除不回收。 */
  seq: z.number(),
  kind: CabinItemKindSchema,
  status: CabinItemStatusSchema,
  title: z.string(),
  body: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  delivered_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  /** 投递落点（主会话 + 那条 user message），排障 / 留痕用。 */
  delivery_session_id: z.string().nullable(),
  delivery_message_id: z.string().nullable(),
})
export type CabinItemDTO = z.infer<typeof CabinItemSchema>

// ── 事项投递的正文协议（2026-11-26 用户）───────────────────────────────
// 事故：#IT-1 标题只有 18 字、正文 1368 字，投递消息却只带了标题 —— 汐音
// 只能凭标题猜需求。**标题是索引，正文才是需求**。口径放在 shared：
// 客户端组装 / 服务端按库兜底 / 回执与工具共用同一份格式，不再各拼各的。

/** 单条正文最多随投递送多少字（超出显式截断，完整正文用 cabin_list_items 读）。 */
export const CABIN_ITEM_DELIVERY_BODY_MAX = 4000
/** 一次投递所有正文合计上限；超出同样显式标注，绝不静默丢。 */
export const CABIN_ITEM_DELIVERY_TOTAL_MAX = 12_000

export interface CabinItemDeliveryLimits {
  perBodyMax?: number
  totalMax?: number
}

const CABIN_ITEM_KIND_LABEL: Record<CabinItemKind, string> = {
  optimize: "优化", fix: "修复", idea: "想法",
}

export function cabinItemLabel(item: Pick<CabinItemDTO, "seq">): string {
  return `#IT-${item.seq}`
}

function deliveryLimits(limits: CabinItemDeliveryLimits): { perBodyMax: number; totalMax: number } {
  return {
    perBodyMax: Math.max(1, limits.perBodyMax ?? CABIN_ITEM_DELIVERY_BODY_MAX),
    totalMax: Math.max(1, limits.totalMax ?? CABIN_ITEM_DELIVERY_TOTAL_MAX),
  }
}

function clip(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length > max ? chars.slice(0, max).join("") : text
}

function charLen(text: string): number {
  return Array.from(text).length
}

function normalizeBody(body: string): string {
  return (body ?? "").replace(/\r\n/g, "\n").trim()
}

/** 逐条事项的投递块：标题做索引，正文逐字（超限显式截断并指路回读工具）。 */
export function formatCabinItemBlocks(
  items: ReadonlyArray<Pick<CabinItemDTO, "seq" | "title" | "body" | "kind">>,
  limits: CabinItemDeliveryLimits = {},
): string[] {
  const { perBodyMax, totalMax } = deliveryLimits(limits)
  /** 剩余额度小到这个数以下时宁可不送残句，只留指路标记。 */
  const minPartial = 200
  const blocks: string[] = []
  let used = 0

  for (const item of items) {
    const title = item.title.trim() || "（未命名事项）"
    const kind = CABIN_ITEM_KIND_LABEL[item.kind] ?? item.kind
    blocks.push(`### ${cabinItemLabel(item)} ${title}（${kind}）`)

    const body = normalizeBody(item.body)
    if (!body) continue
    const bodyChars = charLen(body)
    const remaining = Math.max(0, totalMax - used)
    if (remaining === 0 || (bodyChars > remaining && remaining < minPartial)) {
      blocks.push(
        `…（本条正文 ${bodyChars} 字未随本次投递送出：本次投递总长已达上限；`
        + `完整正文可用 cabin_list_items / cabin_get_item 读取。）`,
      )
      continue
    }

    let text = body
    const notes: string[] = []
    if (charLen(text) > perBodyMax) {
      text = clip(text, perBodyMax)
      notes.push(`正文共 ${bodyChars} 字，本次截断至 ${perBodyMax} 字`)
    }
    if (charLen(text) > remaining) {
      text = clip(text, remaining)
      notes.push(`本次投递总长上限 ${totalMax} 字，本条截断至 ${remaining} 字`)
    }
    used += charLen(text)
    blocks.push(text)
    if (notes.length > 0) {
      blocks.push(`…（${notes.join("；")}；完整正文可用 cabin_list_items / cabin_get_item 读取。）`)
    }
  }
  return blocks
}

/** 可直接发给主对话的投递消息（客户端两条投递路径共用）。 */
export function formatCabinItemDeliveryText(
  items: ReadonlyArray<Pick<CabinItemDTO, "seq" | "title" | "body" | "kind">>,
  limits: CabinItemDeliveryLimits = {},
): string {
  return ["处理这几条事项：", ...formatCabinItemBlocks(items, limits)].join("\n")
}

/**
 * 服务端兜底（2026-11-26 用户）：按数据库真源检查正文是否已在消息里。
 * 旧客户端 / 缓存过期只发了标题时，把缺的正文补在消息末尾；已有则原样返回。
 */
export function appendMissingCabinItemBodies(
  content: string,
  items: ReadonlyArray<Pick<CabinItemDTO, "id" | "seq" | "title" | "body" | "kind">>,
  limits: CabinItemDeliveryLimits = {},
): { content: string; appended: boolean; missing_ids: string[] } {
  const { perBodyMax } = deliveryLimits(limits)
  const normalized = content.replace(/\r\n/g, "\n")
  const missing = items.filter((item) => {
    const body = normalizeBody(item.body)
    if (!body) return false
    if (normalized.includes(body)) return false
    // 客户端超限截断过：只要前 160 字到了，就算本条已送达（截断原因已写在正文里）。
    const probe = clip(body, Math.min(perBodyMax, 160))
    return probe.length === 0 || !normalized.includes(probe)
  })
  if (missing.length === 0) return { content, appended: false, missing_ids: [] }
  const blocks = formatCabinItemBlocks(missing, limits)
  return {
    content: `${content}\n\n【事项正文 · 服务端按数据库补全】\n${blocks.join("\n")}`,
    appended: true,
    missing_ids: missing.map((item) => item.id),
  }
}