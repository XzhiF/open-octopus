// packages/server/src/__tests__/ledger-columns.test.ts
//
// 票09 验收台账三列的纯函数写面（counts→markdown 段落）。期望文案/数字来自票面
// 文案与 spec.md（干预列名「人工干预 · agent_events · 与 harness 干预分列」、
// 快改列「快速修改（[quick-edit] 提交）」、接管件「自动复检未跑（接管件）」），
// 不是实现自证。含变异点锁：接管「复检真结果优先」（ADR-0025 不设新闸、不覆盖
// 实况）—— 若实现把「未跑」写死或忽略 verify，本文件转红。

import { describe, it, expect } from "vitest"
import {
  buildInterventionSection,
  buildQuickEditSection,
  buildTakeoverSection,
  type LedgerInterventionEntry,
  type LedgerQuickEditEntry,
  type LedgerTakeoverMark,
} from "../services/tasks/round-evidence-service"

const iv = (over: Partial<LedgerInterventionEntry> = {}): LedgerInterventionEntry => ({
  node: "实现节点",
  time: "2026-10-08T03:04:05.000Z",
  summary: "别动 Dialog 尺寸逻辑",
  ...over,
})
const qe = (over: Partial<LedgerQuickEditEntry> = {}): LedgerQuickEditEntry => ({
  repo: "app",
  sha: "abcdef1234567890",
  subject: "[quick-edit] 收口按钮圆角",
  files: ["packages/web-app/ui/button.tsx", "packages/web-app/ui/dialog.tsx"],
  ...over,
})
const tk = (over: Partial<LedgerTakeoverMark> = {}): LedgerTakeoverMark => ({
  at: "2026-10-08T02:00:00.000Z",
  deliveredAt: "2026-10-08T03:00:00.000Z",
  ...over,
})

describe("buildInterventionSection — 人工干预列（agent_events 权威，harness 另计）", () => {
  it("N 行 → ×N 计数 + 逐条「⚑ 节点 · 时间 · 摘要」，并显式声明与 harness 干预分列", () => {
    const lines = buildInterventionSection([iv(), iv({ node: "评审节点", summary: "再看一眼 AC" })])
    const md = lines.join("\n")
    expect(md).toContain("## 人工干预")
    expect(md).toContain("人工干预 ×2")
    expect(md).toContain("agent_events")
    expect(md).toContain("harness")        // 分列声明（勿混称）
    expect(md).toContain("⚑ 实现节点")
    expect(md).toContain("别动 Dialog 尺寸逻辑")
    expect(md).toContain("⚑ 评审节点")
  })

  it("空 → ×0（无），既有段不丢（append-only 列齐）", () => {
    const md = buildInterventionSection([]).join("\n")
    expect(md).toContain("## 人工干预")
    expect(md).toContain("人工干预 ×0")
  })
})

describe("buildQuickEditSection — 快速修改列（git [quick-edit] 标记，文件可溯）", () => {
  it("逐条列 repo · 短 sha · subject + 文件清单；总数去重", () => {
    const lines = buildQuickEditSection([
      qe(),
      qe({ sha: "9999999000000000", files: ["a.txt"] }),
    ])
    const md = lines.join("\n")
    expect(md).toContain("## 快速修改")
    expect(md).toContain("快速修改 ×2")
    expect(md).toContain("[quick-edit]")
    expect(md).toContain("3 文件")        // 两 + 一去重 = 3
    expect(md).toContain("abcdef1")       // 短 sha（7 位）
    expect(md).toContain("收口按钮圆角")
    expect(md).toContain("a.txt")
  })

  it("空 → ×0（无）", () => {
    expect(buildQuickEditSection([]).join("\n")).toContain("快速修改 ×0")
  })
})

describe("buildTakeoverSection — 接管标记列（takeover_* 权威 · 复检真结果优先）", () => {
  it("无接管 → 「无（绑定流机器轮）」", () => {
    expect(buildTakeoverSection(null, false).join("\n")).toContain("接管 · 无")
  })

  it("接管件且未跑复检 → 「人工交付 · 自动复检未跑（接管件）」", () => {
    const md = buildTakeoverSection(tk(), false).join("\n")
    expect(md).toContain("## 人工接管")
    expect(md).toContain("人工交付 · 自动复检未跑（接管件）")
    expect(md).toContain("takeover_at")
  })

  it("接管件但复检有真结果 → 真结果优先，绝不写「未跑」（ADR-0025 不覆盖实况 · 不设新闸）", () => {
    const md = buildTakeoverSection(tk(), true).join("\n")
    expect(md).toContain("接管件")
    expect(md).not.toContain("未跑")
    expect(md).toContain("复检已跑")
  })

  it("停流未交付（有 at 无 delivered）→ 标进行中，不落「交付」语义", () => {
    const md = buildTakeoverSection(tk({ deliveredAt: null }), false).join("\n")
    expect(md).toContain("进行中")
  })
})
