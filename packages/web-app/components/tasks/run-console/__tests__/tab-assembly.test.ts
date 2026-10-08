// 票 02 统一弹窗壳 — 页签装配 / 动作装配 / 键盘切页的纯逻辑回归。
// 期望值逐条取自 spec.md「Implementation Decisions · 统一壳」页签装配表
// （源自原型 taskboard-v2.html 状态表）—— 独立真相源，不从这里反推实现。
import { describe, it, expect } from "vitest"
import {
  assembleTabs, cycleTab, assembleRailActions, tabLabel, deriveShellMode,
  type ConsoleTabKey,
} from "../tab-assembly"

describe("assembleTabs — spec 装配表（状态 → 页签 + 默认）", () => {
  it("running(flow)：变更·节点·控制台，默认 变更", () => {
    const { keys, defaultKey } = assembleTabs({ status: "running", v4: true })
    expect(keys).toEqual<ConsoleTabKey[]>(["files", "nodes", "console"])
    expect(defaultKey).toBe("files")
  })

  it("paused：页签集与 running 相同（默认页由调用方保持，不强制跳回）", () => {
    const paused = assembleTabs({ status: "paused", v4: true })
    const running = assembleTabs({ status: "running", v4: true })
    expect(paused.keys).toEqual(running.keys)
  })

  it("awaiting_review：对话·变更·走查·日志，默认 对话", () => {
    const { keys, defaultKey } = assembleTabs({ status: "awaiting_review", v4: true })
    expect(keys).toEqual<ConsoleTabKey[]>(["chat", "files", "review", "console"])
    expect(defaultKey).toBe("chat")
  })

  it("看板「验收」直开（startOnAcceptance）：同页签集，默认落 走查", () => {
    const { keys, defaultKey } = assembleTabs({ status: "awaiting_review", v4: true, startOnAcceptance: true })
    expect(keys).toEqual<ConsoleTabKey[]>(["chat", "files", "review", "console"])
    expect(defaultKey).toBe("review")
  })

  it("takeover（08 预留形态）：对话接管·变更·节点·日志，默认 对话", () => {
    const { keys, defaultKey } = assembleTabs({ status: "running", mode: "takeover", v4: true })
    expect(keys).toEqual<ConsoleTabKey[]>(["chat", "files", "nodes", "console"])
    expect(defaultKey).toBe("chat")
  })

  it("fixing（修复轮形态）：变更·节点·追加指令·控制台，默认 节点（自动推进直播）", () => {
    // 票 07 AC4：task-fix 进行中对话可用 —— 页签行按 spec 故事27 增补 chat
    //（形态语义=修复轮追加指令，经 06 的暂停→注入通道，非快改对话）。
    const { keys, defaultKey } = assembleTabs({ status: "running", mode: "fixing", v4: true })
    expect(keys).toEqual<ConsoleTabKey[]>(["files", "nodes", "chat", "console"])
    expect(defaultKey).toBe("nodes")
  })

  it("ready / archiving / 终态：变更·节点·控制台，默认 控制台（门禁/战报动线不回退）", () => {
    for (const status of ["ready", "archiving", "done", "failed", "aborted"] as const) {
      const { keys, defaultKey } = assembleTabs({ status, v4: true })
      expect(keys).toEqual<ConsoleTabKey[]>(["files", "nodes", "console"])
      expect(defaultKey).toBe("console")
    }
  })

  it("v3 legacy / derived 未加载：只剩 控制台 一页（占位页签不给 legacy 任务）", () => {
    const { keys, defaultKey } = assembleTabs({ status: "running", v4: false })
    expect(keys).toEqual<ConsoleTabKey[]>(["console"])
    expect(defaultKey).toBe("console")
  })

  it("页签标签（原型词表）：待验收=💬 对话/✓ 走查/▶ 日志；接管=💬 对话接管；修复轮=💬 追加指令", () => {
    expect(tabLabel("chat", { status: "awaiting_review" })).toBe("💬 对话")
    expect(tabLabel("chat", { status: "running", mode: "takeover" })).toBe("💬 对话接管")
    expect(tabLabel("chat", { status: "running", mode: "fixing" })).toBe("💬 追加指令")
    expect(tabLabel("review", { status: "awaiting_review" })).toBe("✓ 走查")
    expect(tabLabel("console", { status: "awaiting_review" })).toBe("▶ 日志")
    expect(tabLabel("console", { status: "running", mode: "fixing" })).toBe("▶ 控制台")
    expect(tabLabel("console", { status: "running" })).toBe("▶ 控制台")
    expect(tabLabel("files", { status: "running" })).toBe("≡ 变更")
    expect(tabLabel("nodes", { status: "running" })).toBe("◆ 节点")
  })
})

describe("cycleTab — ←/→ 键盘切页", () => {
  const keys: ConsoleTabKey[] = ["chat", "files", "review", "console"]
  it("→ 前进循环，末位回卷首位", () => {
    expect(cycleTab(keys, "console", 1)).toBe("chat")
    expect(cycleTab(keys, "files", 1)).toBe("review")
  })
  it("← 后退循环，首位回卷末位", () => {
    expect(cycleTab(keys, "chat", -1)).toBe("console")
    expect(cycleTab(keys, "review", -1)).toBe("files")
  })
  it("当前页不在页签集（状态迁移后）→ 落默认装配位（首个）", () => {
    expect(cycleTab(["files", "nodes", "console"], "review", 1)).toBe("files")
  })
})

