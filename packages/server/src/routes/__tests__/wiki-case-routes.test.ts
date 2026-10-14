// packages/server/src/routes/__tests__/wiki-case-routes.test.ts
//
// P3 票03 — 判例退役路由（S2 契约面；票面第 4 行退役钮的执行落点）。
//
// Seam：Hono app.request 打 POST /case/retire——假 service（retireCase seam：可编程
// 抛 CaseArchiveError / 记录入参）。断言对外形状：状态码/响应体/INVALID_PARAM 面。
// 队列/编译真链已由 services/knowledge/__tests__/case-extract.test.ts（S1）覆盖，
// 本缝不重跑（五缝纪律：S2 只钉契约形状）。

import { describe, it, expect } from "vitest"
import { Hono } from "hono"
import { createWikiCaseRoutes } from "../wiki-case"
import { CaseArchiveError } from "../../services/knowledge/case-extract-service"

function makeApp(script: "ok" | "not_found" | "superseded" | "boom" = "ok") {
  const retireCalls: string[] = []
  const app = new Hono()
  app.route("/api/knowledge/wiki", createWikiCaseRoutes({
    retireCase: (caseId) => {
      retireCalls.push(caseId)
      if (script === "not_found") throw new CaseArchiveError("CASE_NOT_FOUND", `判例不在盘：${caseId}`, 404)
      if (script === "superseded") throw new CaseArchiveError("CASE_ALREADY_SUPERSEDED", `'${caseId}' 已退役`, 409)
      if (script === "boom") throw new Error("UNRELATED")
      return { queueTaskId: `car-${caseId}-01`, casePath: `cases/2026-10-14-${caseId}.md` }
    },
  }))
  return { app, retireCalls }
}

async function post(app: Hono, body: unknown) {
  return app.request("/api/knowledge/wiki/case/retire", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/knowledge/wiki/case/retire（S2·票03）", () => {
  it("合法 caseId ⇒ 202 {caseId, queueTaskId, casePath}（经 case-archive 通道异步生效，无审批态）", async () => {
    const { app, retireCalls } = makeApp("ok")
    const res = await post(app, { caseId: "case-72247e4f44" })
    expect(res.status).toBe(202)
    const json = await res.json()
    expect(json).toEqual({
      caseId: "case-72247e4f44",
      queueTaskId: "car-case-72247e4f44-01",
      casePath: "cases/2026-10-14-case-72247e4f44.md",
    })
    expect(retireCalls).toEqual(["case-72247e4f44"])
  })

  it("坏 body 面：非对象 400 / 缺 caseId 400 / 非 kebab id（含穿越串）400，且零触达服务", async () => {
    for (const bad of ["[]", "{}", { caseId: "" }, { caseId: "../../etc/passwd" }, { caseId: "CASE-X" }, { caseId: 42 }] as const) {
      const { app, retireCalls } = makeApp()
      const res = await post(app, bad)
      expect(res.status, JSON.stringify(bad)).toBe(400)
      const json = await res.json() as { error: { code: string } }
      expect(json.error.code).toBe("INVALID_PARAM")
      expect(retireCalls, "校验段零副作用").toHaveLength(0)
    }
  })

  it("未知判例 ⇒ 404 CASE_NOT_FOUND；已退役 ⇒ 409 CASE_ALREADY_SUPERSEDED（错误形状 {error:{code,message}}）", async () => {
    const nf = await post(makeApp("not_found").app, { caseId: "case-x" })
    expect(nf.status).toBe(404)
    expect(((await nf.json()) as { error: { code: string } }).error.code).toBe("CASE_NOT_FOUND")

    const sp = await post(makeApp("superseded").app, { caseId: "case-x" })
    expect(sp.status).toBe(409)
    expect(((await sp.json()) as { error: { code: string } }).error.code).toBe("CASE_ALREADY_SUPERSEDED")
  })

  it("非编码错误不吞成 4xx（UNRELATED ⇒ 框架 500，禁静默降级）", async () => {
    const { app } = makeApp("boom")
    const res = await post(app, { caseId: "case-x" })
    expect(res.status).toBe(500)
  })
})
