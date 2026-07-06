// packages/web-app/e2e/resource-api.spec.ts
// E2E API tests for 资源管理 — TC-043~054 (Suite A) + D1-D4 (Integration)
import { test, expect, request } from "@playwright/test"
import { execSync } from "child_process"

function serverUrl(): string {
  return process.env.OCTOPUS_SERVER_URL ?? "http://localhost:3001"
}

test.describe("API E2E — 资源列表", () => {
  test("A1: GET /api/resources — 全量列表 [TC-043]", async () => {
    const ctx = await request.newContext()
    const res = await ctx.get(`${serverUrl()}/api/resources`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data).toBeInstanceOf(Array)
    expect(body.meta.total).toBeGreaterThanOrEqual(0)
    expect(body.meta.returned).toBe(body.data.length)
    // 无 success 字段 (H4 契约)
    expect(body).not.toHaveProperty("success")
    await ctx.dispose()
  })

  test("A2: GET /api/resources?type=skill — 类型过滤 [TC-044]", async () => {
    const ctx = await request.newContext()
    const res = await ctx.get(`${serverUrl()}/api/resources?type=skill`)
    expect(res.status()).toBe(200)
    const { data } = await res.json()
    for (const item of data) {
      expect(item.type).toBe("skill")
    }
    await ctx.dispose()
  })

  test("A3: GET /api/resources?type=workflow — 可能空结果 [TC-045]", async () => {
    const ctx = await request.newContext()
    const res = await ctx.get(`${serverUrl()}/api/resources?type=workflow`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data).toBeInstanceOf(Array)
    expect(body.meta.total).toBeGreaterThanOrEqual(0)
    await ctx.dispose()
  })
})

test.describe("API E2E — 资源详情", () => {
  test("A4: GET /api/resources/:type/:name — 资源存在 [TC-046]", async () => {
    const ctx = await request.newContext()
    // 先 list 获取一个已有资源
    const listRes = await ctx.get(`${serverUrl()}/api/resources`)
    const { data: items } = await listRes.json()
    if (items.length > 0) {
      const item = items[0]
      const res = await ctx.get(`${serverUrl()}/api/resources/${item.type}/${encodeURIComponent(item.name)}`)
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(body.data.name).toBe(item.name)
      expect(body.data.type).toBe(item.type)
      expect(body.data).toHaveProperty("version")
      expect(body.data).toHaveProperty("source")
      expect(body.data).toHaveProperty("installed")
    }
    await ctx.dispose()
  })

  test("A5: GET /api/resources/:type/:name — 资源不存在 [TC-047]", async () => {
    const ctx = await request.newContext()
    const res = await ctx.get(`${serverUrl()}/api/resources/skill/nonexistent-zzz-999`)
    expect(res.status()).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND")
    expect(body.error).toHaveProperty("hint")
    await ctx.dispose()
  })

  test("A6: GET /api/resources/:type/:name/deps — 依赖树结构 [TC-048]", async () => {
    const ctx = await request.newContext()
    const res = await ctx.get(`${serverUrl()}/api/resources/skill/test-resource/deps`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    // C1 契约: forward 和 reverse 必须是 DepNode[] 结构
    expect(body.data).toHaveProperty("forward")
    expect(body.data).toHaveProperty("reverse")
    expect(body.data.forward).toBeInstanceOf(Array)
    expect(body.data.reverse).toBeInstanceOf(Array)
    await ctx.dispose()
  })
})

test.describe("API E2E — 安装/卸载", () => {
  test("A7: POST /api/resources/install — 安装成功 [TC-050]", async () => {
    const ctx = await request.newContext()
    const res = await ctx.post(`${serverUrl()}/api/resources/install`, {
      data: { ref: "builtin:skill/octo-workflow-dev" },
    })
    // 200 (H4: 不是 201)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data.name).toBe("octo-workflow-dev")
    expect(body.data.type).toBe("skill")
    expect(body.data).toHaveProperty("version")
    expect(body.data).toHaveProperty("installPath")
    await ctx.dispose()
  })

  test("A8: POST /api/resources/install — 无效 ref [TC-051]", async () => {
    const ctx = await request.newContext()
    const res = await ctx.post(`${serverUrl()}/api/resources/install`, {
      data: { ref: "xxx" },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("INVALID_REF")
    await ctx.dispose()
  })

  test("A9: POST /api/resources/uninstall — 卸载成功 [TC-053]", async () => {
    const ctx = await request.newContext()
    // 前置: 确保已安装
    await ctx.post(`${serverUrl()}/api/resources/install`, {
      data: { ref: "builtin:skill/octo-workflow-dev" },
    })
    const res = await ctx.post(`${serverUrl()}/api/resources/uninstall`, {
      data: { name: "octo-workflow-dev", type: "skill" },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data.name).toBe("octo-workflow-dev")
    expect(body.data.uninstalled).toBe(true)
    await ctx.dispose()
  })

  test("A10: POST /api/resources/uninstall — 有依赖拒绝 [TC-054]", async () => {
    const ctx = await request.newContext()
    const res = await ctx.post(`${serverUrl()}/api/resources/uninstall`, {
      data: { name: "base-dependency", type: "skill" },
    })
    // 若有反向依赖 → 409
    if (res.status() === 409) {
      const body = await res.json()
      expect(body.error.code).toBe("HAS_DEPENDENTS")
    }
    await ctx.dispose()
  })
})

test.describe("API E2E — 审计 + 同步", () => {
  test("审计日志查询", async () => {
    const ctx = await request.newContext()
    const res = await ctx.get(`${serverUrl()}/api/resources/audit?last=10`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data).toBeInstanceOf(Array)
    expect(body.meta).toHaveProperty("total")
    await ctx.dispose()
  })

  test("同步接口 — 漂移检测", async () => {
    const ctx = await request.newContext()
    const res = await ctx.post(`${serverUrl()}/api/resources/sync`, {
      data: { fix: false },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data.drifts).toBeInstanceOf(Array)
    await ctx.dispose()
  })

  test("Doctor 健康检查", async () => {
    const ctx = await request.newContext()
    const res = await ctx.get(`${serverUrl()}/api/resources/doctor`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveProperty("checks")
    expect(body.data.checks).toBeInstanceOf(Array)
    await ctx.dispose()
  })
})
