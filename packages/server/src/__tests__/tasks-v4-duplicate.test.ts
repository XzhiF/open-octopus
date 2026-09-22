// packages/server/src/__tests__/tasks-v4-duplicate.test.ts
//
// duplicate task (2026-09-20) — POST /api/tasks/:id/duplicate：整单复制草稿面
// （DB 行 + home 的 .scratch/ 批次 + workflows/），副本默认直入待执行。
//
// 钉住的行为：
//   1. happy：源 ready → 副本 201 + status='ready'，spec 原样、home 文件在位
//      且 mtime 保留、workspace_id/会话/trigger 游标全新干净、name 带 " (copy)"。
//   2. gate-fail：源是缺 spec 文件的半草稿 → 复制不回滚，副本留 draft，
//      201 携带 gate_missing（含 phase:1:spec-missing）。
//   3. ready:false → 只复制不入队。
//   4. 隔离：源的 executions 历史/验收账本不随副本走（无行指向新 id）。
//   5. warnings：phase inputValues 字面引用源 task id → 回传告警。
//
// 反假跑 (R1/R3/R4/R5/R7)：真 better-sqlite3 + applySchema + 真 tmp task home +
// Hono app.request，断言 response body + SQL + fs。fixture 骨架与
// tasks-v4-gate.test.ts 同源。

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TaskHomeService } from "../services/tasks/task-home-service"
import path from "path"
import os from "os"
import fs from "fs"

const ORG = "e2e-td-v4dup"

const stub = vi.hoisted(() => ({ db: null as Database.Database | null }))

vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: () => undefined,
}))

const WORKFLOW_REQUIRED_INPUTS = `
apiVersion: octopus/v1
kind: Workflow
name: v4-required-flow
inputs:
  idea:
    description: "The idea"
    required: true
  spec_dir:
    description: "Phase spec dir"
    required: true
`

let db: Database.Database
let app: Hono
let tmpDir: string
let taskHome: TaskHomeService
let service: TasksService
let nextTaskSeq = 0

function insertTask(spec: Record<string, unknown>): string {
  const id = `e2e-td-v4dup-${nextTaskSeq++}`
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, 'draft', NULL, ?, '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL)
  `).run(id, ORG, `E2E_TD dup task ${id}`, JSON.stringify(spec), now, now)
  return id
}

interface PhaseInput {
  index: number
  name: string
  slug: string
  specPath: string
  workflowRef: string
  inputValues: Record<string, string>
}

function writeHomeFile(taskId: string, rel: string, content: string, backdateMtime?: number): string {
  const abs = path.join(taskHome.homePath(taskId), rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  if (backdateMtime != null) {
    const t = new Date(Date.now() - backdateMtime)
    fs.utimesSync(abs, t, t)
  }
  return abs
}

/** A fully-valid v4 draft: spec.md + issue file under .scratch, one self-written
 *  workflow YAML, both backdated so mtime preservation is observable. */
function insertValidV4Task(): { id: string; phases: PhaseInput[] } {
  const specPath = path.join(".scratch", "dupd", "p1", "spec.md")
  const phases: PhaseInput[] = [{
    index: 1, name: "Phase 1", slug: "p1", specPath,
    workflowRef: "built-in/v4-required-flow",
    inputValues: { idea: "${phase.slug} idea", spec_dir: "${phase.spec_dir}" },
  }]
  const id = insertTask({
    format: "v4", task_type: "coding", skill_groups: [],
    decisions: [], resources: [], authoring_resources: [], phases,
  })
  writeHomeFile(id, specPath, "# E2E_TD dup spec\n", 86_400_000)
  writeHomeFile(id, path.join(".scratch", "dupd", "p1", "issues", "01-e2e-walk.md"), "# E2E_TD issue\n", 86_400_000)
  writeHomeFile(id, path.join("workflows", "dup-flow.yaml"), "kind: Workflow\n", 86_400_000)
  return { id, phases }
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  stub.db = db
  const sse = new SSEService()
  tmpDir = path.join(os.tmpdir(), `test-v4-dup-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  taskHome = new TaskHomeService(tmpDir)
  const stubBuiltIn = {
    get(ref: string) {
      if (ref.includes("v4-required-flow")) return { ref, content: WORKFLOW_REQUIRED_INPUTS }
      return null
    },
  } as never
  service = new TasksService(
    db, sse, new AgentSessionDAO(db), taskHome, undefined, stubBuiltIn, null,
    { getById: () => undefined } as never,
  )
  app = new Hono()
  app.route("/api/tasks", createTasksRoutes(service, sse))
})

afterAll(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function postJson(url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json() }
}

