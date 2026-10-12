import { describe, it, expect } from "vitest"
import { createWikiDistillRoutes } from "../wiki-distill"
import type { DistillReport } from "../../services/knowledge/wiki/distill"

/**
 * S3 routes 缝（票07；wiki-migrate-routes.test.ts 同先例）：蒸馏命令 HTTP 入口 =
 * POST /api/knowledge/wiki/distill?org= 薄封装，行为断言在 S1 蒸馏测试里；
 * 这里只锁契约：org/docsPath 透传、report JSON 原样返回、错误走 errorResponse 形状。
 */

const fakeReport: DistillReport = {
  queued: [{ source: "docs/research/a.md", entryId: "res-a", path: "research/res-a.md", itemId: "wiki-distill-x-res-a-abc" }],
  skipped: ["docs/adr/0001-b.md"],
  failed: [{ source: "docs/research/c.md", error: "DISTILL_LINT_REJECTED: L1_CAPACITY" }],
  totals: { sources: 3, queued: 1, skipped: 1, failed: 1 },
}

describe("wiki distill routes", () => {
  it("POST /distill passes org and docsPath through and returns the distill report", async () => {
    const seen: string[] = []
    const app = createWikiDistillRoutes((org, opts) => {
      seen.push(org)
      seen.push(opts.docsRoot ?? "")
      return { run: async () => fakeReport }
    })
    const res = await app.request("/distill?org=xzf-dev&docsPath=/tmp/repo/docs", { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(fakeReport)
    expect(seen).toEqual(["xzf-dev", "/tmp/repo/docs"])
  })

  it("POST /distill defaults org to 'default' and docsRoot to undefined (service falls back to cwd/docs)", async () => {
    let org = ""
    let docsRoot: string | undefined = "sentinel"
    const app = createWikiDistillRoutes((o, opts) => {
      org = o
      docsRoot = opts.docsRoot
      return { run: async () => fakeReport }
    })
    const res = await app.request("/distill", { method: "POST" })
    expect(res.status).toBe(200)
    expect(org).toBe("default")
    expect(docsRoot).toBeUndefined()
  })

  it("distiller explosion maps to the shared error contract shape", async () => {
    const app = createWikiDistillRoutes(() => {
      throw new Error("boom")
    })
    const res = await app.request("/distill", { method: "POST" })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe("INTERNAL_ERROR")
  })
})