describe("assembleRailActions — 右栏底部动作区按状态装配（spec 右栏列）", () => {
  it("running(flow)：✋ 有问题 · ⏸ 暂停 · ■ 中止（· ⧉ 复制）—— 票08 三分支入口就位", () => {
    expect(assembleRailActions({ status: "running", canPause: true, canResume: false, canAbort: true, canReopen: false })).toEqual([
      "ask-takeover", "pause", "abort", "duplicate",
    ])
  })
  it("paused：▶ 恢复 · ■ 中止（恢复与中止是暂停的两个出口）", () => {
    expect(assembleRailActions({ status: "paused", canPause: false, canResume: true, canAbort: true, canReopen: false })).toEqual([
      "resume", "abort", "duplicate",
    ])
  })
  it("running 但没有在跑的轮（停在审批等人）：不给 暂停，仍给 ✋（停流接管可停审批等待轮）与 中止", () => {
    expect(assembleRailActions({ status: "running", canPause: false, canResume: false, canAbort: true, canReopen: false })).toEqual([
      "ask-takeover", "abort", "duplicate",
    ])
  })
  it("awaiting_review：✓ 通过 · ↩ 打回（动作仍接既有实现 = acceptance surface）", () => {
    expect(assembleRailActions({ status: "awaiting_review", canPause: false, canResume: false, canAbort: true, canReopen: false })).toEqual([
      "accept", "reject", "duplicate",
    ])
  })
  it("ready：⚡ 触发 · ↺ 退回草稿 · ■ 中止 · ⧉ 复制；已定时 触发 换成 取消触发", () => {
    expect(assembleRailActions({ status: "ready", canPause: false, canResume: false, canAbort: true, canReopen: true })).toEqual([
      "trigger", "reopen", "abort", "duplicate",
    ])
    expect(assembleRailActions({ status: "ready", armedFuture: true, canPause: false, canResume: false, canAbort: true, canReopen: true })).toEqual([
      "trigger-cancel", "reopen", "abort", "duplicate",
    ])
  })
  it("终态（done/failed/aborted）：只剩 ⧉ 复制 —— 只读壳", () => {
    for (const status of ["done", "failed", "aborted"] as const) {
      expect(assembleRailActions({ status, canPause: false, canResume: false, canAbort: false, canReopen: false })).toEqual([
        "duplicate",
      ])
    }
  })

  // ── 票08 三分支形态（spec 表 takeover 行：进度 + 确认交付/改派/■）────────
  it("takeover：✓ 确认交付 · ⚙ 改派 task-fix · ■ 中止（不再给暂停/接管入口 —— 流已停）", () => {
    expect(assembleRailActions({
      status: "running", mode: "takeover",
      canPause: false, canResume: false, canAbort: true, canReopen: false,
    })).toEqual(["takeover-deliver", "takeover-reassign", "abort", "duplicate"])
  })
  it("paused 不给 ✋（三分支只站在 running flow 的现场 —— 暂停的出口仍是 恢复/中止）", () => {
    const acts = assembleRailActions({ status: "paused", canPause: false, canResume: true, canAbort: true, canReopen: false })
    expect(acts).not.toContain("ask-takeover")
  })
  it("fixing（task-fix 在跑）不给 ✋（改派入口 = 打回走 05，接管是 flow 轮的权利）", () => {
    const acts = assembleRailActions({
      status: "running", mode: "fixing",
      canPause: true, canResume: false, canAbort: true, canReopen: false,
    })
    expect(acts).not.toContain("ask-takeover")
    expect(acts).not.toContain("takeover-deliver")
  })
})

// ── 票08 形态判定单源（shellMode 三分支 —— 壳 :305 判据的纯函数化）────────
// 优先级来自现场唯一性：live task-fix 轮 = 修复轮直播优先（改派后 takeover
// 标记留在旧轮，不能把 fixing 盘面拽回接管壳）；无 live 且派生 phase
// 'takeover' = 停流未交付；其余 flow。期望 = spec 表 + ADR-0025。

describe("deriveShellMode — flow / takeover / fixing 三分支判定", () => {
  it("fixing 优先：live task-fix 轮在场（即使别处还挂着未交付 takeover 标记）", () => {
    expect(deriveShellMode({ fixingLive: true, takeoverActive: true })).toBe("fixing")
    expect(deriveShellMode({ fixingLive: true, takeoverActive: false })).toBe("fixing")
  })
  it("takeover：无 live 修复轮 + 派生存在 takeover phase", () => {
    expect(deriveShellMode({ fixingLive: false, takeoverActive: true })).toBe("takeover")
  })
  it("flow：两判据皆假（含交付后的 awaiting 世界 —— takeoverActive 由派生翻假）", () => {
    expect(deriveShellMode({ fixingLive: false, takeoverActive: false })).toBe("flow")
  })
})
