// packages/web-app/components/tasks/run-console/chat/__tests__/chat-model.test.ts
//
// 票 07「💬 对话」页签的纯逻辑单源回归。期望值独立真相源：
//   - 形态判定/页签 = spec.md 统一壳装配表 + 票 AC1/AC3/AC4
//   - 文案逐字 = 原型 taskboard-v2.html dockWelcome/chatFullHtml/sendChat（persona 正名
//     task-doer，原型行文 task-author 是改版前旧词 —— 词表 GLOSSARY：task-doer）
//   - 工具卡 +/− = Claude Edit/Write 工具入参的行差实物（fixture 手算钉死）
import { describe, it, expect } from "vitest"
import type { ChatMessage } from "@/lib/types"
import {
  chatFormFor, chatCopy, isTakeoverDeliveredRound,
  classifyToolCall, lineDiff, deriveQuickEditFiles,
  diffRowHit, toPosix,
  detectEscalationReply, buildRejectPrefill,
} from "../chat-model"

describe("chatFormFor — 三形态判定（页签装配的对话语义）", () => {
  it("待验收 → quick-edit（快速修改）；接管态 → takeover；修复轮 → fixing", () => {
    expect(chatFormFor({ status: "awaiting_review", mode: "flow" })).toBe("quick-edit")
    expect(chatFormFor({ status: "awaiting_review", mode: "fixing" })).toBe("quick-edit")
    expect(chatFormFor({ status: "running", mode: "takeover" })).toBe("takeover")
    expect(chatFormFor({ status: "running", mode: "fixing" })).toBe("fixing")
    expect(chatFormFor({ status: "paused", mode: "fixing" })).toBe("fixing")
  })
  it("执行中（flow）/ready/终态无对话形态 —— 不打扰模式，输入口不在此页签", () => {
    for (const status of ["running", "paused", "ready", "archiving", "done", "failed", "aborted"] as const) {
      expect(chatFormFor({ status, mode: "flow" })).toBeNull()
    }
  })
})

describe("chatCopy — 三形态文案（原型逐字）", () => {
  it("quick-edit：欢迎语承诺「小改直接说…大改我会劝你打回」，placeholder 举小改例", () => {
    const c = chatCopy("quick-edit")
    expect(c.welcome).toContain("小改直接说")
    expect(c.welcome).toContain("💬chat")
    expect(c.placeholder).toContain("验收通过按钮再圆一点")
  })
  it("takeover：一句「已停流，从现在起一步一交」；placeholder 是草稿式指挥口吻", () => {
    const c = chatCopy("takeover")
    expect(c.welcome).toBe("已停流，从现在起一步一交。")
    expect(c.placeholder).toContain("像草稿一样指挥")
  })
  it("fixing：明示 task-fix 在跑 + 追加干预语义（AC4 UI 明示）", () => {
    const c = chatCopy("fixing")
    expect(c.header).toContain("task-fix")
    expect(c.hint).toContain("追加干预")
    expect(c.placeholder).toContain("追加指令")
  })
  it("票08：接管件已交付的待验收 —— quick-edit 口吻不变，hint 换「接管件已交付」句", () => {
    // 原型 dockMode(wait)：t.tookover ? '接管件已交付 — 验收前还能继续说改' : …
    const c = chatCopy("quick-edit", { takeoverDelivered: true })
    expect(c.hint).toBe("接管件已交付 — 验收前还能继续说改")
    // 非接管件逐字不变（回归锁 —— opts 省略 = 现行为）。
    expect(chatCopy("quick-edit").hint).toBe("小改直接说 · 实时进「变更」与统计")
    expect(chatCopy("quick-edit", { takeoverDelivered: false }).hint).toBe("小改直接说 · 实时进「变更」与统计")
    // takeover/fixing 形态不吃这个旗标（形态互斥，文案互不污染）。
    expect(chatCopy("takeover", { takeoverDelivered: true }).hint).toBe("一步一交 —— 每句话直接改执行工作区")
  })
})

describe("isTakeoverDeliveredRound — 接管件判据（走查标注/对话 hint 的共用单源）", () => {
  it("at+delivered 双有 = 接管交付件；仅 at（接管中不是 awaiting）/无键（旧 server）= 否", () => {
    expect(isTakeoverDeliveredRound({ takeover_at: "t", takeover_delivered_at: "d" })).toBe(true)
    expect(isTakeoverDeliveredRound({ takeover_at: "t", takeover_delivered_at: null })).toBe(false)
    expect(isTakeoverDeliveredRound({})).toBe(false)
    expect(isTakeoverDeliveredRound(undefined)).toBe(false)
  })
})

describe("lineDiff — 工具卡 +a −b 的行差口径（fixture 手算）", () => {
  it("中段换一行 → +1 −1（公共前后缀行不计量）", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual({ adds: 1, dels: 1 })
  })
  it("删两行（new 空）→ +0 −2；纯追加 → +1 −0", () => {
    expect(lineDiff("x\ny", "")).toEqual({ adds: 0, dels: 2 })
    expect(lineDiff("a\nb", "a\nb\nc")).toEqual({ adds: 1, dels: 0 })
  })
  it("原文不变 → 0/0；首行插入不受尾部对齐影响", () => {
    expect(lineDiff("same", "same")).toEqual({ adds: 0, dels: 0 })
    expect(lineDiff("b\nc", "a\nb\nc")).toEqual({ adds: 1, dels: 0 })
  })
})

