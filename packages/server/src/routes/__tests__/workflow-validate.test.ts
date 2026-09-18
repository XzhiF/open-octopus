// workflow validate route — regression lock for the B2 404 (MOA panel called a
// route the server never had). Contract is pinned to web-app/lib/api-client.ts.
import { describe, it, expect } from "vitest"
import { Hono } from "hono"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createWorkflowRoutes } from "../workflow"

function makeApp(wsExists = true) {
  const dir = mkdtempSync(join(tmpdir(), "octo-wf-validate-"))
  const dao = {
    findById: (id: string) => (wsExists && id === "ws-1" ? { path: dir } : undefined),
  } as never
  const app = new Hono()
  app.route("/api/workspaces/:id/workflows", createWorkflowRoutes(dao, () => null as never))
  return { app, dir }
}

const VALID_YAML = `
apiVersion: octopus/v1
kind: Workflow
name: ok-flow
execution_mode: serial
nodes:
  - id: a
    type: bash
    bash: echo hi
`

const BAD_YAML = `
apiVersion: octopus/v1
kind: Workflow
name: bad-flow
nodes:
  - id: a
    type: no-such-executor
`

describe("POST /api/workspaces/:id/workflows/validate", () => {
  it("accepts a valid draft and reports parsed shape", async () => {
    const { app, dir } = makeApp()
    const res = await app.request("/api/workspaces/ws-1/workflows/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yaml: VALID_YAML }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.valid).toBe(true)
    expect(body.errors).toEqual([])
    expect(body.parsed.mode).toBe("serial")
    rmSync(dir, { recursive: true, force: true })
  })

  it("returns structured errors instead of throwing on an invalid draft", async () => {
    const { app, dir } = makeApp()
    const res = await app.request("/api/workspaces/ws-1/workflows/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yaml: BAD_YAML }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.valid).toBe(false)
    expect(body.errors[0].message).toMatch(/no-such-executor|invalid|expected/i)
    rmSync(dir, { recursive: true, force: true })
  })

  it("400s without a yaml body", async () => {
    const { app, dir } = makeApp()
    const res = await app.request("/api/workspaces/ws-1/workflows/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    rmSync(dir, { recursive: true, force: true })
  })
})
