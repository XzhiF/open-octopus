// packages/server/src/__tests__/tasks-playbook.test.ts
//
// 验收清单路由级集成（2026-10-31 删旧编译清单后）：GET /:id/playbook 的
// 唯一数据源是验收方案 acceptance-plan-rN.json。
//   · ready → 映射成两段 sections（场景 + 机器证据）；
//   · generating / failed / missing → 空 payload + plan 状态（不编译旧清单）；
//   · 缺 awaiting → 409；显式 (phase, round) → 历史轮只读；
//   · 当前 awaiting 读取会懒触发一次生成，历史轮不会。
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
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
import { AcceptancePlanService } from "../services/tasks/acceptance-plan-service"
import type { PlaybookPayload } from "../services/tasks/round-evidence-service"

const ORG = "e2e-td-playbook"
const WS_ID = "ws-pb-1"
const BATCH_REL = ".scratch/20260917/p-1"

let db: Database.Database
let app: Hono
let tmp: string
let taskHome: TaskHomeService
let evidence: RoundEvidenceService
let planService: AcceptancePlanService
let seq = 0

function writeBatch(taskId: string, rel: string, content: string): void {
  const abs = path.join(taskHome.homePath(taskId), BATCH_REL, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, "utf-8")
}

function writeStatus(taskId: string, status: "generating" | "failed", error?: string): void {
  writeBatch(taskId, "acceptance-plan-r1.status.json", JSON.stringify({
    status, started_at: new Date().toISOString(), ...(error ? { error } : {}),
  }))
}

function writeReadyPlan(taskId: string): void {
  const plan = {
    version: "2",
    task_id: taskId,
    phase_index: 1,
    round_index: 1,
    generated_at: new Date().toISOString(),
    planner: "acceptance-planner",
    goal: "验收方案目标",
    cases: [{
      id: "case:1",
      title: "用一次本轮交付",
      story: "US1",
      steps: [{ kind: "observe", text: "看到预期结果" }],
      expect: "结果符合目标",
      tickets: ["01-x"],
      evidenceRefs: [],
    }],
    checks: [{
      id: "check:unit", title: "单测", tickets: ["01-x"], covers: ["AC1"], evidenceRefs: [],
    }],
    coverage: { stories: [], acs: [], found: [], missing: [] },
    warnings: [],
  }
  writeBatch(taskId, "acceptance-plan-r1.json", JSON.stringify(plan, null, 2))
  writeBatch(taskId, "acceptance-plan-r1.status.json", JSON.stringify({
    status: "ready", finished_at: new Date().toISOString(),
    plan_path: `${BATCH_REL}/acceptance-plan-r1.json`,
  }))
}

