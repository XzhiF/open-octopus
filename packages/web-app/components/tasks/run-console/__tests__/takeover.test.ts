// 票08 三分支决策框的纯逻辑回归。
// 期望文案逐字取自原型 taskboard-v2.html openBranch()/pickBr()/confirmDispatch()
// （交互真相源）+ 票面 AC「选 ③ 时指令必填」；行为期望不从这里反推实现。

import { describe, it, expect } from "vitest"
import {
  BRANCH_OPTIONS, branchGoLabel, branchSubmitBlocked, FIX_DISPATCH_BLOCK_MESSAGE,
  type BranchChoice,
} from "../takeover"

describe("三分支框 — 选项与按钮文案（原型逐字）", () => {
  it("三选项 id/主文案/小字与原型 brA/brB/brC 一致", () => {
    expect(BRANCH_OPTIONS.map((o) => o.id)).toEqual<BranchChoice[]>(["inject", "takeover", "fix"])
    expect(BRANCH_OPTIONS[0].label).toBe("① ⚑ 注入干预 · 原工作流继续")
    expect(BRANCH_OPTIONS[1].label).toBe("② ✋ 停流 · 我接管（对话开发）")
    expect(BRANCH_OPTIONS[2].label).toBe("③ ⚙ 改派通用修复流 task-fix")
    expect(BRANCH_OPTIONS[0].hint).toContain("暂停当前节点")
    expect(BRANCH_OPTIONS[1].hint).toContain("一步一确认")
    expect(BRANCH_OPTIONS[2].hint).toContain("自动转待验收")
  })

  it("go 按钮文案随选变化（原型 pickBr 三分支）", () => {
    expect(branchGoLabel("inject")).toBe("① 注入干预并继续")
    expect(branchGoLabel("takeover")).toBe("② 停止工作流 · 进入接管")
    expect(branchGoLabel("fix")).toBe("③ 派发 task-fix")
  })
})

describe("提交闸门 — ③ 指令必填（票面 AC）", () => {
  it("①/② 指令可空（② 空 = 进场后一句句说；① 指令归 06 注入框）", () => {
    expect(branchSubmitBlocked("inject", "")).toBeNull()
    expect(branchSubmitBlocked("takeover", "")).toBeNull()
    expect(branchSubmitBlocked("takeover", "   ")).toBeNull()
  })

  it("③ 空/纯空白被拦，报错文案 = 原型 confirmDispatch 的 toast 逐字", () => {
    expect(branchSubmitBlocked("fix", "")).toBe(FIX_DISPATCH_BLOCK_MESSAGE)
    expect(branchSubmitBlocked("fix", "  \n ")).toBe(FIX_DISPATCH_BLOCK_MESSAGE)
    expect(FIX_DISPATCH_BLOCK_MESSAGE).toBe("指令必填 — task-fix 通用流按你的输入开发")
  })

  it("③ 有指令放行（trim 后非空即可）", () => {
    expect(branchSubmitBlocked("fix", "只补齐行号对齐和 hover 描边")).toBeNull()
  })
})
