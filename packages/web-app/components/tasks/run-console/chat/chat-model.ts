// packages/web-app/components/tasks/run-console/chat/chat-model.ts
//
// 票 07「💬 对话」页签的纯逻辑单源：形态判定 / 三形态文案 / 工具卡抽取 /
// 快改徽标匹配 / 劝退回复判定与打回草稿。DOM/网络零依赖 —— chat-tab.tsx 与
// 壳（task-run-console）是唯一消费者。
//
// 真相源：spec.md（S1 三形态同口、快改每改即 commit、大改劝退=模型判断）+
// 原型 taskboard-v2.html（dockWelcome/chatMsg 工具卡/openRejectPrefill 逐字）。
// ADR-0025 会话两面性：本组件只说「做」面（task-doer），「谈」面（task-author）
// 零串台 —— 端点/组件都不碰 source_chat 会话。

import type { ChatMessage } from "@/lib/types"
import type { ConsoleShellMode, ConsoleShellStatus } from "../tab-assembly"

// ── 形态判定（票 07 AC1/AC4 + 08 接管契约）───────────────────────────────

/** 对话页签的三种形态：待验收=快速修改 / 人工接管 / 修复轮追加指令。
 *  优先级：待验收轮在场时恒 quick-edit（接管交付后仍是该口吻）；否则 takeover
 *  > fixing > 无（running flow 态没有对话页签 —— 不打扰纪律，票 06）。 */
export type ChatForm = "quick-edit" | "takeover" | "fixing"

export function chatFormFor(input: { status: ConsoleShellStatus; mode: ConsoleShellMode }): ChatForm | null {
  if (input.status === "awaiting_review") return "quick-edit"
  if (input.mode === "takeover") return "takeover"
  if (input.mode === "fixing") return "fixing"
  return null
}

export interface ChatCopy {
  /** 页签内头部标题；fixing 形态必亮「task-fix 执行中」（AC4 UI 明示）。 */
  header: string
  hint: string
  /** 空历史欢迎语（原型 dockWelcome 逐字，persona 正名 task-doer）。 */
  welcome: string
  placeholder: string
}

const CHAT_COPY: Record<ChatForm, ChatCopy> = {
  "quick-edit": {
    header: "✎ 快速修改 · task-doer",
    hint: "小改直接说 · 实时进「变更」与统计",
    welcome:
      "小改直接说 —— 按钮、文案、颜色这类我当场改代码，改动进「变更」页签（标 💬chat）；大改我会劝你打回给 task-fix 修复轮。",
    placeholder: "直接说小改 —— 例：验收通过按钮再圆一点 / 文件行 hover 不明显…",
  },
  takeover: {
    header: "✎ 对话接管 · task-doer",
    hint: "一步一交 —— 每句话直接改执行工作区",
    welcome: "已停流，从现在起一步一交。",
    placeholder: "像草稿一样指挥 —— 例：先把 hover 描边改了，别动统计条…",
  },
  fixing: {
    header: "⚙ task-fix 执行中",
    hint: "期间发消息 = 追加干预（修复轮追加指令）",
    welcome: "task-fix 在跑 —— 这里说的话 = 追加干预，随下一个节点生效。",
    placeholder: "追加指令…",
  },
}

/** opts.takeoverDelivered（票08）：待验收的轮是接管件（停流→对话→交付而来）——
 *  原型 dockMode(wait) 逐字换 hint，口吻仍是快改（chatFormFor 的 awaiting 优先级不变）。
 *  旗标只染 quick-edit：takeover/fixing 形态与它互斥，文案互不污染。 */
export function chatCopy(form: ChatForm, opts?: { takeoverDelivered?: boolean }): ChatCopy {
  const base = CHAT_COPY[form]
  if (form === "quick-edit" && opts?.takeoverDelivered) {
    return { ...base, hint: "接管件已交付 — 验收前还能继续说改" }
  }
  return base
}

/** 接管交付件判据（走查「接管件 · 自动复检未跑」标注与对话 hint 的共用单源）：
 *  takeover_at + takeover_delivered_at 双非空 —— 两列语义见 ADR-0025/票08 契约。
 *  缺键（旧 server）= 否，与 workflow_ref 向后兼容同律。 */
export function isTakeoverDeliveredRound(
  exec: { takeover_at?: string | null; takeover_delivered_at?: string | null } | undefined,
): boolean {
  return !!exec && exec.takeover_at != null && exec.takeover_delivered_at != null
}

// ── 工具卡（原型 .tool-card：⚙ 编辑 <file> +a −b [查看 diff]）───────────

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/")
}

/** 编辑类工具卡；question = AskUserQuestion 的降级呈现；null = 非编辑工具
 *  （Read/Bash 等噪声不占对话版面 —— 原型只渲染编辑卡）。 */
export type ToolCard =
  | { kind: "edit"; verb: "编辑" | "写入"; file: string; adds: number | null; dels: number | null }
  | { kind: "question"; text: string }

function splitLines(text: string): string[] {
  if (!text) return []
  const arr = text.split(/\r?\n/)
  if (arr.length > 1 && arr[arr.length - 1] === "") arr.pop()
  return arr
}

/** 行差口径（手算 fixture 钉死于测试）：剪去公共前后缀行，剩下的旧行计 −、
 *  新行计 +。Edit 的 old_string/new_string 是局部替换段，这个口径恰好等于
 *  落进 diff 的行数（上下文行在段外）。 */
