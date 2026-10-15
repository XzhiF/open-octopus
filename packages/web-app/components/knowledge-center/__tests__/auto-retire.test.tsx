/**
 * 票09 item-3/4 S4 — 自动退役通知卡渲染 + 恢复意图（组件级 seam：<KcCard/> 分发器 +
 * classifyKcRestore 纯函数 + Lane A 编解码往返）。
 *
 * 红线2 形态钉死：通知卡=先斩后奏的信息沉淀——**卡上零操作钮**（无批准/否决/采纳/
 * 忽略，负断言全卡面 button 数为 0）；可恢复提示只是对话口令文本（触发面在对话
 * 意图分类，不在卡上——「退役一页」同款动线镜像）。
 * Expected 真相源 = 票面 AC3「锚点/页/判据数据/可恢复提示」+ AC4「对话恢复 oct-XXX」。
 */
import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { classifyKcRestore } from "@/lib/knowledge-center/feed-protocol"
import {
  serializeKcCardBlock,
  parseKcCardBlocks,
  type KcCardEvent,
  type KcAutoRetireCardData,
  type KcPageRestoreCardData,
} from "@/lib/knowledge-center/card-protocol"
import { KcCard, hasKcCardRenderer, type KcCardActionCtx } from "@/components/knowledge-center/cards/registry"

const ctxStub = {
  openPage: () => {}, openFullPage: () => {}, openRaw: () => {}, revert: () => {},
  retryCompile: () => {}, sayToCurator: () => {}, adoptFinding: () => {}, ignoreFinding: () => {},
  backfillWiki: () => {}, dismissBackfill: () => {}, recompilePack: () => {}, retireCase: () => {},
} as unknown as KcCardActionCtx

const AUTO_EV: KcCardEvent = {
  id: "are-ret-20261014T0317-001",
  kind: "auto-retire",
  ts: "2026-10-14T03:17:30.000Z",
  data: {
    status: "committed",
    pagePath: "topics/top-zombie.md",
    to: "_retired/topics/top-zombie.md",
    commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    anchors: ["oct-001", "oct-042"],
    lastCited: "2026-07-10T00:00:00.000Z",
    daysSilent: 96,
    restoreHints: ["恢复 oct-001", "恢复 oct-042"],
  } satisfies KcAutoRetireCardData,
}

describe("classifyKcRestore — 恢复意图（票09 · 故事17 对话口令）", () => {
  it("恢复动词 + 锚点口令 ⇒ {anchor}（主形态「恢复 oct-XXX」）", () => {
    expect(classifyKcRestore("恢复 oct-001")).toEqual({ anchor: "oct-001" })
    expect(classifyKcRestore("把 oct-042 找回来")).toEqual({ anchor: "oct-042" })
    expect(classifyKcRestore("restore oct-007")).toEqual({ anchor: "oct-007" })
    expect(classifyKcRestore("误伤了，恢复 oct-123 吧")).toEqual({ anchor: "oct-123" })
  })

  it("恢复动词 + 页路径 ⇒ {path}（第二口令；锚点优先）", () => {
    expect(classifyKcRestore("恢复 topics/top-zombie.md")).toEqual({ path: "topics/top-zombie.md" })
    expect(classifyKcRestore("恢复 oct-001 即 topics/top-zombie.md 回迁")).toEqual({ anchor: "oct-001" })
  })

  it("动词在但无对象口令 ⇒ null（不吞普通对话）", () => {
    expect(classifyKcRestore("这个库的恢复能力你怎么看")).toBeNull()
    expect(classifyKcRestore("上次恢复的那篇写了啥")).toBeNull()
  })

  it("无恢复动词 ⇒ null（即使句中有锚点/路径）", () => {
    expect(classifyKcRestore("看一下 oct-001 引用情况")).toBeNull()
    expect(classifyKcRestore("topics/top-zombie.md 还在吗")).toBeNull()
  })

  it("空/空白 ⇒ null", () => {
    expect(classifyKcRestore("")).toBeNull()
    expect(classifyKcRestore("   ")).toBeNull()
  })
})

