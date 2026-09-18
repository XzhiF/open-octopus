// packages/server/src/__tests__/tasks-ledger.test.ts
//
// 台账机写 + 打回票重开(spec T04)。snapshot/writeLedger/augmentReject 在服务层
// 直测(文件突变是真覆盖点),外加一条 route accepted 端到端。避免拖入 dispatch/
// archiving 重链:accepted 走两-phase + autoAdvance=false → awaiting_manual_trigger
// (不开下一轮、不起工作流),ledger 仍能落盘。checks 走 .md 门。
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
import { RoundEvidenceService, type LedgerSnapshot } from "../services/tasks/round-evidence-service"
import { renderChecksMd } from "../services/tasks/playbook-compile"

const ORG = "e2e-td-ledger"
const WS_ID = "ws-lg-1"
const BATCH_REL = ".scratch/20260917/p-1"
let db: Database.Database
let app: Hono
let tmp: string
let taskHome: TaskHomeService
let evidence: RoundEvidenceService
let seq = 0

function wb(taskId: string, rel: string, content: string): void {
  const abs = path.join(taskHome.homePath(taskId), BATCH_REL, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, "utf-8")
}
function rb(taskId: string, rel: string): string {
  return fs.readFileSync(path.join(taskHome.homePath(taskId), BATCH_REL, rel), "utf-8")
}
function has(taskId: string, rel: string): boolean {
  return fs.existsSync(path.join(taskHome.homePath(taskId), BATCH_REL, rel))
}