export function lineDiff(oldText: string, newText: string): { adds: number; dels: number } {
  const o = splitLines(oldText)
  const n = splitLines(newText)
  let head = 0
  while (head < o.length && head < n.length && o[head] === n[head]) head++
  let tail = 0
  while (tail < o.length - head && tail < n.length - head && o[o.length - 1 - tail] === n[n.length - 1 - tail]) tail++
  return { adds: n.length - head - tail, dels: o.length - head - tail }
}

function parseInput(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw) as unknown
      if (v && typeof v === "object") return v as Record<string, unknown>
    } catch { /* 非 JSON 的旧行形状 —— 无卡可出 */ }
  }
  return null
}

/** 工具调用行（SSE tool_call 帧 / 历史 metadata 两代形状同一入口）→ 工具卡。
 *  toolInput 未到（tool_call_start 先于入参流完）时返回 null —— 卡片等参数齐
 *  才落版面，不留半张空卡。 */
export function classifyToolCall(toolName: string | undefined, toolInput: unknown): ToolCard | null {
  if (!toolName) return null
  const inp = parseInput(toolInput)
  if (toolName === "AskUserQuestion") {
    const questions = Array.isArray(inp?.questions) ? (inp!.questions as unknown[]) : []
    const first = questions[0] as { question?: unknown } | undefined
    const text = typeof first?.question === "string" ? first.question : ""
    return text ? { kind: "question", text } : null
  }
  if (!inp) return null
  const file = typeof inp.file_path === "string" ? toPosix(inp.file_path) : ""
  if (!file) return null
  switch (toolName) {
    case "Edit": {
      const d = lineDiff(
        typeof inp.old_string === "string" ? inp.old_string : "",
        typeof inp.new_string === "string" ? inp.new_string : "",
      )
      return { kind: "edit", verb: "编辑", file, adds: d.adds, dels: d.dels }
    }
    case "MultiEdit": {
      const edits = Array.isArray(inp.edits) ? (inp.edits as unknown[]) : []
      let adds = 0
      let dels = 0
      for (const e of edits) {
        const rec = (e ?? {}) as Record<string, unknown>
        const d = lineDiff(
          typeof rec.old_string === "string" ? rec.old_string : "",
          typeof rec.new_string === "string" ? rec.new_string : "",
        )
        adds += d.adds
        dels += d.dels
      }
      return { kind: "edit", verb: "编辑", file, adds, dels }
    }
    case "Write": {
      // 覆盖写：新内容行数全计 +，旧行数客户端不可得 → dels null（「+N −?」）。
      const lines = splitLines(typeof inp.content === "string" ? inp.content : "").length
      return { kind: "edit", verb: "写入", file, adds: lines, dels: null }
    }
    default:
      return null
  }
}

/** 会话消息流里出现过的编辑类工具卡文件（posix）——「≡ 变更」💬chat 徽标的
 *  唯一数据源（票 07 契约：quick_edit 落点与工具卡同源，不另拉 git）。 */
export function deriveQuickEditFiles(messages: readonly ChatMessage[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (m.displayType !== "tool_call") continue
    const card = classifyToolCall(m.toolName, m.toolInput)
    if (card?.kind === "edit" && !out.includes(card.file)) out.push(card.file)
  }
  return out
}

/** round-diff 行是仓相对路径（packages/…），工具卡是工作区绝对/相对长路径：
 *  后缀匹配（相对段完整边界）。 */
export function diffRowHit(relPath: string, files: readonly string[]): boolean {
  const rel = toPosix(relPath).toLowerCase()
  return files.some((f) => {
    const abs = toPosix(f).toLowerCase()
    return abs === rel || abs.endsWith(`/${rel}`)
  })
}

// ── 劝退回复 → 打回预填（票 07 AC3；05 单 textarea）──────────────────────

/** 判定只读回复文本 —— 大改劝退由 task-doer persona（模型侧）做，UI 认它落的
 *  词：「打回」+「修复轮/task-fix」。不做用户指令关键词核对（spec：劝退=模型判断）。 */
export function detectEscalationReply(text: string): boolean {
  if (!text.includes("打回")) return false
  return text.includes("修复轮") || text.includes("task-fix")
}

/** 打回框预填草稿 = 该条劝退回复原文（原型 openRejectPrefill 逐字口径 ——
 *  persona 已把用户的话整理成「可直接粘进打回框」的指令草稿，UI 不重抄不改写）。 */
export function buildRejectPrefill(replyText: string): string {
  return replyText.trim()
}

// ── 快改视图 / SSE 错误帧 ────────────────────────────────────────────────

/** 「≡ 变更」要的快改视图：本会话 quick_edit_commit 数（×N chip）+ 工具卡文件
 *  （💬chat 徽标）。由 chat-tab 上抛，壳喂 FilesTab 的 rowDecor/toolbarExtra。 */
export interface ChatEditsView {
  commits: number
  files: string[]
}

/** error 帧 → 面向用户的一句话（与 workspace-chat useChatStream 同映射表）。 */
export function describeFrameError(frame: Record<string, unknown>): string {
  const code = String(frame.code ?? "unknown")
  if (code === "auth") return "认证失败，请检查 API Key"
  if (code === "rate_limit") return "请求过于频繁，请稍后重试"
  if (code === "timeout") return "AI 响应超时"
  return String(frame.message ?? "未知错误")
}