describe("auto-retire 通知卡 — 渲染与红线2 形态（S4）", () => {
  it("注册即用：auto-retire / page-restore 两 kind 已在注册表（开放 kind 零联合改动）", () => {
    expect(hasKcCardRenderer("auto-retire")).toBe(true)
    expect(hasKcCardRenderer("page-restore")).toBe(true)
  })

  it("Lane A fenced 块编解码往返（夜巡生产者写会话正文的正典形态）", () => {
    const block = serializeKcCardBlock(AUTO_EV)
    const { events, rest } = parseKcCardBlocks(`夜巡窄口自动退役：\n${block}\n`)
    expect(rest).not.toContain("kc-card")
    const back = events.find((e) => e.id === AUTO_EV.id)
    expect(back?.kind).toBe("auto-retire")
    expect((back?.data as KcAutoRetireCardData).daysSilent).toBe(96)
  })

  it("卡面渲染 AC3 四类数据：页/锚点/判据（静默天数+末引时刻）/可恢复提示", () => {
    const { container } = render(<KcCard event={AUTO_EV} ctx={ctxStub} />)
    expect(screen.getByTestId("kc-card-auto-retire")).toBeTruthy()
    const text = container.textContent ?? ""
    expect(text).toContain("topics/top-zombie.md") // 页
    expect(text).toContain("_retired/topics/top-zombie.md") // 去向
    expect(text).toContain("oct-001") // 锚点
    expect(text).toContain("96") // 判据数据：静默天数
    expect(text).toContain("2026-07-10") // 判据数据：末引时刻
    expect(text).toContain("恢复 oct-001") // 可恢复提示（对话口令）
    expect(text).toContain("恢复 oct-042")
  })

  it("红线2 负断言：通知卡零操作钮——无 button 元素、无批准/否决/采纳/忽略文案（先斩后奏信息态，非审批形态）", () => {
    const { container } = render(<KcCard event={AUTO_EV} ctx={ctxStub} />)
    expect(container.querySelectorAll("button")).toHaveLength(0)
    const text = container.textContent ?? ""
    for (const forbidden of ["批准", "否决", "同意", "采纳", "忽略", "驳回"]) {
      expect(text).not.toContain(forbidden)
    }
  })

  it("failed 态显形：错误码上卡不伪装成功（CODING_STANDARDS #2）", () => {
    const ev: KcCardEvent = {
      ...AUTO_EV,
      id: "are-fail-1",
      data: { ...AUTO_EV.data, status: "failed", error: { code: "NOT_FOUND", message: "页不在册" } },
    }
    const { container } = render(<KcCard event={ev} ctx={ctxStub} />)
    expect(container.textContent ?? "").toContain("NOT_FOUND")
  })
})

describe("page-restore 回执卡 — 恢复动作的状态回显（S4）", () => {
  it("committed 态：回显页/去向 commit/入链回补页数与漂移 warnings，零钮", () => {
    const ev: KcCardEvent = {
      id: "res-20261014T04-001",
      kind: "page-restore",
      ts: "2026-10-14T04:00:00.000Z",
      data: {
        status: "committed",
        anchor: "oct-001",
        pagePath: "topics/top-zombie.md",
        from: "_retired/topics/top-zombie.md",
        commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        linksRestored: 2,
        warnings: ["宿主页退役后已被编辑（漂移），入链回补让位归人裁：entities/ent-x.md"],
      } satisfies KcPageRestoreCardData,
    }
    const { container } = render(<KcCard event={ev} ctx={ctxStub} />)
    expect(screen.getByTestId("kc-card-page-restore")).toBeTruthy()
    const text = container.textContent ?? ""
    expect(text).toContain("已恢复")
    expect(text).toContain("topics/top-zombie.md")
    expect(text).toContain("entities/ent-x.md") // 漂移让位显形不吞
    expect(container.querySelectorAll("button")).toHaveLength(0)
  })
})
