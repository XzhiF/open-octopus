// packages/server/src/routes/__tests__/wiki-draft-routes.test.ts
//
// P3 票04 — 草案 CRUD 路由（S2 契约面；票面 S2「草案 CRUD 端点（列出/读取/改写触发/退役）」）。
//
// Seam：Hono app.request 打 /api/knowledge/drafts 族——假 deps（可编程返回/抛
// SkillDraftError）。断言对外形状：状态码/响应体/错误码面。服务真链语义已由
// services/knowledge/__tests__/skill-draft-service.test.ts（S1）覆盖，本缝不重跑。
// 红线4：无授予端点——这里出现 grant 形状即越界（负断言钉住）。

import { describe, it, expect } from "vitest"
import { Hono } from "hono"
import type { SkillGrantReceipt } from "@octopus/shared"
import { createSkillDraftRoutes, type SkillDraftView, type WikiDraftRouteDeps } from "../wiki-draft"
import { SkillDraftError } from "../../services/knowledge/skill-draft-service"

const VIEW: SkillDraftView = {
  name: "flow-85153203c0",
  path: "drafts/skills/flow-85153203c0/SKILL.md",
  status: "draft",
  origin: "sequence-similar",
  source: "pack:task-aa04-a; pack:task-aa04-b",
  description: "跨 task 重复的依赖修复序列",
  updatedAt: "2026-10-14T01:00:00.000Z",
}

function makeApp(opts: Partial<WikiDraftRouteDeps> = {}) {
  const reviseCalls: Array<{ name: string; instruction: string }> = []
  const retireCalls: string[] = []
  const deps: WikiDraftRouteDeps = {
    list: () => [VIEW],
    read: name => (name === VIEW.name ? { ...VIEW, content: "## 步骤\n\n1. read\n" } : undefined),
    revise: async (name, instruction) => {
      reviseCalls.push({ name, instruction })
      return { name, status: "draft" as const, path: VIEW.path, updatedAt: "2026-10-14T02:00:00.000Z" }
    },
    retire: name => {
      retireCalls.push(name)
      return { name, status: "revoked" as const, path: VIEW.path }
    },
    ...opts,
  }
  const app = new Hono()
  app.route("/api/knowledge", createSkillDraftRoutes(deps))
  return { app, reviseCalls, retireCalls }
}

