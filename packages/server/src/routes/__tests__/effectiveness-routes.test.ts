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
