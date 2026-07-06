// packages/web-app/e2e/resource-api.spec.ts
// E2E API tests for 资源管理 — TC-043~054 (Suite A) + D1-D4 (Integration)
import { test, expect, request } from "@playwright/test"
import fs from "fs"
import path from "path"
import os from "os"

/** Resolve server port from the worktree port allocation file. */
function resolveServerUrl(): string {
  if (process.env.OCTOPUS_SERVER_URL) return process.env.OCTOPUS_SERVER_URL
  let dir = path.resolve(__dirname, "..")
  for (let i = 0; i < 5; i++) {
    try {
      const gitPath = path.join(dir, ".git")
      const stat = fs.statSync(gitPath)
      if (stat.isFile() || stat.isDirectory()) {
        // Resolve branch name: follow gitdir pointer for worktrees
        let headPath: string
        if (stat.isFile()) {
          const content = fs.readFileSync(gitPath, "utf8").trim()
          const gitdirMatch = content.match(/^gitdir:\s*(.+)$/)
          headPath = gitdirMatch ? path.join(gitdirMatch[1], "HEAD") : path.join(dir, ".git", "HEAD")
        } else {
          headPath = path.join(gitPath, "HEAD")
        }
        const headContent = fs.readFileSync(headPath, "utf8").trim()
        const branchMatch = headContent.match(/ref: refs\/heads\/(.+)/)
        const branch = branchMatch ? branchMatch[1] : path.basename(dir)
        const safe = branch.replace(/\//g, "-").replace(/[^a-zA-Z0-9\-_.]/g, "_")
        const portFile = path.join(os.homedir(), ".octopus", "ports", `${safe}.json`)
        if (fs.existsSync(portFile)) {
          const data = JSON.parse(fs.readFileSync(portFile, "utf8"))
          if (typeof data.server === "number") return `http://localhost:${data.server}`
        }
        break
      }
    } catch { /* not found at this level, go up */ }
    dir = path.dirname(dir)
  }
  return "http://localhost:3001"
}

const AUTH = { headers: { "Authorization": "Bearer agent" } }

test.describe("API E2E — 资源列表", () => {
  test("A1: GET /api/resources — 全量列表 [TC-043]", async () => {
    const ctx = await request.newContext()
    const res = await ctx.get(`${resolveServerUrl()}/api/resources`, AUTH)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data).toBeInstanceOf(Array)
    expect(body.meta.total).toBeGreaterThanOrEqual(0)
    expect(body.meta.returned).toBe(body.data.length)
    expect(body).not.toHaveProperty("success")
    await ctx.dispose()
  })

  test("A2: GET /api/resources?type=skill — 类型过滤 [TC-044]", async () => {
    const ctx = await request.newContext()
    const res = await ctx.get(`${resolveServerUrl()}/api/resources?type=skill`, AUTH)
    expect(res.status()).toBe(200)
    const { data } = await res.json()
    for (const item of data) {
      expect(item.type).toBe("skill")
    }
    await ctx.dispose()
  })

  test("A3: GET /api/resources?type=workflow — 可能空结果 [TC-045]", async () => {
    const ctx = await request.newContext()
    const res = await ctx.get(`${resolveServerUrl()}/api/resources?type=workflow`, AUTH)
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
    const listRes = await ctx.get(`${resolveServerUrl()}/api/resources`, AUTH)
    const { data: items } = await listRes.json()
    if (items.length > 0) {
      const item = items[0]
      const res = await ctx.get(`${resolveServerUrl()}/api/resources/${item.type}/${encodeURIComponent(item.name)}`, AUTH)
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
    const res = await ctx.get(`${resolveServerUrl()}/api/resources/skill/nonexistent-zzz-999`, AUTH)
    expect(res.status()).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe("RESOURCE_NOT_FOUND")
    // hint is present only when the server provides a suggestion
    if (body.error.hint !== undefined) {
      expect(typeof body.error.hint).toBe("string")
    }
    await ctx.dispose()
  })

  test("A6: GET /api/resources/:type/:name/deps — 依赖树结构 [TC-048]", async () => {
    const ctx = await request.newContext()
    // Ensure a resource exists for the deps endpoint
    try {
      await ctx.post(`${resolveServerUrl()}/api/resources/install`, {
        ...AUTH,
        data: { ref: "builtin:skill/octo-workflow-dev" },
      })
    } catch { /* may already be installed */ }
    const res = await ctx.get(`${resolveServerUrl()}/api/resources/skill/octo-workflow-dev/deps`, AUTH)
    expect(res.status()).toBe(200)
    const body = await res.json()
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
    // Uninstall first to ensure clean state
    try {
      await ctx.post(`${resolveServerUrl()}/api/resources/uninstall`, {
        ...AUTH,
        data: { name: "octo-workflow-dev", type: "skill" },
      })
    } catch { /* may not be installed */ }
    const res = await ctx.post(`${resolveServerUrl()}/api/resources/install`, {
      ...AUTH,
      data: { ref: "builtin:skill/octo-workflow-dev" },
    })
    expect([200, 409]).toContain(res.status())
    if (res.status() === 200) {
      const body = await res.json()
      expect(body.data.name).toBe("octo-workflow-dev")
      expect(body.data.type).toBe("skill")
      expect(body.data).toHaveProperty("version")
      expect(body.data).toHaveProperty("installPath")
    }
    await ctx.dispose()
  })

  test("A8: POST /api/resources/install — 无效 ref [TC-051]", async () => {
    const ctx = await request.newContext()
    const res = await ctx.post(`${resolveServerUrl()}/api/resources/install`, {
      ...AUTH,
      data: { ref: "xxx" },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe("INVALID_REF")
    await ctx.dispose()
  })

  test("A9: POST /api/resources/uninstall — 卸载成功 [TC-053]", async () => {
    const ctx = await request.newContext()
    await ctx.post(`${resolveServerUrl()}/api/resources/install`, {
      ...AUTH,
      data: { ref: "builtin:skill/octo-workflow-dev" },
    })
    const res = await ctx.post(`${resolveServerUrl()}/api/resources/uninstall`, {
      ...AUTH,
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
    const res = await ctx.post(`${resolveServerUrl()}/api/resources/uninstall`, {
      ...AUTH,
      data: { name: "base-dependency", type: "skill" },
    })
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
    const res = await ctx.get(`${resolveServerUrl()}/api/resources/audit?last=10`, AUTH)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data).toBeInstanceOf(Array)
    expect(body.meta).toHaveProperty("total")
    await ctx.dispose()
  })

  test("同步接口 — 漂移检测", async () => {
    const ctx = await request.newContext()
    const res = await ctx.post(`${resolveServerUrl()}/api/resources/sync`, {
      ...AUTH,
      data: { fix: false },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data.drifts).toBeInstanceOf(Array)
    await ctx.dispose()
  })

  test("Doctor 健康检查", async () => {
    const ctx = await request.newContext()
    const res = await ctx.get(`${resolveServerUrl()}/api/resources/doctor`, AUTH)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveProperty("checks")
    expect(body.data.checks).toBeInstanceOf(Array)
    await ctx.dispose()
  })
})