async function newAwaiting(twoPhase = false, autoAdvance?: boolean): Promise<string> {
  const phases = twoPhase
    ? [
        { index: 1, name: "P1", slug: "p-1", specPath: `./${BATCH_REL}/spec.md`, workflowRef: "task-dev", inputValues: {} },
        { index: 2, name: "P2", slug: "p-2", specPath: `./.scratch/20260917/p-2/spec.md`, workflowRef: "task-dev", inputValues: {} },
      ]
    : [{ index: 1, name: "P1", slug: "p-1", specPath: `./${BATCH_REL}/spec.md`, workflowRef: "task-dev", inputValues: {} }]
  const r = await app.request("/api/tasks", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ org: ORG, name: `E2E_TD lg ${seq++}`, task_spec: {
      format: "v4", goal: "g", ac: ["a"], autoAdvance, phases,
    } }),
  })
  const id = ((await r.json()) as { id: string }).id
  // real flow flips draft→running on dispatch; we insert the exec row directly,
  // so mirror the status here (acceptance route requires ready|running, not draft).
  db.prepare(`UPDATE tasks SET status='running' WHERE id=?`).run(id)
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status, task_id, phase_index, round_index, start_commit_id, end_commit_id, started_at, completed_at, created_at, updated_at) VALUES (?,?,?,'task-dev','lg','completed',?,1,1,'{}','{}',?,?,?,?)`)
    .run(`exec-lg-${seq}`, WS_ID, ORG, id, now, now, now, now)
  return id
}

const PLAN = `## 测试步骤\n\n### Step 1: 剧本渲染 (spec-001)\n- 页面: http://h/tasks\n- 操作: 开验收台\n- 断言: 剧本 ≥3 步\n- 反假跑: 有预期\n\n### Step 2: 预览起停 (spec-002)\n- 操作: 起预览\n- 断言: ready\n- 反假跑: curl 命中\n\n### Step 3: 通过写台账 (spec-003)\n- 操作: 点通过\n- 断言: ledger 落盘\n`

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "td-ledger-"))
  fs.mkdirSync(path.join(tmp, "ws1"), { recursive: true })
  db.prepare(`INSERT INTO workspaces (id,name,org,path,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(WS_ID, "lg-ws", ORG, path.join(tmp, "ws1"), new Date().toISOString(), new Date().toISOString())
  const sse = new SSEService()
  taskHome = new TaskHomeService(path.join(tmp, "home"))
  const ts = new TasksService(db, sse, new AgentSessionDAO(db), taskHome, undefined, { get: () => null } as never)
  const wss = { getById: (id: string) => (id === WS_ID ? { id, path: path.join(tmp, "ws1") } : undefined) } as never
  evidence = new RoundEvidenceService(db, sse, ts, wss, taskHome)
  app = new Hono(); app.route("/api/tasks", createTasksRoutes(ts, sse, undefined, evidence))
})
afterAll(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

describe("T04 ledger + reopen", () => {
  it("L1: writeLedger(accepted) 聚合四事实落 .md", async () => {
    const taskId = await newAwaiting()
    wb(taskId, "e2e-test-plan.md", PLAN)
    wb(taskId, "round-report.md", "# R1\n\n## 票执行摘要\n全链打通\n")
    wb(taskId, "acceptance-checks-r1.md", renderChecksMd({ version: "1", round_index: 1, checks: {
      "walk:plan:1": { decision: "pass", note: "", at: "t" },
      "walk:plan:2": { decision: "skip", note: "环境未就绪", at: "t" },
    } }))
    const snap = await evidence.snapshotEvidence(taskId)
    expect(snap.roundIndex).toBe(1)
    const rel = evidence.writeLedger(snap, "accepted")
    expect(rel).toBe(`${BATCH_REL}/acceptance-ledger-r1.md`)
    const md = rb(taskId, "acceptance-ledger-r1.md")
    expect(md).toMatch(/# 验收台账 · Phase 1 Round 1 · ✅ 通过/)
    expect(md).toMatch(/全链打通/)
    expect(md).toMatch(/自动复检:.*未跑/)          // verify never ran
    expect(md).toMatch(/跑起来看:.*未使用/)          // preview never ran
    expect(md).toMatch(/✓1 · ✗0 · ⊘1 · 未决 1/)     // plan:3 undecided
    expect(md).toMatch(/⊘ 跳过项将进入下一轮/)        // carryover note (skip>0)
  })

  it("L2: augmentReject 追加未过项到 fix-feedback + 翻票 done→reopened", async () => {
    const taskId = await newAwaiting()
    wb(taskId, "issues/11-e2e-story.md", "# 11 — story\n\n## What to build\n端到端走查关键 UI 路径\n\n## Status\ndone\n\n## Acceptance Criteria\n- [x] AC1: a\n\n## Verification Method\n**Verification type**: browser E2E\n\n**Verification steps**:\n```bash\npnpm playwright test\n```\n\n**Pass criteria**: all PASS\n")
    wb(taskId, "acceptance-checks-r1.md", renderChecksMd({ version: "1", round_index: 1, checks: {
      "walk:11-e2e-story:0": { decision: "fail", note: "按钮点不动", at: "t" },
    } }))
    // fix-feedback-r1.md is written by service.acceptance in the real flow; stub it here.
    wb(taskId, "fix-feedback-r1.md", "# 打回反馈 · Round 1\n\n## 反馈\n\n按钮点不动\n")
    const snap = await evidence.snapshotEvidence(taskId)
    const { reopened } = evidence.augmentReject(snap)
    expect(reopened).toContain("11-e2e-story")
    const fb = rb(taskId, "fix-feedback-r1.md")
    expect(fb).toMatch(/## 未过项/)
    expect(fb).toMatch(/按钮点不动/)
    expect(rb(taskId, "issues/11-e2e-story.md")).toMatch(/## Status\nreopened/)
    // second augment: ticket already reopened → no-op, reopened empty
    const snap2 = await evidence.snapshotEvidence(taskId)
    expect(evidence.augmentReject(snap2).reopened).toEqual([])
  })

  it("L3: route accepted(两-phase/autoAdvance=false)→ ledger 落盘 + 决策仍成功", async () => {
    const taskId = await newAwaiting(true, false)
    wb(taskId, "e2e-test-plan.md", PLAN)
    const r = await app.request(`/api/tasks/${taskId}/acceptance`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase_index: 1, round_index: 1, decision: "accepted" }),
    })
    expect(r.status).toBe(200)
    expect(((await r.json()) as { next_action: string }).next_action).toBe("awaiting_manual_trigger")
    expect(has(taskId, "acceptance-ledger-r1.md")).toBe(true)
  })

  it("L4: reopen_tickets 非法名(../) 被 schema 拒 400", async () => {
    const taskId = await newAwaiting()
    wb(taskId, "e2e-test-plan.md", PLAN)
    const r = await app.request(`/api/tasks/${taskId}/acceptance`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase_index: 1, round_index: 1, decision: "rejected", feedback: "x", reopen_tickets: ["../../etc/passwd"] }),
    })
    expect(r.status).toBe(400)
  })
})

// keep type import referenced (guards against accidental unused-import churn)
export type _Snap = LedgerSnapshot
