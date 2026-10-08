// packages/server/src/__tests__/tasks-ledger-columns.test.ts
//
// 票09 验收台账分列（干预 / 快改 / 接管留痕）—— 文件内容级断言（真 git + 真 DB）。
// 三本账三源各自落进 acceptance-ledger-r{N}.md：
//   接管 = executions.takeover_at/takeover_delivered_at（08）
//   快改 = git 区间内 subject 前缀 `[quick-edit] ` 的提交（01 契约，gitOps.quickEditCommits 读）
//   人工干预 = agent_events event_type='intervention'（06 的计数 SQL 行级形态）
// harness 干预（executions.harness_summary）保持原位独立列，与「人工干预」并列不混称。
// 期望值来自票面 + git/DB 独立事实（防自证：区间里塞几枚 [quick-edit] 提交、seed 几条
// intervention 行，断言台账数 == 实物数，而非实现自算）。

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "child_process"
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
import { RoundEvidenceService, type RoundDiffPayload } from "../services/tasks/round-evidence-service"

const ORG = "e2e-td-lcol"
const WS_ID = "ws-lcol-1"
const BATCH_REL = ".scratch/20261008/p-1"
let db: Database.Database
let app: Hono
let tmp: string
let wsDir: string
let taskHome: TaskHomeService
let evidence: RoundEvidenceService
let seq = 0

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim()
}

function wb(taskId: string, rel: string, content: string): void {
  const abs = path.join(taskHome.homePath(taskId), BATCH_REL, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, "utf-8")
}
function rb(taskId: string, rel: string): string {
  return fs.readFileSync(path.join(taskHome.homePath(taskId), BATCH_REL, rel), "utf-8")
}

// ── 真 git 仓（每次独立目录，避免跨用例复用同仓触发 nothing-to-commit）：
//    k0（基线）→ 轮次产物 → 两枚 [quick-edit] 快改。返回 map key 名 = repo。
function buildRepo(repo: string): { start: string; end: string; quickEditShas: string[] } {
  const dir = path.join(wsDir, "projects", repo)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, "init", "-b", "main")
  git(dir, "config", "user.email", "lcol@t.io")
  git(dir, "config", "user.name", "LCOL")
  fs.writeFileSync(path.join(dir, "seed.txt"), "s\n")
  git(dir, "add", "-A"); git(dir, "commit", "-m", "k0")
  const start = git(dir, "rev-parse", "HEAD")
  // 一枚普通轮次产物提交（非快改）—— 不该进「快速修改」列。
  fs.writeFileSync(path.join(dir, "round.txt"), "r\n")
  git(dir, "add", "-A"); git(dir, "commit", "-m", "feat: round artifact")
  // 两枚 [quick-edit] 提交（01 契约：subject 前缀 + body trailers task/doer_session/repo）。
  const quickEditShas: string[] = []
  fs.writeFileSync(path.join(dir, "ui-button.tsx"), "radius 18\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-m", "[quick-edit] 收口按钮圆角\n\ntask: T1\ndoer_session: S1\nrepo: " + repo)
  quickEditShas.push(git(dir, "rev-parse", "HEAD"))
  fs.writeFileSync(path.join(dir, "ui-dialog.tsx"), "narrow\n")
  fs.writeFileSync(path.join(dir, "ui-button.tsx"), "radius 18\n// hover\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-m", "[quick-edit] 对话窄化 + hover 描边\n\ntask: T1\ndoer_session: S1\nrepo: " + repo)
  quickEditShas.push(git(dir, "rev-parse", "HEAD"))
  return { start, end: git(dir, "rev-parse", "HEAD"), quickEditShas }
}

