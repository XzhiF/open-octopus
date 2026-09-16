// packages/server/src/__tests__/tasks-playbook.test.ts
//
// 验收剧本路由级集成(spec T02 route + T04 checks 前置)。真 Hono app + 真 home
// 目录:往批次目录写 spec/e2e票/plan/report,GET /:id/playbook 断言编译产物 +
// 缺 awaiting→409 + 缺文件降级 200。编译器纯逻辑另见 playbook-compile.test.ts。
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { RoundEvidenceService } from "../services/tasks/round-evidence-service"
import type { PlaybookPayload } from "../services/tasks/round-evidence-service"

const ORG = "e2e-td-playbook"
const WS_ID = "ws-pb-1"
const BATCH_REL = ".scratch/20260917/p-1"

let db: Database.Database
let app: Hono
let tmp: string
let taskHome: TaskHomeService
let seq = 0

function writeBatch(taskId: string, rel: string, content: string): void {
  const abs = path.join(taskHome.homePath(taskId), BATCH_REL, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, "utf-8")
}

async function newAwaitingTask(): Promise<string> {
  const res = await app.request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      org: ORG, name: `E2E_TD pb ${seq++}`,
      task_spec: {
        format: "v4", goal: "g", ac: ["a1"],
        phases: [{ index: 1, name: "P1", slug: "p-1", specPath: `./${BATCH_REL}/spec.md`, workflowRef: "task-dev", inputValues: {} }],
      },
    }),
  })
  const taskId = ((await res.json()) as { id: string }).id
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status,
      task_id, phase_index, round_index, start_commit_id, end_commit_id,
      started_at, completed_at, created_at, updated_at)
    VALUES (?, ?, ?, 'task-dev', 'pb', 'completed', ?, 1, 1, '{}', '{}', ?, ?, ?, ?)
  `).run(`exec-pb-${seq}`, WS_ID, ORG, taskId, now, now, now, now)
  return taskId
}

async function getPlaybook(taskId: string): Promise<{ status: number; body: PlaybookPayload }> {
  const r = await app.request(`/api/tasks/${taskId}/playbook`)
  return { status: r.status, body: (await r.json()) as PlaybookPayload }
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "td-playbook-"))
  db.prepare(`INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, 'pb-ws', ?, ?, ?, ?)`)
    .run(WS_ID, ORG, path.join(tmp, "ws1"), new Date().toISOString(), new Date().toISOString())
  const sse = new SSEService()
  taskHome = new TaskHomeService(path.join(tmp, "home"))
  const tasksService = new TasksService(db, sse, new AgentSessionDAO(db), taskHome, undefined, { get: () => null } as never)
  const workspaceService = { getById: (id: string) => (id === WS_ID ? { id, path: path.join(tmp, "ws1") } : undefined) } as never
  const evidence = new RoundEvidenceService(db, sse, tasksService, workspaceService, taskHome)
  app = new Hono()
  app.route("/api/tasks", createTasksRoutes(tasksService, sse, undefined, evidence))
})
afterAll(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("GET /:id/playbook", () => {
  it("P1: full契约 → compiled steps over HTTP", async () => {
    const taskId = await newAwaitingTask()
    writeBatch(taskId, "spec.md", "# 剧本 Spec\n\n## Acceptance Criteria\n- AC1: x\n")
    writeBatch(taskId, "e2e-test-plan.md", "## 测试步骤\n\n### Step 1: 渲染 (spec-001)\n- 页面: http://h/tasks\n- 操作: 开验收台\n- 断言: 剧本 ≥3 步\n- 反假跑: 有预期句\n")
    writeBatch(taskId, "round-report.md", "# R1\n\n## 票执行摘要\n剧本编译打通全链\n")
    writeBatch(taskId, "issues/12-e2e-story.md", "# 12 — e2e\n\n## Status\ndone\n\n## Acceptance Criteria\n- [x] AC1: a\n- [x] AC2: b\n\n## Verification Method\n**Verification type**: browser E2E\n\n**Verification steps**:\n```bash\npnpm playwright test\n```\n\n**Pass criteria**: all PASS\n")
    const { status, body } = await getPlaybook(taskId)
    expect(status).toBe(200)
    expect(body.available).toBe(true)
    expect(body.goal).toMatch(/剧本编译/)
    expect(body.sections.flatMap((s) => s.items).length).toBeGreaterThan(0)
    expect(body.finePrint.find((f) => f.ticket === "12-e2e-story")?.acs).toHaveLength(2)
    expect(body.coverage.found.some((f) => f.includes("12-e2e"))).toBe(true)
  })

  it("P2: missing all contract files → available:false, still 200 (degrade not crash)", async () => {
    const taskId = await newAwaitingTask()
    const { status, body } = await getPlaybook(taskId)
    expect(status).toBe(200)
    expect(body.available).toBe(false)
    expect(body.sections).toHaveLength(0)
    expect(body.coverage.missing.length).toBeGreaterThan(0)
  })

  it("P3: no awaiting round → 409", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ org: ORG, name: "E2E_TD no-await", task_spec: { format: "v4", goal: "g", ac: ["a"], phases: [{ index: 1, name: "P", slug: "pp", specPath: "./.scratch/20260917/pp/spec.md", workflowRef: "task-dev", inputValues: {} }] } }),
    })
    const draftId = ((await res.json()) as { id: string }).id
    const r = await app.request(`/api/tasks/${draftId}/playbook`)
    expect(r.status).toBe(409)
  })

  it("P4: prior-round checks carryover resurfaces skip/fail over HTTP", async () => {
    const taskId = await newAwaitingTask()
    writeBatch(taskId, "e2e-test-plan.md", "## 测试步骤\n\n### Step 1: S1\n- 操作: o1\n- 断言: e1\n\n### Step 2: S2\n- 操作: o2\n- 断言: e2\n")
    writeBatch(taskId, "acceptance-checks-r1.json", JSON.stringify({ version: "1", checks: { "walk:plan:1": { decision: "skip", note: "上轮环境问题", at: "t" }, "walk:plan:2": { decision: "pass", note: "", at: "t" } } }))
    const { body } = await getPlaybook(taskId)
    // roundIndex=1 here; r1<1 false → carryover NOT read (same round). Force via a fresh awaiting at round 2? The service reads N<roundIndex only. With roundIndex 1, r1 is skipped. Assert that guard instead:
    expect(body.carryover).toHaveLength(0)
    // now simulate round 2
    db.prepare(`UPDATE executions SET round_index = 2 WHERE task_id = ?`).run(taskId)
    const { body: b2 } = await getPlaybook(taskId)
    expect(b2.carryover.map((c) => c.id)).toEqual(["co:walk:plan:1@r1"])
    expect(b2.carryover[0].op).toMatch(/o1/)
    // pass item (plan:2) 销账 — gone from normal sections
    expect(b2.sections.flatMap((s) => s.items).some((i) => i.id.includes("plan:2"))).toBe(false)
  })
})