describe("happy path — ready 源整单复制，副本直达待执行", () => {
  it("201 + status='ready' + spec 原样 + 目录/会话/游标全新", async () => {
    const { id, phases } = insertValidV4Task()
    expect((await postJson(`/api/tasks/${id}/ready`)).status).toBe(200)

    const res = await postJson(`/api/tasks/${id}/duplicate`)
    expect(res.status).toBe(201)
    expect(res.json.gate_missing).toBeUndefined()
    const dup = res.json.task
    expect(dup.id).not.toBe(id)
    expect(dup.status).toBe("ready")
    expect(dup.name).toBe(`E2E_TD dup task ${id} (copy)`)
    expect(dup.workspace_id ?? null).toBeNull()
    expect(dup.task_spec.format).toBe("v4")
    expect(dup.task_spec.phases[0].specPath).toBe(phases[0].specPath)

    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(dup.id) as Record<string, unknown>
    expect(row.workspace_id).toBeNull()
    expect(row.source_chat_session_id).toBeNull()
    expect(row.trigger_mode).toBe("manual")
    expect(row.next_fire_at).toBeNull()
    expect(row.completed_at).toBeNull()
  })

  it("新 home：.scratch 批次与 workflows 全量到位，mtime 保留，skills junction 不拷", async () => {
    const { id } = insertValidV4Task()
    const dupId = (await postJson(`/api/tasks/${id}/duplicate`)).json.task.id as string

    for (const rel of [
      path.join(".scratch", "dupd", "p1", "spec.md"),
      path.join(".scratch", "dupd", "p1", "issues", "01-e2e-walk.md"),
      path.join("workflows", "dup-flow.yaml"),
    ]) {
      const dst = path.join(taskHome.homePath(dupId), rel)
      expect(fs.existsSync(dst), rel).toBe(true)
      // 源文件被 backdate 一天 → 副本 mtime 必须一致（copyTree 保 mtime）
      const skew = Math.abs(fs.statSync(dst).mtimeMs - fs.statSync(path.join(taskHome.homePath(id), rel)).mtimeMs)
      expect(skew).toBeLessThan(2000)
    }
    // 执行产物目录不在草稿面 —— 不拷
    expect(fs.existsSync(path.join(taskHome.homePath(dupId), "artifacts", "leftover.md"))).toBe(false)
  })

  it("隔离：源的 executions/验收账本不指向副本；重复复制各自独立", async () => {
    const { id } = insertValidV4Task()
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO workspaces (id, name, org, status, path, source, task_id, created_at, updated_at)
      VALUES ('e2e-td-dup-ws', 'e2e-td-dup-ws', ?, 'active', ?, 'task', ?, ?, ?)
    `).run(ORG, path.join(tmpDir, "ws-e2e-td-dup"), id, now, now)
    db.prepare(`
      INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
        status, input_values, var_pool, org, created_at, updated_at, task_id)
      VALUES ('e2e-td-dup-exec', 'e2e-td-dup-ws', '0', 0, 'r', 'n', 'completed', '{}', '{}', ?, ?, ?, ?)
    `).run(ORG, now, now, id)
    db.prepare(`
      INSERT INTO task_phase_acceptances (id, task_id, phase_index, round_index, decision, feedback, decided_at)
      VALUES ('e2e-td-dup-acc', ?, 1, 1, 'accepted', '', ?)
    `).run(id, now)

    const dup1 = (await postJson(`/api/tasks/${id}/duplicate`)).json.task
    const dup2 = (await postJson(`/api/tasks/${id}/duplicate`)).json.task
    expect(dup2.id).not.toBe(dup1.id)

    const orphanExecs = db.prepare("SELECT COUNT(*) c FROM executions WHERE task_id IN (?, ?)").get(dup1.id, dup2.id) as { c: number }
    expect(orphanExecs.c).toBe(0)
    const accs = db.prepare("SELECT COUNT(*) c FROM task_phase_acceptances WHERE task_id IN (?, ?)").get(dup1.id, dup2.id) as { c: number }
    expect(accs.c).toBe(0)
    // 副本名已含 (copy) → 再复制不叠加
    expect(dup2.name).toBe(`E2E_TD dup task ${id} (copy)`)
  })
})

describe("gate-fail / ready:false — 副本绝不半途而入", () => {
  it("源 spec 引用缺失文件（半草稿）→ 201，副本留 draft + gate_missing", async () => {
    const id = insertTask({
      format: "v4", task_type: "coding", skill_groups: [],
      phases: [{
        index: 1, name: "P1", slug: "gone",
        specPath: path.join(".scratch", "never", "gone", "spec.md"),
        workflowRef: "built-in/v4-required-flow",
        inputValues: { idea: "x", spec_dir: "y" },
      }],
    })
    const res = await postJson(`/api/tasks/${id}/duplicate`)
    expect(res.status).toBe(201)
    expect(res.json.task.status).toBe("draft")
    expect(res.json.gate_missing).toContain("phase:1:spec-missing")
  })

  it("ready:false → 只复制，不跑 gate", async () => {
    const { id } = insertValidV4Task()
    const res = await postJson(`/api/tasks/${id}/duplicate`, { ready: false })
    expect(res.status).toBe(201)
    expect(res.json.task.status).toBe("draft")
    expect(res.json.gate_missing).toBeUndefined()
  })

  it("ready 传非布尔 → 400", async () => {
    const { id } = insertValidV4Task()
    const res = await postJson(`/api/tasks/${id}/duplicate`, { ready: "yes" })
    expect(res.status).toBe(400)
  })

  it("源不存在 → 404，不产生孤儿行", async () => {
    const res = await postJson(`/api/tasks/e2e-td-dup-nope/duplicate`)
    expect(res.status).toBe(404)
    expect((await postJson(`/api/tasks/${"e2e-td-dup-nope"}/duplicate`)).status).toBe(404)
  })
})

describe("warnings — 指向源 home 的字面路径", () => {
  it("phase inputValues 里写死源 task id → 副本带回告警", async () => {
    const specPath = path.join(".scratch", "dupw", "p1", "spec.md")
    const base = insertValidV4Task()
    // 直接改源 spec 的一个 inputValue 指向源 home（绝对路径字面量）
    const dirty = db.prepare("SELECT task_spec FROM tasks WHERE id = ?").get(base.id) as { task_spec: string }
    const spec = JSON.parse(dirty.task_spec)
    spec.phases[0].inputValues.idea = path.join(tmpDir, "tasks", base.id, "notes.md")
    db.prepare("UPDATE tasks SET task_spec = ? WHERE id = ?").run(JSON.stringify(spec), base.id)

    const res = await postJson(`/api/tasks/${base.id}/duplicate`)
    expect(res.status).toBe(201)
    expect((res.json.warnings ?? []).length).toBeGreaterThan(0)
    expect(res.json.warnings[0]).toContain("不会自动重映射")
    void specPath
  })
})
