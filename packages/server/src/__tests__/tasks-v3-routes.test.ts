// packages/server/src/__tests__/tasks-v3-routes.test.ts
//
// 04 — task create extension + skill-groups route (two-phase flow server side).
//
// Verifies (against real better-sqlite3 + applySchema + real filesystem, R1/R3/R5):
//   AC1: GET /api/skill-groups?org= — registry type=skill aggregated by group +
//        best-effort SKILL.md frontmatter `description` (absent → undefined, no
//        throw, SW-BP13); includes built-in {group:"default"} empty-marker (D17).
//   AC2: POST /api/tasks body accepts source_chat_session_id + task_type +
//        skill_groups[] + preset{org,projects}; success → tasks row task_spec
//        contains task_type/skill_groups ∧ home dir exists ∧ skills/ materialized
//        ∧ sessions.scope_id == task.id (D15/SG3). R3 three-way cross-validation.
//   AC3: POST with source_chat_session_id → exactly one draft bound to that
//        session (D15 regression lock, SW-BP1) at the POST level.
//   AC4: PUT /:id changing skill_groups or task_type → 409 (SW-BP9); PUT with
//        task_spec omitting skill_groups preserves the locked value (merge);
//        PUT other fields (name) → 200.
//   AC5: DELETE draft → home reaped (readdir → ENOENT); DELETE non-draft (ready)
//        → home preserved (ADR-0011).
//   AC6: skill_groups skills are NOT written into authoring_resources (R5 — avoid
//        double injection with the per-task plugin dir, D4).
//
// Anti-fake-run: real DB + applySchema (R1/R3/R5), Hono app.request (R3 API↔DB↔fs),
// data prefix E2E_TD_ (R7), assert response body + SQL + readdir (R4).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
import type Database from "better-sqlite3"
import { Hono } from "hono"
import fs from "fs"
import path from "path"
import os from "os"
import { closeDb, initDb } from "../db/connection"
import { AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { describePg, setupRegisteredPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture"
import { createTasksRoutes } from "../routes/tasks"
import { createSkillGroupsRoutes } from "../routes/skill-groups"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { PluginMaterializer, DEFAULT_SKILL_GROUP } from "../services/tasks/plugin-materializer"
import { ResourceManager } from "@octopus/shared"

const ORG = "e2e-td-04"

// P1 B2：tasks 落 PG（service 经注册的全局池读写）；sessions 仍 SQLite，
// 但 PG 的 tasks.source_chat_session_id→sessions 是硬 FK ⇒ 绑会话的造数需 PG 侧父行。
let pg: PgFixture | null = null

// ── Helpers ─────────────────────────────────────────────────────────

function newDb(): Database.Database {
  const db = initDb(":memory:")
  return db
}

function mkdtemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

/** Install a skill into a temp ResourceManager registry + filesystem.
 *  Mirrors plugin-materializer.test.ts / 07-resource-loading.test.ts. */
function installSkill(
  rm: ResourceManager,
  basePath: string,
  name: string,
  group: string,
  content: string,
): void {
  const skillDir = path.join(basePath, "installed", "skills", group, name)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), content, "utf-8")
  rm.registerInstalled({ name, type: "skill", group })
}

/** Insert a sessions row directly (bypass the DAO) to seed a source_chat_session_id.
 *  P1 B3: sessions 已迁 PG —— 路由/服务读写都认 PG 行；SQLite 侧仅留非迁移域表。
 *  （tasks.source_chat_session_id FK 与 scope_id/title 断言全部对 PG。） */
async function insertSession(db: Database.Database, sessionId: string, org: string): Promise<void> {
  const now = new Date().toISOString()
  await pg!.sql.unsafe(`
    INSERT INTO sessions (id, org, title, clone_name, session_type, is_active, is_deleted, created_at, updated_at)
    VALUES ($1, $2, $3, NULL, 'task-author', true, false, $4, $5)
  `, [sessionId, org, "E2E_TD session", now, now])
}

async function readTaskSpec(db: Database.Database, id: string): Promise<Record<string, unknown>> {
  const row = (await pg!.sql`SELECT task_spec #>> '{}' AS task_spec, version FROM tasks WHERE id = ${id}`)[0] as
    { task_spec: string; version: number }
  return { ...JSON.parse(row.task_spec), _version: row.version }
}