/** v4 任务 + 一条 completed P1/R1 exec 行（awaiting_review），start/end 指向真仓区间。 */
async function seedAwaitingRound(opts: {
  repo: string; start: string; end: string
  harnessSummary?: string | null
}): Promise<string> {
  const specPath = `./${BATCH_REL}/spec.md`
  const r = await app.request("/api/tasks", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ org: ORG, name: `E2E_TD lcol ${seq++}`, task_spec: {
      format: "v4", goal: "g", ac: ["a"], autoAdvance: false,
      phases: [{ index: 1, name: "P1", slug: "p-1", specPath, workflowRef: "task-dev", inputValues: {} }],
    } }),
  })
  const id = ((await r.json()) as { id: string }).id
  db.prepare(`UPDATE tasks SET status='running' WHERE id=?`).run(id)
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status,
      task_id, phase_index, round_index, start_commit_id, end_commit_id, harness_summary,
      started_at, completed_at, created_at, updated_at)
    VALUES (?,?,?,'task-dev','lcol','completed',?,1,1,?,?,?,?,?,?,?)
  `).run(`exec-lcol-${seq}`, WS_ID, ORG, id,
    JSON.stringify({ [opts.repo]: opts.start }), JSON.stringify({ [opts.repo]: opts.end }),
    opts.harnessSummary === undefined ? '{"totalInterventions":5}' : opts.harnessSummary,
    now, now, now, now)
  return id
}

/** 给某 exec 落 N 条人工干预事件（node_executions + agent_events event_type='intervention'）。 */
function seedInterventions(execId: string, prompts: Array<{ node: string; name: string; prompt: string }>): void {
  for (const p of prompts) {
    const neId = `${execId}-${p.node}`
    db.prepare(`
      INSERT INTO node_executions (id, execution_id, node_id, node_type, status)
      VALUES (?, ?, ?, 'agent', 'completed')
    `).run(neId, execId, p.node)
    db.prepare(`
      INSERT INTO agent_events (node_execution_id, event_order, turn_index, event_type, timestamp,
        content, content_length, tool_is_error)
      VALUES (?, ?, 0, 'intervention', ?, ?, ?, 0)
    `).run(neId, Date.now() + Math.floor(Math.random() * 1000), Date.now(),
      JSON.stringify({ nodeId: p.node, nodeName: p.name, prompt: p.prompt }), p.prompt.length)
  }
}

function execRow(taskId: string): { id: string } {
  return db.prepare("SELECT id FROM executions WHERE task_id = ? AND phase_index = 1 LIMIT 1")
    .get(taskId) as { id: string }
}

const PLAN = `## 测试步骤\n\n### Step 1: 走查 (spec-001)\n- 操作: 开验收台\n- 断言: 台账分列\n- 反假跑: 有预期\n`

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "td-lcol-"))
  wsDir = path.join(tmp, "ws1")
  fs.mkdirSync(wsDir, { recursive: true })
  db.prepare(`INSERT INTO workspaces (id,name,org,path,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(WS_ID, "lcol-ws", ORG, wsDir, new Date().toISOString(), new Date().toISOString())
  const sse = new SSEService()
  taskHome = new TaskHomeService(path.join(tmp, "home"))
  const ts = new TasksService(db, sse, new AgentSessionDAO(db), taskHome, undefined, { get: () => null } as never)
  const wss = { getById: (id: string) => (id === WS_ID ? { id, path: wsDir } : undefined) } as never
  evidence = new RoundEvidenceService(db, sse, ts, wss, taskHome)
  app = new Hono(); app.route("/api/tasks", createTasksRoutes(ts, sse, undefined, evidence))
})
afterAll(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

describe("票09 台账分列 — 三本账三源文件内容级（真 git + 真 DB）", () => {
  it("含干预+快改+接管的 Round → 三列齐且数字与实物一致；harness 干预原位独立", async () => {
    const repo = "lc1"
    const { start, end, quickEditShas } = buildRepo(repo)
    const taskId = await seedAwaitingRound({ repo, start, end })
    const ex = execRow(taskId)
    seedInterventions(ex.id, [
      { node: "n1", name: "实现节点", prompt: "别动 Dialog 尺寸逻辑，直接换固定壳" },
      { node: "n2", name: "评审节点", prompt: "再看一眼 AC4 的台账列" },
    ])
    // 停流 + 交付（08 两列）—— 接管件判据。
    db.prepare(`UPDATE executions SET takeover_at = ?, takeover_delivered_at = ? WHERE id = ?`)
      .run("2026-10-08T02:00:00.000Z", "2026-10-08T03:00:00.000Z", ex.id)
    wb(taskId, "e2e-test-plan.md", PLAN)

    const snap = await evidence.snapshotEvidence(taskId)
    // payload 三列在 diff 上（ledger + web 预览同吃这份）。
    expect(snap.diff.manualInterventions).toHaveLength(2)
    expect(snap.diff.quickEdits).toHaveLength(quickEditShas.length) // 2 枚 [quick-edit]
    expect(snap.diff.takeover).toMatchObject({ at: "2026-10-08T02:00:00.000Z", deliveredAt: "2026-10-08T03:00:00.000Z" })

    const rel = evidence.writeLedger(snap, "accepted")
    expect(rel).toBe(`${BATCH_REL}/acceptance-ledger-r1.md`)
    const md = rb(taskId, "acceptance-ledger-r1.md")
    // 人工干预列 ×2 + 逐条摘要（节点名 + prompt 首行）。
    expect(md).toMatch(/## 人工干预/)
    expect(md).toMatch(/人工干预 ×2/)
    expect(md).toContain("⚑ 实现节点")
    expect(md).toContain("别动 Dialog 尺寸逻辑")
    expect(md).toContain("⚑ 评审节点")
    // 与 harness 干预分列：实物段 harness 干预仍是独立数字 5（来自 harness_summary）。
    expect(md).toMatch(/干预 5/)
    // 快速修改列 ×2 + 文件清单可溯。
    expect(md).toMatch(/## 快速修改/)
    expect(md).toMatch(/快速修改 ×2/)
    expect(md).toContain("[quick-edit]")
    expect(md).toContain("收口按钮圆角")
    expect(md).toContain("ui-button.tsx")
    // 接管标记：交付件未跑复检 → 如实标「自动复检未跑（接管件）」。
    expect(md).toMatch(/## 人工接管/)
    expect(md).toMatch(/人工交付 · 自动复检未跑（接管件）/)
    // 既有段零回退。
    expect(md).toMatch(/# 验收台账 · Phase 1 Round 1 · ✅ 通过/)
    expect(md).toMatch(/## 实物（真 git 区间）/)
    expect(md).toMatch(/## 自动复检/)
    expect(md).toMatch(/## 人工走查/)
    expect(md).toMatch(/## 决策/)
  })

  it("无任何人工介入的 Round → 三列如实归零/显示无，既有段完整", async () => {
    const repo = "lc2"
    const { start } = buildRepo(repo)
    // end=start → 无区间提交，也无快改/干预/接管。
    const taskId = await seedAwaitingRound({ repo, start, end: start, harnessSummary: null })
    wb(taskId, "e2e-test-plan.md", PLAN)
    const snap = await evidence.snapshotEvidence(taskId)
    expect(snap.diff.manualInterventions).toEqual([])
    expect(snap.diff.quickEdits).toEqual([])
    expect(snap.diff.takeover).toBeNull()
    const rel = evidence.writeLedger(snap, "accepted")
    expect(rel).toBe(`${BATCH_REL}/acceptance-ledger-r1.md`)
    const md = rb(taskId, "acceptance-ledger-r1.md")
    expect(md).toMatch(/人工干预 ×0/)
    expect(md).toMatch(/快速修改 ×0/)
    expect(md).toMatch(/接管 · 无/)
    // 既有段一个不少。
    for (const h of ["## 实物", "## 自动复检", "## 跑起来看", "## 人工走查", "## 决策"]) {
      expect(md).toContain(h)
    }
  })

  it("通过/打回两决策都写台账；best-effort 语义不动（无 batchRelDir → 返回 null 不抛）", async () => {
    const repo = "lc3"
    const { start, end } = buildRepo(repo)
    const taskId = await seedAwaitingRound({ repo, start, end })
    wb(taskId, "e2e-test-plan.md", PLAN)
    const snap = await evidence.snapshotEvidence(taskId)
    // accepted 与 rejected 都产出同一份三列文件（决策章不同）。
    expect(evidence.writeLedger(snap, "accepted")).not.toBeNull()
    const accMd = rb(taskId, "acceptance-ledger-r1.md")
    expect(accMd).toContain("✅ 通过")
    expect(accMd).toContain("快速修改 ×2")
    expect(evidence.writeLedger(snap, "rejected")).not.toBeNull()
    const rejMd = rb(taskId, "acceptance-ledger-r1.md")
    expect(rejMd).toContain("↩ 打回")
    expect(rejMd).toContain("快速修改 ×2") // 决策不改三列事实
  })

  it("接管件复检有真结果 → 真结果优先，不写「未跑」（ADR-0025 不设闸 · 对齐 08）", async () => {
    const repo = "lc4"
    const { start, end } = buildRepo(repo)
    const taskId = await seedAwaitingRound({ repo, start, end })
    const ex = execRow(taskId)
    db.prepare(`UPDATE executions SET takeover_at = ?, takeover_delivered_at = ? WHERE id = ?`)
      .run("2026-10-08T02:00:00.000Z", "2026-10-08T03:00:00.000Z", ex.id)
    wb(taskId, "e2e-test-plan.md", PLAN)
    const snap = await evidence.snapshotEvidence(taskId)
    // 注入一份真复检终态（passed）—— 台账接管列让位真结果。
    const snapWithVerify = { ...snap, verify: {
      task_id: taskId, execution_id: ex.id, phase_index: 1, round_index: 1,
      command: "pnpm test", cwd: ".", state: "passed" as const, started_at: "t", ended_at: "t",
      exit_code: 0, duration_ms: 1000, verdict_path: null,
    } }
    expect(evidence.writeLedger(snapWithVerify, "accepted")).not.toBeNull()
    const md = rb(taskId, "acceptance-ledger-r1.md")
    expect(md).toContain("接管件")
    expect(md).not.toContain("自动复检未跑（接管件）")
    expect(md).toContain("复检已跑")
  })
})

describe("票09 round-diff 端点携带三列（web 预览零新端点的服务端底座）", () => {
  async function diffOf(taskId: string): Promise<RoundDiffPayload> {
    const r = await app.request(`/api/tasks/${taskId}/round-diff`)
    expect(r.status).toBe(200)
    return (await r.json()) as RoundDiffPayload
  }

  it("GET /:id/round-diff → manualInterventions/quickEdits/takeover 齐", async () => {
    const repo = "lc5"
    const { start, end } = buildRepo(repo)
    const taskId = await seedAwaitingRound({ repo, start, end })
    const ex = execRow(taskId)
    seedInterventions(ex.id, [{ node: "n1", name: "实现节点", prompt: "改固定壳" }])
    db.prepare(`UPDATE executions SET takeover_at = ?, takeover_delivered_at = ? WHERE id = ?`)
      .run("2026-10-08T02:00:00.000Z", "2026-10-08T03:00:00.000Z", ex.id)
    const d = await diffOf(taskId)
    expect(d.manualInterventions).toHaveLength(1)
    expect(d.manualInterventions?.[0]).toMatchObject({ node: "实现节点" })
    expect(d.quickEdits).toHaveLength(2)
    expect(d.quickEdits?.[0]?.files.length).toBeGreaterThan(0)
    expect(d.takeover).toMatchObject({ at: "2026-10-08T02:00:00.000Z", deliveredAt: "2026-10-08T03:00:00.000Z" })
  })

  it("旧无介入区间 → 三列在 payload 上但如实归零/无（payload 形状含键）", async () => {
    const repo = "lc6"
    const { start } = buildRepo(repo)
    const taskId = await seedAwaitingRound({ repo, start, end: start, harnessSummary: null })
    const d = await diffOf(taskId)
    expect(d.manualInterventions).toEqual([])
    expect(d.quickEdits).toEqual([])
    expect(d.takeover).toBeNull()
  })
})
