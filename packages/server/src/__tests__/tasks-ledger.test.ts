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
import { TasksService, TaskStatusConflictError } from "../services/tasks/tasks-service"
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
    body: JSON.stringify({ repo_group: ORG, name: `E2E_TD lg ${seq++}`, task_spec: {
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
  db.prepare(`INSERT INTO workspaces (id,name,repo_group,path,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
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
    // S2 (2026-09-20): 台账写没写成功进响应体 —— 前端 toast 从此吃真话。
    const body = (await r.json()) as { next_action: string; ledger_written: boolean }
    expect(body.next_action).toBe("awaiting_manual_trigger")
    expect(body.ledger_written).toBe(true)
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

// ── S1 (2026-09-20): 走查 ✗ 服务端硬闸 —— 前端 disabled 不再是唯一防线 ──
describe("S1 acceptance 硬闸", () => {
  async function postAccepted(taskId: string): Promise<Response> {
    return app.request(`/api/tasks/${taskId}/acceptance`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase_index: 1, round_index: 1, decision: "accepted" }),
    })
  }
  function decisionRows(taskId: string): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM task_phase_acceptances WHERE task_id = ?")
      .get(taskId) as { n: number }).n
  }

  it("G1: checks 有 ✗ → 409 硬闸，决策表零行、台账不写", async () => {
    const taskId = await newAwaiting(true, false)
    wb(taskId, "e2e-test-plan.md", PLAN)
    wb(taskId, "acceptance-checks-r1.md", renderChecksMd({ version: "1", round_index: 1, checks: {
      "walk:plan:1": { decision: "pass", note: "", at: "t" },
      "walk:plan:2": { decision: "fail", note: "按钮 404", at: "t" },
      "walk:plan:3": { decision: "fail", note: "台账没落", at: "t" },
    } }))
    const r = await postAccepted(taskId)
    expect(r.status).toBe(409)
    expect(((await r.json()) as { error: string }).error).toContain("走查存在 2 项 ✗ —— 服务端硬闸拦截，请改走打回")
    expect(decisionRows(taskId)).toBe(0)
    expect(has(taskId, "acceptance-ledger-r1.md")).toBe(false)
  })

  it("G2: 全 ✓ → 放行，决策生效且 ledger_written:true", async () => {
    const taskId = await newAwaiting(true, false)
    wb(taskId, "e2e-test-plan.md", PLAN)
    wb(taskId, "acceptance-checks-r1.md", renderChecksMd({ version: "1", round_index: 1, checks: {
      "walk:plan:1": { decision: "pass", note: "", at: "t" },
      "walk:plan:2": { decision: "pass", note: "", at: "t" },
    } }))
    const r = await postAccepted(taskId)
    expect(r.status).toBe(200)
    expect(((await r.json()) as { ledger_written: boolean }).ledger_written).toBe(true)
    expect(decisionRows(taskId)).toBe(1)
  })

  it("G3: 无 checks 文件 / 文件解析失败 → 放行（诚实降级，绝不误伤）", async () => {
    const noFile = await newAwaiting(true, false)
    wb(noFile, "e2e-test-plan.md", PLAN)
    expect((await postAccepted(noFile)).status).toBe(200)

    const corrupt = await newAwaiting(true, false)
    wb(corrupt, "e2e-test-plan.md", PLAN)
    wb(corrupt, "acceptance-checks-r1.md", "# 手改坏掉的\n```json\n{not-json\n```\n")
    expect((await postAccepted(corrupt)).status).toBe(200)
  })

  it("G4: 只 ⊘（无 ✗）→ 不触发硬闸；轮次不匹配的 accepted 仍由 service 409", async () => {
    const taskId = await newAwaiting(true, false)
    wb(taskId, "e2e-test-plan.md", PLAN)
    wb(taskId, "acceptance-checks-r1.md", renderChecksMd({ version: "1", round_index: 1, checks: {
      "walk:plan:1": { decision: "skip", note: "环境未就绪", at: "t" },
    } }))
    expect((await postAccepted(taskId)).status).toBe(200)
    // round_index 对不上 awaiting 轮 → 硬闸不抢话，service 的 409 语义原样返回
    const r = await app.request(`/api/tasks/${taskId}/acceptance`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase_index: 1, round_index: 9, decision: "accepted" }),
    })
    expect(r.status).toBe(409)
    expect(((await r.json()) as { error: string }).error).toContain("不匹配")
  })
})

// ── 2026-10-30：最终放行/退回的共用入口（窗口与主 Chat 同源）──────
describe("decideAcceptance (主 Chat 收口)", () => {
  function decisionRows(taskId: string): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM task_phase_acceptances WHERE task_id = ?")
      .get(taskId) as { n: number }).n
  }

  it("D1: accepted 省略轮次 → 取 awaiting 轮，台账落盘并如实返回未决项", async () => {
    const taskId = await newAwaiting(true, false)
    wb(taskId, "e2e-test-plan.md", PLAN)
    wb(taskId, "acceptance-checks-r1.md", renderChecksMd({ version: "1", round_index: 1, checks: {
      "walk:plan:1": { decision: "pass", note: "", at: "t" },
    } }))
    const out = await evidence.decideAcceptance(taskId, { decision: "accepted" })
    expect(out.result.next_action).toBe("awaiting_manual_trigger")
    expect(out.ledger_written).toBe(true)
    expect(out.undecided).toContain("walk:plan:3")
    expect(decisionRows(taskId)).toBe(1)
    expect(has(taskId, "acceptance-ledger-r1.md")).toBe(true)
  })

  it("D2: 存在 ✗ → 冲突错误（路由映射 409），决策零行、台账不写", async () => {
    const taskId = await newAwaiting(true, false)
    wb(taskId, "e2e-test-plan.md", PLAN)
    wb(taskId, "acceptance-checks-r1.md", renderChecksMd({ version: "1", round_index: 1, checks: {
      "walk:plan:2": { decision: "fail", note: "按钮 404", at: "t" },
    } }))
    await expect(evidence.decideAcceptance(taskId, { decision: "accepted" }))
      .rejects.toBeInstanceOf(TaskStatusConflictError)
    expect(decisionRows(taskId)).toBe(0)
    expect(has(taskId, "acceptance-ledger-r1.md")).toBe(false)
  })

  it("D3: rejected 缺 feedback → 决策前就拒，不落账", async () => {
    const taskId = await newAwaiting(true, false)
    wb(taskId, "e2e-test-plan.md", PLAN)
    await expect(evidence.decideAcceptance(taskId, { decision: "rejected" }))
      .rejects.toThrow(/必须给出反馈/)
    expect(decisionRows(taskId)).toBe(0)
  })
})

// keep type import referenced (guards against accidental unused-import churn)
export type _Snap = LedgerSnapshot

// ── 2026-10-30：归档只读回看 —— 显式历史轮坐标 ────────────────────────
// 验收台在 done 之后复用原三步界面，playbook / round-diff 需要按已验收轮取数，
// 而不是 awaiting 轮。这里钉住：显式 (phase, round) 可读；缺省仍 409（现行为不变）；
// 参数必须成对且为正整数；不存在的轮 → 409。
describe("历史轮只读坐标（归档回看）", () => {
  it("R1: playbook / round-diff 可指定 (phase, round)；缺省/非法参数语义不变", async () => {
    const taskId = await newAwaiting()
    wb(taskId, "e2e-test-plan.md", PLAN)
    // 先落一条 accepted：任务离开 awaiting 态（归档后的真实前提）。
    db.prepare(`INSERT INTO task_phase_acceptances (id, task_id, phase_index, round_index, decision, feedback, decided_at) VALUES (?,?,?,?,?,?,?)`)
      .run(`acc-${seq}`, taskId, 1, 1, "accepted", null, new Date().toISOString())

    // 非 awaiting 任务（已验收）带历史坐标 → 200（读盘上契约编译）
    const p = await app.request(`/api/tasks/${taskId}/playbook?phase_index=1&round_index=1`)
    expect(p.status).toBe(200)
    const pb = (await p.json()) as { sections: unknown[] }
    expect(pb.sections.length).toBeGreaterThan(0)

    // 缺省（不给坐标）仍走 awaiting 判据 → 409，现行为逐字不变
    expect((await app.request(`/api/tasks/${taskId}/playbook`)).status).toBe(409)
    // 参数必须成对 → 400
    expect((await app.request(`/api/tasks/${taskId}/playbook?phase_index=1`)).status).toBe(400)
    expect((await app.request(`/api/tasks/${taskId}/playbook?round_index=1`)).status).toBe(400)
    // 不存在的轮 → 409（不是空 200）
    expect((await app.request(`/api/tasks/${taskId}/playbook?phase_index=1&round_index=9`)).status).toBe(409)

    // 历史轮 diff：即使 commit map 为空也应是 200 + available:false（而非缺 awaiting 的 409）
    const d = await app.request(`/api/tasks/${taskId}/round-diff?phase_index=1&round_index=1`)
    expect(d.status).toBe(200)
    const body = (await d.json()) as { available: boolean; phaseIndex: number; roundIndex: number }
    expect(body.available).toBe(false)
    expect(body.phaseIndex).toBe(1)
    expect(body.roundIndex).toBe(1)
    // 缺省仍 409（当前无 awaiting / live 轮）
    expect((await app.request(`/api/tasks/${taskId}/round-diff`)).status).toBe(409)
  })
})

describe("两层验收：机器证据不可勾选（2026-10-31）", () => {
  it("rejects recordCheck on an evidence id, accepts a case id", async () => {
    const taskId = await newAwaiting()
    const plan = {
      version: "2",
      task_id: taskId,
      phase_index: 1,
      round_index: 1,
      generated_at: new Date().toISOString(),
      planner: "acceptance-planner",
      goal: "g",
      cases: [{
        id: "case:1", title: "场景", story: "", expect: "ok", tickets: [],
        steps: [{ kind: "observe", text: "看一眼" }], evidenceRefs: [],
      }],
      checks: [{ id: "check:unit", title: "单测", tickets: [], covers: [], evidenceRefs: [] }],
      coverage: { stories: [], acs: [], found: [], missing: [] },
      warnings: [],
    }
    evidence.setAcceptancePlanService({
      planState: () => ({ summary: { status: "ready" }, plan }),
    } as never)
    try {
      expect(() => evidence.recordCheck(taskId, { itemId: "check:unit", decision: "pass" }))
        .toThrow(/机器证据/)
      const ok = evidence.recordCheck(taskId, { itemId: "case:1", decision: "pass" })
      expect(ok.checks.checks["case:1"].decision).toBe("pass")
      expect(ok.checks.checks["check:unit"]).toBeUndefined()
    } finally {
      evidence.setAcceptancePlanService(null)
    }
  })
})