async function readAuthoringResources(db: Database.Database, id: string): Promise<unknown[]> {
  const row = (await pg!.sql`SELECT authoring_resources #>> '{}' AS authoring_resources FROM tasks WHERE id = ${id}`)[0] as
    { authoring_resources: string }
  return JSON.parse(row.authoring_resources)
}

// P1 B3: sessions 已迁 PG —— scope_id 断言直读随机库。
async function readScopeId(db: Database.Database, sessionId: string): Promise<string | null> {
  const row = (await pg!.sql`SELECT scope_id FROM sessions WHERE id = ${sessionId}`)[0] as
    { scope_id: string | null }
  return row.scope_id
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

/** P1 B2: writeManifestSnapshot 是 fire-and-forget（HTTP 返回时不 await）——
 *  tasks.getById 同步时代它事实上同步落盘；PG 之后变成真异步。内容断言改为
 *  轮询等文件收敛（语义不变：写 spec 后快照必须跟上）。 */
interface ManifestSnapshot {
  task_id?: string
  version: number
  spec: Record<string, unknown>
}
async function readManifestWhen(specPath: string, ready: (m: ManifestSnapshot) => boolean): Promise<ManifestSnapshot> {
  let last: ManifestSnapshot | null = null
  await vi.waitFor(() => {
    last = JSON.parse(fs.readFileSync(specPath, "utf-8")) as ManifestSnapshot
    expect(ready(last)).toBe(true)
  })
  return last as ManifestSnapshot
}

// ── Suite ──────────────────────────────────────────────────────────

describePg("04: task create extension + skill-groups route (integration)", () => {
  let db: Database.Database
  let app: Hono
  let rm: ResourceManager
  let rmBase: string
  let homeBase: string
  let taskHome: TaskHomeService
  let agentSessionDAO: AgentSessionDAO

  beforeAll(async () => {
    // P1 B2 双引擎 fixture：tasks 落 PG（注册为全局池 —— service 经 pgSql() 取），
    // sessions/home 仍在 SQLite `db`。
    pg = await setupRegisteredPgSchema()
    db = newDb()
    rmBase = mkdtemp("v3-routes-rm-")
    homeBase = mkdtemp("v3-routes-home-")
    rm = new ResourceManager({ basePath: rmBase })
    taskHome = new TaskHomeService(homeBase)
    const materializer = new PluginMaterializer(rm)
    agentSessionDAO = new AgentSessionDAO(pg!.sql)
    const sse = new SSEService()
    const service = new TasksService(
      db,
      sse,
      agentSessionDAO,
      taskHome,
      materializer,
      // task-workflow-handoff (ADR-0013): stub BuiltInWorkflowService recognizes
      // any ref containing "e2e-td" so the ready-gate resolver succeeds.
      { get: (ref: string) => ref.includes("e2e-td") ? { ref, content: "stub" } : null } as any,
    )
    app = new Hono()
    app.route("/api/tasks", createTasksRoutes(service, sse))
    app.route("/api/skill-groups", createSkillGroupsRoutes(rm))

    // Fixture skills (two groups + frontmatter descriptions).
    installSkill(
      rm, rmBase, "octo-skill-a", "e2e-td-grp1",
      "---\ndescription: Skill A does backend things\n---\n# Skill A\n\nBody A.",
    )
    installSkill(
      rm, rmBase, "octo-skill-b", "e2e-td-grp1",
      "---\ndescription: Skill B does frontend things\n---\n# Skill B\n\nBody B.",
    )
    installSkill(
      rm, rmBase, "octo-skill-c", "e2e-td-grp2",
      "# Skill C\n\nNo frontmatter here.",
    )
  })

  afterAll(async () => {
    await pg?.close()
    pg = null
    closeDb()
    cleanupDir(rmBase)
    cleanupDir(homeBase)
  })

  // ── AC1: GET /api/skill-groups ──────────────────────────────────────

  it("AC1: GET /api/skill-groups aggregates installed skills by group + default empty marker + best-effort descriptions", async () => {
    const res = await app.request("/api/skill-groups?org=" + ORG)
    expect(res.status).toBe(200)
    const data = await json<{ groups: Array<{ group: string; displayName: string; skills: Array<{ name: string; description?: string }> }> }>(res)
    const groups = data.groups
    // Built-in default empty-marker (D17) — always present, no skills.
    const def = groups.find((g) => g.group === DEFAULT_SKILL_GROUP)
    expect(def).toBeDefined()
    expect(def!.skills).toEqual([])
    // Installed group grp1 — two skills with frontmatter descriptions (SW-BP13).
    const grp1 = groups.find((g) => g.group === "e2e-td-grp1")
    expect(grp1).toBeDefined()
    const grp1Names = grp1!.skills.map((s) => s.name).sort()
    expect(grp1Names).toEqual(["octo-skill-a", "octo-skill-b"])
    const a = grp1!.skills.find((s) => s.name === "octo-skill-a")
    expect(a!.description).toBe("Skill A does backend things")
    // Installed group grp2 — one skill, NO frontmatter → description undefined (not a throw).
    const grp2 = groups.find((g) => g.group === "e2e-td-grp2")
    expect(grp2).toBeDefined()
    expect(grp2!.skills).toHaveLength(1)
    expect(grp2!.skills[0]!.name).toBe("octo-skill-c")
    expect(grp2!.skills[0]!.description).toBeUndefined()
  })

  // ── AC2: POST /api/tasks v3 create (home + materialize + scope_id) ──

  it("AC2: POST /api/tasks with task_type+skill_groups+preset → task_spec has fields ∧ home exists ∧ skills/ materialized ∧ scope_id linked", async () => {
    const sessionId = `e2e-td-sess-${Math.random().toString(36).slice(2, 10)}`
    await insertSession(db, sessionId, ORG)
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org: ORG,
        source_chat_session_id: sessionId,
        task_type: "coding",
        skill_groups: ["e2e-td-grp1", "e2e-td-grp2"],
        preset: { org: ORG, projects: ["proj-alpha"] },
        name: "E2E_TD v3 create",
      }),
    })
    expect(res.status).toBe(201)
    const task = await json<{
      id: string
      status: string
      org: string
      project_ids: string[]
      task_spec: { task_type?: string; skill_groups?: string[] }
    }>(res)
    expect(task.status).toBe("draft")
    expect(task.org).toBe(ORG)
    expect(task.project_ids).toEqual(["proj-alpha"])
    // Response task_spec carries the v3 fields.
    expect(task.task_spec.task_type).toBe("coding")
    expect(task.task_spec.skill_groups).toEqual(["e2e-td-grp1", "e2e-td-grp2"])

    // R3 DB cross-validation: task_spec.skill_groups/task_type persisted.
    const spec = await readTaskSpec(db, task.id)
    expect(spec.task_type).toBe("coding")
    expect(spec.skill_groups).toEqual(["e2e-td-grp1", "e2e-td-grp2"])

    // R3/R5 fs cross-validation: home dir exists + skills/ materialized.
    const home = taskHome.homePath(task.id)
    expect(fs.existsSync(home)).toBe(true)
    const skillsDir = path.join(home, "skills")
    expect(fs.existsSync(skillsDir)).toBe(true)
    const linked = fs.readdirSync(skillsDir).sort()
    // grp1 has 2 skills, grp2 has 1 → union of 3 materialized links.
    expect(linked).toEqual(["octo-skill-a", "octo-skill-b", "octo-skill-c"])
    // SKILL.md is readable through a link (junction on win, symlink on posix).
    expect(
      fs.readFileSync(path.join(skillsDir, "octo-skill-a", "SKILL.md"), "utf-8"),
    ).toContain("Body A.")

    // R3 DB cross-validation: sessions.scope_id == task.id (D15/SG3).
    expect(await readScopeId(db, sessionId)).toBe(task.id)
  })

  it("AC2b: POST with task_type + default group only → home created, no skills materialized (D17 empty marker)", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org: ORG,
        task_type: "generic",
        skill_groups: ["default"],
        name: "E2E_TD v3 default-only",
      }),
    })
    expect(res.status).toBe(201)
    const task = await json<{ id: string; task_spec: { skill_groups?: string[] } }>(res)
    expect(task.task_spec.skill_groups).toEqual(["default"])
    // Home still created (v3 task).
    const home = taskHome.homePath(task.id)
    expect(fs.existsSync(home)).toBe(true)
    // No skills materialized — default is an empty marker (D17).
    const skillsDir = path.join(home, "skills")
    expect(fs.existsSync(skillsDir)).toBe(true)
    expect(fs.readdirSync(skillsDir)).toEqual([])
  })

  // ── AC3: exactly one draft per source_chat_session_id (D15, SW-BP1) ──

  it("AC3: POST with source_chat_session_id → exactly one draft bound to that session", async () => {
    const sessionId = `e2e-td-sess-${Math.random().toString(36).slice(2, 10)}`
    await insertSession(db, sessionId, ORG)
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org: ORG,
        source_chat_session_id: sessionId,
        task_type: "coding",
        skill_groups: ["e2e-td-grp1"],
        name: "E2E_TD single-draft",
      }),
    })
    expect(res.status).toBe(201)
    const task = await json<{ id: string }>(res)
    // Exactly one active draft bound to this session (D15 regression lock).
    const drafts = (await pg!.sql`
      SELECT id FROM tasks WHERE source_chat_session_id = ${sessionId} AND deleted_at IS NULL
      ORDER BY created_at ASC
    `) as Array<{ id: string }>
    expect(drafts).toHaveLength(1)
    expect(drafts[0]!.id).toBe(task.id)
    // scope_id writeback is bidirectional (SG3).
    expect(await readScopeId(db, sessionId)).toBe(task.id)
  })

  // ── AC4: PUT lock — skill_groups/task_type immutable post-create (SW-BP9) ──

  it("AC4a: PUT changing skill_groups → 409 (locked post-create)", async () => {
    const create = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org: ORG,
        task_type: "coding",
        skill_groups: ["e2e-td-grp1"],
        name: "E2E_TD lock-sg",
      }),
    })
    const task = await json<{ id: string; version: number }>(create)
    const res = await app.request(`/api/tasks/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": String(task.version) },
      body: JSON.stringify({
        task_spec: { goal: "g", ac: ["ac1"], task_type: "coding", skill_groups: ["e2e-td-grp2"] },
      }),
    })
    expect(res.status).toBe(409)
  })

  it("AC4b: PUT changing task_type → 409 (locked post-create)", async () => {
    const create = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org: ORG,
        task_type: "coding",
        skill_groups: ["e2e-td-grp1"],
        name: "E2E_TD lock-tt",
      }),
    })
    const task = await json<{ id: string; version: number }>(create)
    const res = await app.request(`/api/tasks/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": String(task.version) },
      body: JSON.stringify({
        task_spec: { goal: "g", ac: ["ac1"], task_type: "generic", skill_groups: ["e2e-td-grp1"] },
      }),
    })
    expect(res.status).toBe(409)
  })

  it("AC4c: PUT task_spec omitting skill_groups preserves the locked value (merge, SW-BP2)", async () => {
    const create = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org: ORG,
        task_type: "coding",
        skill_groups: ["e2e-td-grp1", "e2e-td-grp2"],
        name: "E2E_TD merge",
      }),
    })
    const task = await json<{ id: string; version: number }>(create)
    // PUT with goal+ac but NO skill_groups/task_type in the body — the locked
    // values must be preserved (a taskSpecSchema.parse default would clobber to []).
    const res = await app.request(`/api/tasks/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": String(task.version) },
      body: JSON.stringify({ task_spec: { goal: "new goal", ac: ["ac1"] } }),
    })
    expect(res.status).toBe(200)
    const spec = await readTaskSpec(db, task.id)
    expect(spec.skill_groups).toEqual(["e2e-td-grp1", "e2e-td-grp2"])
    expect(spec.task_type).toBe("coding")
    expect(spec.goal).toBe("new goal")
  })

  it("AC4d: PUT re-sending the SAME skill_groups/task_type → 200 (no change = not a violation)", async () => {
    const create = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org: ORG,
        task_type: "coding",
        skill_groups: ["e2e-td-grp1"],
        name: "E2E_TD same-values",
      }),
    })
    const task = await json<{ id: string; version: number }>(create)
    const res = await app.request(`/api/tasks/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": String(task.version) },
      body: JSON.stringify({
        task_spec: {
          goal: "g2", ac: ["ac1"],
          task_type: "coding", skill_groups: ["e2e-td-grp1"],
        },
      }),
    })
    expect(res.status).toBe(200)
  })

  it("AC4e: PUT name (non-locked field) → 200 (other fields still editable)", async () => {
    const create = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org: ORG,
        task_type: "coding",
        skill_groups: ["e2e-td-grp1"],
        name: "E2E_TD rename-me",
      }),
    })
    const task = await json<{ id: string; version: number }>(create)
    const res = await app.request(`/api/tasks/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": String(task.version) },
      body: JSON.stringify({ name: "E2E_TD renamed" }),
    })
    expect(res.status).toBe(200)
    const body = await json<{ name: string; version: number }>(res)
    expect(body.name).toBe("E2E_TD renamed")
    expect(body.version).toBe(task.version + 1)
  })

  // ── AC5: DELETE draft → reap home; non-draft → preserve ─────────────

  it("AC5a: DELETE draft → home reaped (readdir → ENOENT)", async () => {
    const create = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org: ORG,
        task_type: "coding",
        skill_groups: ["e2e-td-grp1"],
        name: "E2E_TD reap-draft",
      }),
    })
    const task = await json<{ id: string }>(create)
    const home = taskHome.homePath(task.id)
    expect(fs.existsSync(home)).toBe(true) // home existed
    const res = await app.request(`/api/tasks/${task.id}`, { method: "DELETE" })
    expect(res.status).toBe(200)
    // R5 side-effect: home dir gone after draft delete.
    expect(fs.existsSync(home)).toBe(false)
  })

  it("AC5b: DELETE non-draft (ready) → home preserved (ADR-0011)", async () => {
    // Create a v3 task, fill goal+ac+confirmations, ready it (non-draft), then delete.
    const create = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org: ORG,
        task_type: "coding",
        skill_groups: ["e2e-td-grp1"],
        name: "E2E_TD ready-then-del",
      }),
    })
    const task = await json<{ id: string; version: number }>(create)
    // Set goal + ac + confirmations via spec-field (the authoring path).
    await app.request(`/api/tasks/${task.id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "goal", value: "E2E_TD ready goal" }),
    })
    await app.request(`/api/tasks/${task.id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "ac", value: ["E2E_TD ac1"] }),
    })
    await app.request(`/api/tasks/${task.id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "goal_confirmed", value: true }),
    })
    await app.request(`/api/tasks/${task.id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "ac_confirmed", value: ["E2E_TD ac1"] }),
    })
    // Gate (option A): simple v3 task requires a dispatch workflow_ref — bind one
    // via the real authoring PUT path (If-Match optimistic lock, re-GET for version).
    const beforePut = await app.request(`/api/tasks/${task.id}`)
    const current = await json<{ version: number }>(beforePut)
    const put = await app.request(`/api/tasks/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": String(current.version) },
      body: JSON.stringify({ workflow_ref: "e2e-td-v3/simple" }),
    })
    expect(put.status).toBe(200)
    const readyRes = await app.request(`/api/tasks/${task.id}/ready`, { method: "POST" })
    expect(readyRes.status).toBe(200)
    const home = taskHome.homePath(task.id)
    expect(fs.existsSync(home)).toBe(true)
    // Delete the ready task — home must be PRESERVED (not reaped).
    const delRes = await app.request(`/api/tasks/${task.id}`, { method: "DELETE" })
    expect(delRes.status).toBe(200)
    expect(fs.existsSync(home)).toBe(true)
  })

  // ── AC6: skill_groups NOT written into authoring_resources (D4/R5) ──

  it("AC6: POST with skill_groups → authoring_resources stays [] (no double injection)", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org: ORG,
        task_type: "coding",
        skill_groups: ["e2e-td-grp1", "e2e-td-grp2"],
        name: "E2E_TD no-double-inject",
      }),
    })
    expect(res.status).toBe(201)
    const task = await json<{ id: string }>(res)
    // R5: skill_groups must NOT leak into authoring_resources (D4 — that would
    // trigger the augmenter's full-text injection, double-loading skills already
    // exposed via the per-task plugin dir).
    expect(await readAuthoringResources(db, task.id)).toEqual([])
  })

  // ── 06: header rename syncs the bound session title (bugfix 2026-08-21) ──

  it("06: PUT {name} syncs the bound task-author session title (bugfix 2026-08-21)", async () => {
    const sessionId = `e2e-td-sess-${Math.random().toString(36).slice(2, 10)}`
    await insertSession(db, sessionId, ORG)
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org: ORG,
        source_chat_session_id: sessionId,
        name: "E2E_TD before-rename",
      }),
    })
    expect(res.status).toBe(201)
    const task = await json<{ id: string; version: number }>(res)
    expect(await readScopeId(db, sessionId)).toBe(task.id)

    // Header rename (the EditableTitle flow) → PUT {name}.
    const putRes = await app.request(`/api/tasks/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": String(task.version) },
      body: JSON.stringify({ name: "E2E_TD after-rename" }),
    })
    expect(putRes.status).toBe(200)

    // The bound session title follows — so the autosave seam (which writes
    // session.title → tasks.name) can never clobber the manual rename.
    // P1 B3: sessions 已迁 PG —— 标题断言直读随机库。
    const s = (await pg!.sql`SELECT title FROM sessions WHERE id = ${sessionId}`)[0] as {
      title: string
    }
    expect(s.title).toBe("E2E_TD after-rename")
  })

  it("06: PUT {name} on an UNBOUND task is a silent no-op (best-effort sync)", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org: ORG, name: "E2E_TD unbound" }),
    })
    expect(res.status).toBe(201)
    const task = await json<{ id: string; version: number }>(res)

    const putRes = await app.request(`/api/tasks/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": String(task.version) },
      body: JSON.stringify({ name: "E2E_TD unbound-renamed" }),
    })
    expect(putRes.status).toBe(200)
  })

  // ── 06: manifest.json — structured task_spec snapshot the agent reads ──

  it("06: POST create writes manifest.json; a spec-field goal save refreshes it", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org: ORG, task_type: "coding", name: "E2E_TD specjson" }),
    })
    expect(res.status).toBe(201)
    const task = await json<{ id: string }>(res)

    const specPath = path.join(taskHome.homePath(task.id), "manifest.json")
    expect(fs.existsSync(specPath)).toBe(true)
    const initial = await readManifestWhen(specPath, (m) => m.spec.goal === "")
    expect(initial.task_id).toBe(task.id)
    expect(initial.spec.goal).toBe("")

    // Agent binds goal via spec-field → snapshot refreshed.
    const sf = await app.request(`/api/tasks/${task.id}/spec-field`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: "goal", value: "E2E_TD 给服务加健康检查" }),
    })
    expect(sf.status).toBe(200)

    const refreshed = await readManifestWhen(
      specPath,
      (m) => m.version === 2 && m.spec.goal === "E2E_TD 给服务加健康检查",
    )
    expect(refreshed.version).toBe(2)
    expect(refreshed.spec.goal).toBe("E2E_TD 给服务加健康检查")
  })

  it("06: PUT task_spec writes manifest.json; legacy/v2 task (no home) is a silent no-op", async () => {
    // v3 task: home exists → manifest.json updated on PUT.
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org: ORG, task_type: "coding", name: "E2E_TD put-spec" }),
    })
    const task = await json<{ id: string; version: number }>(res)
    const putRes = await app.request(`/api/tasks/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": String(task.version) },
      body: JSON.stringify({ task_spec: { goal: "E2E_TD PUT goal", ac: ["a1"] } }),
    })
    expect(putRes.status).toBe(200)
    const specPath = path.join(taskHome.homePath(task.id), "manifest.json")
    const snap = await readManifestWhen(specPath, (m) => m.spec.goal === "E2E_TD PUT goal")
    expect(snap.spec.goal).toBe("E2E_TD PUT goal")
    expect(snap.spec.ac).toEqual(["a1"])

    // legacy/v2 task (no task_type → no home): the snapshot write is skipped
    // without throwing.
    const v2 = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org: ORG, name: "E2E_TD v2" }),
    })
    const v2Task = await json<{ id: string; version: number }>(v2)
    const v2Put = await app.request(`/api/tasks/${v2Task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": String(v2Task.version) },
      body: JSON.stringify({ task_spec: { goal: "E2E_TD v2 goal", ac: ["b1"] } }),
    })
    expect(v2Put.status).toBe(200)
  })

  // GET /:id/context's manifestContent serving + pre-rename spec.json read
  // fallback is covered at the fs level (task-home-service.test migration
  // cases) and end-to-end (e2e task-phase-acceptance AC3) — the route builds
  // its own TaskHomeService on the REAL homedir, so a unit app.request here
  // can't see the temp-injected homes.
})