async function post(app: Hono, path: string, body?: unknown) {
  return app.request(`/api/knowledge${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })
}

describe("GET /api/knowledge/drafts（列出）", () => {
  it("200 {drafts:[view…]}——治理字段全面透出（含 revoked 留档行）", async () => {
    const { app } = makeApp()
    const res = await app.request("/api/knowledge/drafts")
    expect(res.status).toBe(200)
    const json = (await res.json()) as { drafts: Array<Record<string, unknown>> }
    expect(json.drafts).toHaveLength(1)
    expect(json.drafts[0]).toMatchObject({
      name: "flow-85153203c0",
      status: "draft",
      origin: "sequence-similar",
      source: "pack:task-aa04-a; pack:task-aa04-b",
    })
  })
})

describe("GET /api/knowledge/drafts/:name（读取）", () => {
  it("在盘草案 ⇒ 200 含 SKILL.md 全文 content；未知 ⇒ 404 DRAFT_NOT_FOUND；坏名 ⇒ 400 INVALID_PARAM", async () => {
    const { app } = makeApp()
    const ok = await app.request(`/api/knowledge/drafts/${VIEW.name}`)
    expect(ok.status).toBe(200)
    const json = (await ok.json()) as Record<string, unknown>
    expect(json.content).toContain("## 步骤")
    expect(json.status).toBe("draft")

    const nf = await app.request("/api/knowledge/drafts/flow-ghost")
    expect(nf.status).toBe(404)
    expect(((await nf.json()) as { error: { code: string } }).error.code).toBe("DRAFT_NOT_FOUND")

    const bad = await app.request("/api/knowledge/drafts/..%2Fescape")
    expect(bad.status).toBe(400)
  })
})

describe("POST /api/knowledge/drafts/:name/revise（对话改写触发）", () => {
  it("合法 instruction ⇒ 200 {name,status:'draft',path,updatedAt}（status 恒 draft 钉形）", async () => {
    const { app, reviseCalls } = makeApp()
    const res = await post(app, `/drafts/${VIEW.name}/revise`, { instruction: "步骤 2 加指数退避说明" })
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json).toEqual({ name: VIEW.name, status: "draft", path: VIEW.path, updatedAt: "2026-10-14T02:00:00.000Z" })
    expect(reviseCalls).toEqual([{ name: VIEW.name, instruction: "步骤 2 加指数退避说明" }])
  })

  it("缺/空 instruction ⇒ 400 INVALID_PARAM 零触达服务；服务错误按 code 翻码：404/409(DRAFT_GRANTED)/502(REVISE_EMPTY)", async () => {
    const { app, reviseCalls } = makeApp()
    const res = await post(app, `/drafts/${VIEW.name}/revise`, {})
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_PARAM")
    expect(reviseCalls).toHaveLength(0)

    const gr = await post(makeApp({
      revise: async () => { throw new SkillDraftError("DRAFT_GRANTED", "已授予", 409) },
    }).app, `/drafts/${VIEW.name}/revise`, { instruction: "改" })
    expect(gr.status).toBe(409)
    expect(((await gr.json()) as { error: { code: string } }).error.code).toBe("DRAFT_GRANTED")

    const empty = await post(makeApp({
      revise: async () => { throw new SkillDraftError("REVISE_EMPTY", "LLM 无响应", 502) },
    }).app, `/drafts/${VIEW.name}/revise`, { instruction: "改" })
    expect(empty.status).toBe(502)
    expect(((await empty.json()) as { error: { code: string } }).error.code).toBe("REVISE_EMPTY")
  })
})

describe("POST /api/knowledge/drafts/:name/retire（退役=status→revoked）", () => {
  it("合法 ⇒ 200 {name,status:'revoked',path}（留档不删——可溯源）；未知 404；已退役 409", async () => {
    const { app, retireCalls } = makeApp()
    const res = await post(app, `/drafts/${VIEW.name}/retire`)
    expect(res.status).toBe(200)
    expect((await res.json()) as Record<string, unknown>).toEqual({ name: VIEW.name, status: "revoked", path: VIEW.path })
    expect(retireCalls).toEqual([VIEW.name])

    const dup = await post(makeApp({
      retire: () => { throw new SkillDraftError("DRAFT_ALREADY_REVOKED", "已退役", 409) },
    }).app, `/drafts/${VIEW.name}/retire`)
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("DRAFT_ALREADY_REVOKED")

    const nf = await post(makeApp({
      retire: () => { throw new SkillDraftError("DRAFT_NOT_FOUND", "不在盘", 404) },
    }).app, `/drafts/flow-ghost/retire`)
    expect(nf.status).toBe(404)
  })
})

describe("红线4 负断言：路由面零授予端点（授予=票05）", () => {
  it("grant/revoke-clone/install 类路径 ⇒ 404（本票路由不含任何生效链动词）", async () => {
    const { app } = makeApp()
    for (const p of [`/drafts/${VIEW.name}/grant`, `/drafts/${VIEW.name}/revoke`, `/drafts/${VIEW.name}/install`, "/drafts/grant-all"] as const) {
      const res = await post(app, p, {})
      expect(res.status, p).toBe(404)
    }
  })
})

// ── P3 票05: 授予/撤销端点（S2 契约面；deps 可选——票04 形态零注册即 404 上面已钉）──

const RECEIPT: SkillGrantReceipt = {
  draftName: "flow-85153203c0",
  skillName: "flow-85153203c0",
  target: "workflow-operator",
  layer: "clone",
  status: "granted",
  grantedTo: ["workflow-operator"],
  version: "1.0.1",
  published: true,
  rolledBackTo: null,
  presetSync: { ok: true, installPath: "/x/installed/skills/built-in/flow-85153203c0", detail: "三账已更" },
  idempotent: false,
  receiptAt: "2026-10-15T08:00:00.000Z",
}

describe("POST /api/knowledge/drafts/:name/grant|revoke（票05 机械链 HTTP 面）", () => {
  it("grant ⇒ 200 回执逐字透出（分身名/版本号/预置源同步结果=票面回执卡字段）+ 调用体 (name, cloneName)", async () => {
    const grantCalls: Array<[string, string]> = []
    const { app } = makeApp({
      grant: async (name, cloneName) => { grantCalls.push([name, cloneName]); return RECEIPT },
    })
    const res = await post(app, `/drafts/${VIEW.name}/grant`, { cloneName: "workflow-operator" })
    expect(res.status).toBe(200)
    expect((await res.json()) as SkillGrantReceipt).toEqual(RECEIPT)
    expect(grantCalls).toEqual([[VIEW.name, "workflow-operator"]])
  })

  it("revoke ⇒ 200 回执；'*' 目标直通（授给所有分身的逆链）", async () => {
    const revokeCalls: Array<[string, string]> = []
    const { app } = makeApp({
      revoke: async (name, cloneName) => { revokeCalls.push([name, cloneName]); return { ...RECEIPT, status: "revoked" as const, grantedTo: [], rolledBackTo: "1.0.0" } },
    })
    const res = await post(app, `/drafts/${VIEW.name}/revoke`, { cloneName: "*" })
    expect(res.status).toBe(200)
    const json = (await res.json()) as SkillGrantReceipt
    expect(json.status).toBe("revoked")
    expect(json.rolledBackTo).toBe("1.0.0")
    expect(revokeCalls).toEqual([[VIEW.name, "*"]])
  })

  it("cloneName 缺/空/非字符串 ⇒ 400 INVALID_PARAM 零触达服务；坏草案名 ⇒ 400", async () => {
    const grantCalls: string[] = []
    const { app } = makeApp({
      grant: async (name) => { grantCalls.push(name); return RECEIPT },
    })
    const badBodies: unknown[] = [{}, { cloneName: "" }, { cloneName: 42 }, { cloneName: "  " }]
    for (const body of badBodies) {
      const res = await app.request(`/api/knowledge/drafts/${VIEW.name}/grant`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_PARAM")
    }
    const badName = await post(app, "/drafts/..%2Fescape/grant", { cloneName: "x" })
    expect(badName.status).toBe(400)
    expect(grantCalls).toHaveLength(0)
  })

  it("服务错误按 code 翻码透出：404 DRAFT_NOT_FOUND / 409 GRANT_NAME_CLASH / 409 DRAFT_REVOKED / 500 GRANT_PUBLISH_FAILED", async () => {
    const mk = (err: SkillDraftError) => makeApp({ grant: async () => { throw err } }).app
    const cases: Array<[SkillDraftError, number, string]> = [
      [new SkillDraftError("DRAFT_NOT_FOUND", "不在盘", 404), 404, "DRAFT_NOT_FOUND"],
      [new SkillDraftError("GRANT_NAME_CLASH", "撞槽", 409), 409, "GRANT_NAME_CLASH"],
      [new SkillDraftError("DRAFT_REVOKED", "终态", 409), 409, "DRAFT_REVOKED"],
      [new SkillDraftError("GRANT_PUBLISH_FAILED", "发版炸", 500), 500, "GRANT_PUBLISH_FAILED"],
      [new SkillDraftError("CLONE_NOT_FOUND", "无分身", 404), 404, "CLONE_NOT_FOUND"],
    ]
    for (const [err, status, code] of cases) {
      const res = await post(mk(err), `/drafts/${VIEW.name}/grant`, { cloneName: "workflow-operator" })
      expect(res.status, code).toBe(status)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code)
    }
  })

  it("列表视图透出 grantedTo（卡面选择器/撤销钮可用性数据源）", async () => {
    const { app } = makeApp({
      list: () => [{ ...VIEW, status: "granted", grantedTo: ["workflow-operator", "worker-u"] }],
    })
    const res = await app.request("/api/knowledge/drafts")
    const json = (await res.json()) as { drafts: Array<Record<string, unknown>> }
    expect(json.drafts[0].grantedTo).toEqual(["workflow-operator", "worker-u"])
  })
})