async function newAwaitingTask(): Promise<string> {
  const res = await app.request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `E2E_TD pb ${seq++}`,
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

async function getPlaybook(taskId: string, target?: { phase: number; round: number }): Promise<{ status: number; body: PlaybookPayload }> {
  const qs = target ? `?phase_index=${target.phase}&round_index=${target.round}` : ""
  const r = await app.request(`/api/tasks/${taskId}/playbook${qs}`)
  return { status: r.status, body: (await r.json()) as PlaybookPayload }
}

beforeAll(() => {
  process.env.OCTOPUS_ACCEPTANCE_PLAN = "off" // 不真跑规划 Agent；只读盘上方案
  db = new Database(":memory:")
  applySchema(db)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "td-playbook-"))
  db.prepare(`INSERT INTO workspaces (id, name, repo_group, path, created_at, updated_at) VALUES (?, 'pb-ws', ?, ?, ?, ?)`)
    .run(WS_ID, ORG, path.join(tmp, "ws1"), new Date().toISOString(), new Date().toISOString())
  const sse = new SSEService()
  taskHome = new TaskHomeService(path.join(tmp, "home"))
  const tasksService = new TasksService(db, sse, new AgentSessionDAO(db), taskHome, undefined, { get: () => null } as never)
  const workspaceService = { getById: (id: string) => (id === WS_ID ? { id, path: path.join(tmp, "ws1") } : undefined) } as never
  evidence = new RoundEvidenceService(db, sse, tasksService, workspaceService, taskHome)
  planService = new AcceptancePlanService(db, sse, tasksService, workspaceService, taskHome, evidence)
  evidence.setAcceptancePlanService(planService)
  app = new Hono()
  app.route("/api/tasks", createTasksRoutes(tasksService, sse, undefined, evidence))
})
afterAll(() => {
  delete process.env.OCTOPUS_ACCEPTANCE_PLAN
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("GET /:id/playbook （方案唯一来源）", () => {
  it("P1: plan ready → mapped plan sections (cases + checks)", async () => {
    const taskId = await newAwaitingTask()
    writeReadyPlan(taskId)
    const { status, body } = await getPlaybook(taskId)
    expect(status).toBe(200)
    expect(body.available).toBe(true)
    expect(body.plan?.status).toBe("ready")
    expect(body.goal).toBe("验收方案目标")
    expect(body.sections.map((s) => s.title)).toEqual(["你要验的", "本轮验证了什么"])
    expect(body.sections[0].items[0]).toMatchObject({ id: "case:1", tier: "case" })
    expect(body.sections[1].items[0]).toMatchObject({ id: "check:unit", tier: "check" })
  })

  it("P2: generating → empty payload, no compiled checklist", async () => {
    const taskId = await newAwaitingTask()
    writeStatus(taskId, "generating")
    const { status, body } = await getPlaybook(taskId)
    expect(status).toBe(200)
    expect(body.available).toBe(false)
    expect(body.sections).toEqual([])
    expect(body.plan?.status).toBe("generating")
  })

  it("P3: failed → empty payload carries the error", async () => {
    const taskId = await newAwaitingTask()
    writeStatus(taskId, "failed", "boom")
    const { status, body } = await getPlaybook(taskId)
    expect(status).toBe(200)
    expect(body.available).toBe(false)
    expect(body.sections).toEqual([])
    expect(body.plan).toMatchObject({ status: "failed", error: "boom" })
  })

  it("P4: missing plan files → empty payload + status missing (no compile fallback)", async () => {
    const taskId = await newAwaitingTask()
    // 即便盘上有 spec / e2e 票 / round-report，也不再编译旧清单
    writeBatch(taskId, "spec.md", "# spec\n\n## Acceptance Criteria\n- AC1: x\n")
    writeBatch(taskId, "e2e-test-plan.md", "## 测试步骤\n\n### Step 1: S1\n- 操作: o1\n- 断言: e1\n")
    writeBatch(taskId, "round-report.md", "# R1\n\n## 票执行摘要\n全链打通\n")
    const { status, body } = await getPlaybook(taskId)
    expect(status).toBe(200)
    expect(body.available).toBe(false)
    expect(body.sections).toEqual([])
    expect(body.coverage).toEqual({ found: [], missing: [] })
    expect(body.plan?.status).toBe("missing")
  })

  it("P5: no awaiting round → 409", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_group: ORG, name: "E2E_TD no-await", task_spec: { format: "v4", goal: "g", ac: ["a"], phases: [{ index: 1, name: "P", slug: "pp", specPath: "./.scratch/20260917/pp/spec.md", workflowRef: "task-dev", inputValues: {} }] } }),
    })
    const draftId = ((await res.json()) as { id: string }).id
    const r = await app.request(`/api/tasks/${draftId}/playbook`)
    expect(r.status).toBe(409)
  })

  it("P6: archived target with plan → ready payload", async () => {
    const taskId = await newAwaitingTask()
    writeReadyPlan(taskId)
    const { status, body } = await getPlaybook(taskId, { phase: 1, round: 1 })
    expect(status).toBe(200)
    expect(body.available).toBe(true)
    expect(body.plan?.status).toBe("ready")
    expect(body.sections.length).toBeGreaterThan(0)
  })

  it("P7: archived target without plan → empty payload (no compiled read-back)", async () => {
    const taskId = await newAwaitingTask()
    writeBatch(taskId, "e2e-test-plan.md", "## 测试步骤\n\n### Step 1: S1\n- 操作: o1\n- 断言: e1\n")
    const { status, body } = await getPlaybook(taskId, { phase: 1, round: 1 })
    expect(status).toBe(200)
    expect(body.available).toBe(false)
    expect(body.sections).toEqual([])
    expect(body.plan?.status).toBe("missing")
  })

  it("P8: lazily triggers generation for the awaiting round, never for a target read", async () => {
    const spy = vi.spyOn(planService, "ensureForAwaiting").mockResolvedValue(undefined)
    const taskId = await newAwaitingTask()
    await getPlaybook(taskId)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockClear()
    await getPlaybook(taskId, { phase: 1, round: 1 })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