describe("classifyToolCall — 原型工具卡「⚙ 编辑 file +a −b」", () => {
  it("Edit：文件 basename + 行差；Windows 反斜杠路径归一 posix", () => {
    const card = classifyToolCall("Edit", {
      file_path: "C:\\ws\\projects\\octopus\\packages\\web-app\\a.tsx",
      old_string: "rounded-xl\nactive:translate-y-[2px]",
      new_string: "rounded-[18px]\nactive:translate-y-[1px]",
    })
    expect(card).toEqual({
      kind: "edit", verb: "编辑",
      file: "C:/ws/projects/octopus/packages/web-app/a.tsx",
      adds: 2, dels: 2,
    })
  })
  it("Write：新内容行数全计 +，旧行不可得 dels=null", () => {
    const card = classifyToolCall("Write", { file_path: "packages/b.md", content: "l1\nl2\nl3" })
    expect(card).toEqual({ kind: "edit", verb: "写入", file: "packages/b.md", adds: 3, dels: null })
  })
  it("MultiEdit：逐 edit 行差求和", () => {
    const card = classifyToolCall("MultiEdit", {
      file_path: "c.ts",
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "b\nc", new_string: "B" },
      ],
    })
    expect(card).toEqual({ kind: "edit", verb: "编辑", file: "c.ts", adds: 2, dels: 3 })
  })
  it("入参可能是 JSON 字符串（历史行 metadata 形状）；非编辑工具/缺 file → null", () => {
    expect(classifyToolCall("Edit", JSON.stringify({ file_path: "d.ts", old_string: "x", new_string: "y" })))
      .toEqual({ kind: "edit", verb: "编辑", file: "d.ts", adds: 1, dels: 1 })
    expect(classifyToolCall("Read", { file_path: "d.ts" })).toBeNull()
    expect(classifyToolCall("Bash", { command: "pnpm build" })).toBeNull()
    expect(classifyToolCall("Edit", undefined)).toBeNull() // 入参未流完不出半卡
    expect(classifyToolCall("AskUserQuestion", { questions: [{ question: "改哪个按钮？" }] }))
      .toEqual({ kind: "question", text: "改哪个按钮？" })
  })
})

describe("deriveQuickEditFiles / diffRowHit — 💬chat 徽标映射", () => {
  const msg = (toolName: string, toolInput: unknown): ChatMessage => ({
    id: `t-${toolName}-${Math.random()}`, sessionId: "s", role: "assistant",
    displayType: "tool_call", content: "", timestamp: "", toolName, toolInput, toolStatus: "done",
  })
  it("会话流里的编辑工具文件去重收集（Read 不进徽标）", () => {
    const files = deriveQuickEditFiles([
      msg("Read", { file_path: "C:/ws/x.ts" }),
      msg("Edit", { file_path: "C:/ws/projects/octopus/packages/a.ts", old_string: "1", new_string: "2" }),
      msg("Edit", { file_path: "C:/ws/projects/octopus/packages/a.ts", old_string: "3", new_string: "4" }),
      msg("Write", { file_path: "packages/logo.png", content: "" }),
    ])
    expect(files).toEqual(["C:/ws/projects/octopus/packages/a.ts", "packages/logo.png"])
  })
  it("round-diff 相对行 vs 工具绝对路径：完整尾段匹配才算，半截文件名不算", () => {
    const edited = ["C:/ws/projects/octopus/packages/web-app/a.ts"]
    expect(diffRowHit("packages/web-app/a.ts", edited)).toBe(true)
    expect(diffRowHit("other/a.ts", edited)).toBe(false)
    expect(diffRowHit("packages/web-app/a.tsx", edited)).toBe(false) // a.ts ≠ a.tsx 前缀陷阱
    expect(diffRowHit("packages/web-app/a.ts", [])).toBe(false)
  })
})

describe("detectEscalationReply / buildRejectPrefill — 劝退→打回预填（AC3）", () => {
  it("persona 劝退话术命中：须同时出现「打回」与「修复轮/task-fix」", () => {
    expect(detectEscalationReply("这个改动面比较大，建议打回 → 修复轮（task-fix）：我把你的话整理成指令草稿了。")).toBe(true)
    expect(detectEscalationReply("改好了 —— 圆角已提到 18px，刷新「变更」即可见。")).toBe(false)
    expect(detectEscalationReply("这里有个 task-fix 的历史说明，供参考。")).toBe(false) // 无「打回」不谎报
  })
  it("草稿=回复原文（persona 已整理成可粘贴指令，UI 不重抄）", () => {
    expect(buildRejectPrefill(" 打回派修复轮：按钮圆角问题…  ")).toBe("打回派修复轮：按钮圆角问题…")
  })
})
