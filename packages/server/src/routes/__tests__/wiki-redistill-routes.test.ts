import { describe, it, expect } from "vitest"
import { createWikiRedistillRoutes, type RedistillRunner } from "../wiki-redistill"
import type { RedistillReport } from "../../services/knowledge/wiki/redistill"

/**
 * S2 缝（票07）：重蒸馏命令路由契约（wiki-global-move-routes.test.ts 先例的薄封装验证）。
 * 真迁移行为在 S1（wiki-redistill.test.ts）全量断言；此处只验路由外部形状：
 * 缺省 dry-run、apply=true 透传、错误映射不裸炸。fake runner = 独立真相（手搓报告）。
 */

const FAKE_REPORT: RedistillReport = {
  dryRun: true,
  changed: false,
  pages: [
    { oldId: "wf-old", oldPath: "workflows/wf-old.md", newId: "wf-old", newPath: "topics/wf-old.md", action: "topic" },
    { oldId: "biz-glossary-engine-2", oldPath: "business/biz-glossary-engine-2.md", newId: "biz-glossary-engine", newPath: "concepts/biz-glossary-engine.md", action: "merged-concept", mergedFrom: ["biz-glossary-engine-2"] },
  ],
  retired: [{ from: "workflows/wf-old.md", to: "_retired/v2/workflows/wf-old.md" }],
  anchors: [{ ref: "wf-old#oct-009", anchor: "oct-009", oldPath: "workflows/wf-old.md", newPath: "topics/wf-old.md", carried: true }],
  log: { tableRows: 3 },
  db: { beforeTotal: 2 },
  commit: null,
  backupHint: "VACUUM INTO",
}

function fakeApp(seen: boolean[]) {
  const makeMigrator = (apply: boolean): RedistillRunner => {
    seen.push(apply)
    return { run: async () => ({ ...FAKE_REPORT, dryRun: !apply }) }
  }
  return createWikiRedistillRoutes(makeMigrator)
}

describe("POST /api/knowledge/wiki/redistill (ticket 07 command surface)", () => {
  it("缺省 dry-run：apply 透传 false，映射计划原样 JSON", async () => {
    const seen: boolean[] = []
    const res = await fakeApp(seen).request("/redistill", { method: "POST" })
    expect(res.status).toBe(200)
    expect(seen).toEqual([false])
    const data = await res.json()
    expect(data.dryRun).toBe(true)
    expect(data.pages).toHaveLength(2)
    expect(data.pages[1].mergedFrom).toEqual(["biz-glossary-engine-2"])
    expect(data.anchors[0]).toMatchObject({ ref: "wf-old#oct-009", carried: true })
    expect(data.backupHint).toContain("VACUUM INTO")
  })

  it("?apply=true 透传执行", async () => {
    const seen: boolean[] = []
    const res = await fakeApp(seen).request("/redistill?apply=true", { method: "POST" })
    expect(res.status).toBe(200)
    expect(seen).toEqual([true])
    expect((await res.json()).dryRun).toBe(false)
  })

  it("迁移抛错（REDISTILL_DB_VERIFY_FAILED / UNSUPPORTED_HUB 形态）映射 errorResponse 500，不裸炸", async () => {
    const app = createWikiRedistillRoutes(() => ({
      run: async () => {
        throw new Error("REDISTILL_DB_VERIFY_FAILED: 行数对账不符")
      },
    }))
    const res = await app.request("/redistill?apply=true", { method: "POST" })
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe("INTERNAL_ERROR")
  })
})
