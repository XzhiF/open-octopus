import { describe, it, expect } from "vitest"
import { createEffectivenessRoutes } from "../effectiveness"

/**
 * S2 契约（票06 AC4 手动触发端点）：POST /api/knowledge/effectiveness/parse =
 * 「解析至最新」同步通道，200 吐 LedgerReport（形状钉死——后续票只换值不换形，
 * knowledge-read.ts:20-22 契约纪律）。错误面 {error:{code,message}} 稳定码。
 */

function routesWith(parse: () => Promise<unknown>) {
  return createEffectivenessRoutes({ parse: parse as never })
}

describe("POST /effectiveness/parse — 手动记账触发（S2）", () => {
  it("200 报告形状逐字钉：scanned/citations/helpful/notHelpful/linkSkips/warnings/lastCursor", async () => {
    const report = {
      scanned: 3,
      citations: 7,
      helpful: 2,
      notHelpful: 1,
      linkSkips: { no_llm: 1 },
      warnings: ["var_pool 坏形，引用面跳过：exec-x"],
      lastCursor: "exec-9",
    }
    const res = await routesWith(async () => report).request("/parse", { method: "POST" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(
      ["citations", "helpful", "lastCursor", "linkSkips", "notHelpful", "scanned", "warnings"],
    )
    expect(body).toEqual(report)
  })

  it("解析炸 ⇒ 500 稳定码面（不吞错、不裸文案）", async () => {
    const res = await routesWith(async () => { throw new Error("disk on fire") }).request("/parse", { method: "POST" })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("EFFECTIVENESS_PARSE_FAILED")
    expect(body.error.message).not.toContain("disk on fire")
  })

  it("非 POST 方法不服务此面（GET /ledger 类旁路零存在——票06 无读端点，账目经 DB/游标可查）", async () => {
    const app = routesWith(async () => ({}) )
    const res = await app.request("/ledger")
    expect(res.status).toBe(404)
  })
})

// P4 票07：POST /sync = confidence 快照刷页手动通道（夜巡腿同服务入口，parse 同款双触发制式）。
describe("POST /effectiveness/sync — 票07 快照刷页手动触发（S2）", () => {
  const report = {
    scannedPages: 12,
    updated: [{ relPath: "topics/top-a.md", from: null, to: 0.375 }],
    rowsRecomputed: 2,
    changed: true,
    commit: "a".repeat(40),
    queueTaskId: "es-20261015T0317-001",
    warnings: [],
  }

  it("200 报告形状逐字钉（契约形状先定，只换值不换形）", async () => {
    const app = createEffectivenessRoutes({ parse: async () => ({} as never), sync: async () => report as never })
    const res = await app.request("/sync", { method: "POST" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(
      ["changed", "commit", "queueTaskId", "rowsRecomputed", "scannedPages", "updated", "warnings"],
    )
    expect(body).toEqual(report)
  })

  it("刷页炸 ⇒ 500 稳定码面 EFFECTIVENESS_SYNC_FAILED（原始错文不裸奔）", async () => {
    const app = createEffectivenessRoutes({ parse: async () => ({} as never), sync: async () => { throw new Error("L4_INDEX_BUDGET: queue backlog") } })
    const res = await app.request("/sync", { method: "POST" })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("EFFECTIVENESS_SYNC_FAILED")
    expect(body.error.message).not.toContain("backlog")
  })

  it("未接刷页通道 ⇒ 503 EFFECTIVENESS_SYNC_UNAVAILABLE（诚实显形不装成功）", async () => {
    const res = await createEffectivenessRoutes({ parse: async () => ({}) }).request("/sync", { method: "POST" })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("EFFECTIVENESS_SYNC_UNAVAILABLE")
  })
})
