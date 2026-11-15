// packages/server/src/services/cabin/cabin-brief.ts
//
// design 25 §6.1 / design 24 §3：纯函数层。
//   · parseDecisionEnvelope —— 从作者正文里抽「决策：」「建议：」两行；
//   · buildBriefLines / formatDispatchMessage —— 派发两段式（意图编译 + 用户原文）；
//   · formatRelayMessage —— 决策转达（verbatim 块不可改，framing 只补边界）。
//
// 全是可单测的纯函数：没有 DAO / 时钟 / IO。

export interface AskQuestionLike {
  question?: unknown
  header?: unknown
  multiSelect?: unknown
  options?: unknown
}

export interface EnvelopeOption {
  label: string
  impact?: string
}

export interface ParsedDecisionEnvelope {
  decision?: string
  recommendation?: { label: string; reason: string }
  options: EnvelopeOption[]
}

function textOf(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

function firstLineMatching(text: string, label: string): string | undefined {
  const re = new RegExp(`^\\s*(?:[-*>#]+\\s*)?${label}\\s*[:：]\\s*(.*)$`, "m")
  const m = re.exec(text)
  if (!m) return undefined
  const value = m[1].trim()
  return value || undefined
}

/** 从 AskUserQuestion 的 questions（数组或 {questions:[]})取第一个问题。 */
export function firstAskQuestion(questions: unknown): AskQuestionLike | undefined {
  const list = Array.isArray(questions)
    ? questions
    : (questions as { questions?: unknown } | null)?.questions
  return Array.isArray(list) ? list[0] as AskQuestionLike : undefined
}

export function askOptionLabels(questions: unknown): string[] {
  const first = firstAskQuestion(questions)
  if (!Array.isArray(first?.options)) return []
  return first.options
    .map((o) => textOf((o as { label?: unknown })?.label))
    .filter(Boolean)
}

/**
 * 作者正文 → 信封富化字段。缺行就缺字段（不用默认值填 —— 空块会破坏降级）。
 * 建议行支持两种写法：
 *   `建议：短信 · 最薄，先验证通道`     （标签 · 理由）
 *   `建议：短信 —— 最薄，先验证通道`
 *   `建议：无（信息不足）`              （视为没有推荐）
 */
export function parseDecisionEnvelope(
  text: string,
  questions?: unknown,
): ParsedDecisionEnvelope {
  const decision = firstLineMatching(text, "决策")
  const rawRecommendation = firstLineMatching(text, "建议")
  let recommendation: ParsedDecisionEnvelope["recommendation"]
  if (rawRecommendation && !/^无(?:\s|$|（|\()/.test(rawRecommendation)) {
    const m = /^(.+?)\s*(?:[·—–-]{1,2}|:)\s*(.+)$/.exec(rawRecommendation)
    if (m) recommendation = { label: m[1].trim(), reason: m[2].trim() }
    else recommendation = { label: rawRecommendation, reason: "" }
  }

  const first = firstAskQuestion(questions)
  const options: EnvelopeOption[] = Array.isArray(first?.options)
    ? first.options.map((o) => {
      const opt = o as { label?: unknown; description?: unknown }
      return {
        label: textOf(opt.label),
        ...(textOf(opt.description) ? { impact: textOf(opt.description) } : {}),
      }
    }).filter((o) => o.label)
    : []

  return {
    ...(decision ? { decision } : {}),
    ...(recommendation ? { recommendation } : {}),
    options,
  }
}

export interface CabinBriefInput {
  goal: string
  done_when?: string[]
  constraints?: string[]
  non_goals?: string[]
  refs?: string[]
  autonomy?: "approve" | "checkpoint" | "hands-off"
  decide_by?: "human-in-loop" | "orchestrator"
}

export interface NormalizedBrief {
  goal: string
  done_when: string[]
  constraints: string[]
  non_goals: string[]
  refs: string[]
  autonomy: "approve" | "checkpoint" | "hands-off"
  decide_by: "human-in-loop" | "orchestrator"
}

export function normalizeBrief(input: CabinBriefInput | null | undefined): NormalizedBrief | null {
  if (!input) return null
  const goal = textOf(input.goal)
  if (!goal) return null
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(textOf).filter(Boolean).slice(0, 20) : []
  return {
    goal,
    done_when: arr(input.done_when),
    constraints: arr(input.constraints),
    non_goals: arr(input.non_goals),
    refs: arr(input.refs),
    autonomy: input.autonomy === "approve" || input.autonomy === "hands-off"
      ? input.autonomy
      : "checkpoint",
    decide_by: input.decide_by === "orchestrator" ? "orchestrator" : "human-in-loop",
  }
}

/** brief 的可读块（wake 消息与 job event 共用）。 */
export function briefLines(brief: NormalizedBrief): string {
  const bullet = (label: string, items: string[]): string[] =>
    items.length ? [`${label}：`, ...items.map((i) => `- ${i}`)] : []
  return [
    `goal：${brief.goal}`,
    ...bullet("done_when", brief.done_when),
    ...bullet("constraints", brief.constraints),
    ...bullet("non_goals", brief.non_goals),
    ...brief.refs.length ? [`refs：${brief.refs.join("、")}`] : [],
    `autonomy：${brief.autonomy} · decide_by：${brief.decide_by}`,
  ].join("\n")
}

/** 派发 wake 消息（design 25 §6.1）：意图编译 + 用户原文，两段分离（I4）。 */
export function formatDispatchMessage(input: {
  title: string
  mandateStrength: string
  clarify: string
  brief: NormalizedBrief | null
  original: string
  rules: string
}): string {
  return [
    `[汐音 · 代用户转达] 任务「${input.title}」`,
    `授权：mandate=${input.mandateStrength} · clarify=${input.clarify}` +
      (input.brief ? ` · autonomy=${input.brief.autonomy}` : ""),
    "",
    ...(input.brief
      ? ["## 意图（汐音编译，可执行）", briefLines(input.brief), ""]
      : []),
    "## 用户原文（逐字，权威）",
    input.original,
    "",
    "冲突时以「用户原文」为准；brief 与原文有出入，先问，不要自行取舍。",
    input.rules,
  ].join("\n")
}

/**
 * 决策转达消息（design 25 §6.2）。verbatim 块逐字来自卡片 option label，
 * framing 只允许补充边界 / 理由 / 影响。
 *
 * 兼容行 `用户回答了以下问题：<choice>` 仍然保留：任务线程里的问题卡靠它
 * 变只读，doer 的既有解析也认这个格式。结构化块在它后面，不替换它。
 */
export function formatRelayMessage(input: {
  handle: string
  askId: string
  choice: string
  note?: string
  framing?: string
}): string {
  return [
    `[决策 · ${input.handle} · ${input.askId}] ${input.choice}`,
    `用户回答了以下问题：${input.choice}`,
    "",
    "决策：",
    `（逐字）${input.choice}`,
    ...(input.note ? ["（补充）" + input.note] : []),
    ...(input.framing ? ["", "理由与边界（汐音补充，不改选择、不加新条件）：", input.framing] : []),
    "",
    "以上为用户在主对话中的决定，逐字权威。请按此继续推进，不要改选择；与当前计划冲突时先停下来说明，不要自行取舍。",
  ].join("\n")
}

/** 回执单行（design 25 §5.6 第 6 步）。 */
export function formatReceiptLine(input: {
  handle: string
  title: string
  choice: string
  relayed: "assistant" | "fallback"
}): string {
  return input.relayed === "assistant"
    ? `✓ ${input.handle} ${input.title} · 按「${input.choice}」交代下去`
    : `✓ ${input.handle} ${input.title} · 已直接转达（汐音未参与）`
}
