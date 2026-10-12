import { describe, it, expect } from "vitest"
import { createWikiMigrateRoutes } from "../wiki-migrate"
import type { MigrationReport } from "../../services/knowledge/wiki/migrate"

/**
 * S3 routes 缝（archive-routes.test.ts 先例）：迁移命令 HTTP 入口 =
 * POST /api/knowledge/wiki/migrate?org= 薄封装，行为断言在 S1 迁移测试里；
 * 这里只锁契约：org 透传、report JSON 原样返回、错误走 errorResponse 形状。
 */

const fakeReport: MigrationReport = {
  compiled: [{ source: "projects/a.md", entryId: "prj-a", path: "projects/prj-a.md", commit: "abc", anchors: [{ legacy: "projects/a-001", anchor: "oct-001" }] }],
  skipped: ["workflows/b.md"],
  failed: [],
  totals: { entries: 1, rules: 1 },
}

describe("wiki migrate routes", () => {
  it("POST /migrate passes org through and returns the migration report", async () => {
    const seen: string[] = []
    const app = createWikiMigrateRoutes((org, opts) => {
      seen.push(org)
      seen.push(opts.glossaryMapPath ?? "")
      return { run: async () => fakeReport }
    })
    const res = await app.request("/migrate?org=xzf-dev&glossaryPath=/tmp/GLOSSARY-MAP.md", { method: "POST" })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual(fakeReport)
    expect(seen).toEqual(["xzf-dev", "/tmp/GLOSSARY-MAP.md"])
  })

  it("POST /migrate defaults org to 'default' and glossary path to undefined", async () => {
    let org = ""
    let glossaryMapPath: string | undefined = "sentinel"
    const app = createWikiMigrateRoutes((o, opts) => {
      org = o
      glossaryMapPath = opts.glossaryMapPath
      return { run: async () => fakeReport }
    })
    const res = await app.request("/migrate", { method: "POST" })
    expect(res.status).toBe(200)
    expect(org).toBe("default")
    expect(glossaryMapPath).toBeUndefined()
  })

  it("migrator explosion maps to the shared error contract shape", async () => {
    const app = createWikiMigrateRoutes(() => {
      throw new Error("boom")
    })
    const res = await app.request("/migrate?org=x", { method: "POST" })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe("INTERNAL_ERROR")
  })
})
