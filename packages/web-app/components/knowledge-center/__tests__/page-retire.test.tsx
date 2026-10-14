import { describe, it, expect } from "vitest"
import { classifyKcRetire } from "@/lib/knowledge-center/feed-protocol"
import { serializeKcCardBlock, parseKcCardBlocks, kcEventPageRefs, type KcCardEvent } from "@/lib/knowledge-center/card-protocol"
import { hasKcCardRenderer, registerKcCardRenderer } from "@/components/knowledge-center/cards/registry"

/**
 * 票08 item-4 S4 — 对话退役意图识别 + 退役卡协议/Lane-A 面。
 * 断言外部行为：意图分类纯函数（动词闸/对象闸）、卡 kind 注册、Lane A 编解码往返、
 * 退役页不触发右栏跟随（页已从 tree 摘除）。组件像素渲染交 next build + 人工 dogfood。
 */
describe("classifyKcRetire — 退役意图（票08 · 故事32）", () => {
  it("退役动词 + wiki 页相对路径 ⇒ {path}", () => {
    expect(classifyKcRetire("退役 concepts/con-kc15-widget-a.md")).toEqual({ path: "concepts/con-kc15-widget-a.md" })
    expect(classifyKcRetire("把 topics/top-kc15-rollback-spec.md 下线").path).toBe("topics/top-kc15-rollback-spec.md")
    expect(classifyKcRetire("supersede entities/ent-kc15-widget-b.md").path).toBe("entities/ent-kc15-widget-b.md")
  })

  it("动词在但无页路径对象 ⇒ null（不吞普通对话）", () => {
    expect(classifyKcRetire("退役这件事你怎么看")).toBeNull()
    expect(classifyKcRetire("上次下线的那篇在哪")).toBeNull()
  })

  it("无退役动词 ⇒ null（即使句中有页路径）", () => {
    expect(classifyKcRetire("看一下 concepts/con-a.md 写了啥")).toBeNull()
  })

  it("空/空白 ⇒ null", () => {
    expect(classifyKcRetire("")).toBeNull()
    expect(classifyKcRetire("   ")).toBeNull()
  })
})

describe("page-retire 卡协议 + 注册（票08 · 故事32）", () => {
  const ev: KcCardEvent = {
    id: "ret-crt-1",
    kind: "page-retire",
    ts: "2026-10-14T09:00:00.000Z",
    data: { status: "committed", pagePath: "concepts/con-kc15-widget-a.md", to: "_retired/concepts/con-kc15-widget-a.md", commit: "abcdef1234567" },
  }

  it("退役卡 kind 已在注册表一行注册（无 KcCardKind 联合改动）", () => {
    expect(hasKcCardRenderer("page-retire")).toBe(true)
    // 注册即用：新 kind 无需改分发器 switch
    expect(registerKcCardRenderer).toBeTypeOf("function")
  })

  it("Lane A fenced 块编解码往返（沉淀进会话正文的正典形态）", () => {
    const block = serializeKcCardBlock(ev)
    const { events, rest } = parseKcCardBlocks(`退役回执：\n${block}\n`)
    expect(rest).not.toContain("kc-card") // 块已从展示文本剥除
    const back = events.find(e => e.id === "ret-crt-1")
    expect(back?.kind).toBe("page-retire")
    expect((back?.data as { to?: string }).to).toBe("_retired/concepts/con-kc15-widget-a.md")
  })

  it("退役页不触发右栏跟随（页已摘出 tree，返回空 refs）", () => {
    expect(kcEventPageRefs(ev)).toEqual([])
  })
})
