import { describe, it, expect } from "vitest"
import { createWikiGlobalMoveRoutes, type GlobalMoveRunner } from "../wiki-global-move"
import type { GlobalMoveReport } from "../../services/knowledge/wiki/global-move"

/**
 * S2 缝（票03）：全局搬家命令路由契约（createWikiMigrateRoutes 先例的薄封装验证）。
 * 真迁移行为在 S1（wiki-global-move.test.ts）已全量断言，此处只验路由面外部形状：
 * 缺省 dry-run、apply=true 透传、错误映射 500 不裸炸。fake runner = 独立真相（手搓报告）。
 */

const FAKE_REPORT: GlobalMoveReport = {
  dryRun: true,
  wikiMoves: [{ org: "xzf-dev", from: "a", to: "b", action: "move", commits: 2 }],
  rekey: { beforeTotal: 3, beforeByOrg: { "xzf-dev": 3 }, projectedTotal: 3, collisions: 0, applied: false },
  preferences: [],
  backupHint: "VACUUM INTO",
}

function fakeApp(applySeen: boolean[]) {
  const calls: Array<{ apply: boolean }> = []
  const makeMigrator = (apply: boolean): GlobalMoveRunner => {
    calls.push({ apply })
    applySeen.push(apply)
    return { run: async () => ({ ...FAKE_REPORT, dryRun: !apply }) }
  }
  return createWikiGlobalMoveRoutes(makeMigrator)
}

describe("POST /api/knowledge/wiki/global-move (ticket 03 command surface)", () => {
  it("缺省 dry-run：apply 透传 false，报告原样 JSON", async () => {
    const seen: boolean[] = []
    const app = fakeApp(seen)
    const res = await app.request("/global-move", { method: "POST" })
    expect(res.status).toBe(200)
    expect(seen).toEqual([false])
    const data = await res.json()
    expect(data.dryRun).toBe(true)
    expect(data.wikiMoves[0]).toMatchObject({ org: "xzf-dev", action: "move", commits: 2 })
    expect(data.backupHint).toContain("VACUUM INTO")
  })

  it("?apply=true 透传执行", async () => {
    const seen: boolean[] = []
    const app = fakeApp(seen)
    const res = await app.request("/global-move?apply=true", { method: "POST" })
    expect(res.status).toBe(200)
    expect(seen).toEqual([true])
    expect((await res.json()).dryRun).toBe(false)
  })

  it("迁移抛错（MOVE_VERIFY_FAILED 形态）映射 errorResponse 500，不裸炸", async () => {
    const app = createWikiGlobalMoveRoutes(() => ({
      run: async () => {
        throw new Error("MOVE_VERIFY_FAILED: git 史不一致")
      },
    }))
    const res = await app.request("/global-move?apply=true", { method: "POST" })
    // errorResponse 兜底：500 + 结构化错误体（raw 进 stderr，body 为固定 INTERNAL_ERROR——
    // 不泄漏内部串是既有 validators 纪律，这里只验不裸炸且有错误码）
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error.code).toBe("INTERNAL_ERROR")
  })
})
