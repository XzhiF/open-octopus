// packages/server/src/__tests__/clone-chat-repo-sync-gate.test.ts
//
// 特性A chat 门（routes/clone/index.ts v4 context 块，2026-09-08）：
//   1. v4 有项目 + 无快照 → 补触发 syncProjectsForTask，且 waitUntilIdle 在
//      runtime.chat 之前被 await（门先于分析）。
//   2. 新鲜度标注随本轮 writeContextFile 落盘（fake HOME 下的真 context.md
//      含「仓库新鲜度」行）。
//   3. v3 行（无 format:"v4"）→ 门整体跳过（零 sync 调用、无新鲜度行）。
//   4. deps 缺省（旧 22 处调用方形状）→ 门不存在，turn 正常跑完。
//
// Anti-fake-run: real better-sqlite3 + applySchema + 真 route + streamSSE；
// CloneRuntime/clone-resolver mock（clone-stream-resume 同款）；repoSync 注入
// 记录型 stub；HOME 指到 tmp（route 内 new TaskHomeService() 无参 → 吃 os.homedir()）。

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../db/schema"
import { AgentSessionDAO, SafetyDAO, TaskDAO } from "../db/dao"
import { createCloneSessionRoutes } from "../routes/clone"
import { initAgentService } from "../services/agent/agent-service"
import type { RepoSyncService } from "../services/tasks/repo-sync-service"

// ── runtime mock（直通：无门闸） ──────────────────────────────────────

vi.mock("../services/agent/clone-runtime", () => ({
  CloneRuntime: class {
    constructor(_cloneDef: unknown, _org: string) {}
    getDefaultCwd(): string { return "/tmp/fake-cwd" }
    async *chat() {
      yield { type: "text_delta", content: "ok" }
      yield { type: "result", sessionId: "E2E_TD_rs-sess" }
    }
  },
}))

vi.mock("../services/agent/clone-resolver", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/agent/clone-resolver")>()
  return {
    ...real,
    resolveCloneInfo: (name: string) => {
      if (name !== "task-author") return null
      return {
        name, display_name: "Task Author", type: "built-in" as const,
        persona: "# task-author\n\nFake persona.",
        skills: [], memory_scope: "shared" as const,
      }
    },
  }
})

// ── recording stub ────────────────────────────────────────────────────

const calls: Array<string> = []

function makeStub(opts: { hasSnapshot?: boolean; notes?: Record<string, string> } = {}): RepoSyncService {
  return {
    hasSnapshot: () => opts.hasSnapshot ?? false,
    syncProjectsForTask: (taskId: string, _org: string | undefined, names: string[]) => {
      calls.push(`sync:${taskId}:${names.join(",")}`)
    },
    waitUntilIdle: async (taskId: string) => { calls.push(`wait:${taskId}`) },
    freshnessNotes: (_taskId: string, names: string[]) => {
      calls.push(`notes`)
      return opts.notes ?? Object.fromEntries(names.map((n) => [n, "[main @c0ffee00 · 已同步 ✓]"]))
    },
    isBusy: () => false,
  } as unknown as RepoSyncService
}

// ── harness ───────────────────────────────────────────────────────────

const ORG = "e2e-td-rsync"
let fakeHome: string
let db: Database.Database
let appWithGate: Hono
let appNoGate: Hono
let sessionDAO: AgentSessionDAO
let taskDAO: TaskDAO

function insertTask(id: string, sessionId: string, spec: Record<string, unknown>, projectIds: string[]): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO tasks (id, org, name, status, task_spec, authoring_resources, resources,
      skills, project_ids, version, created_at, updated_at, source_chat_session_id)
     VALUES (?, ?, 'E2E_TD gate', 'draft', ?, '[]', '[]', '[]', ?, 1, ?, ?, ?)`,
  ).run(id, ORG, JSON.stringify(spec), JSON.stringify(projectIds), now, now, sessionId)
}

async function createSession(): Promise<string> {
  const res = await appWithGate.request("/api/clones/task-author/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify({}),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

async function chat(app: Hono, sessionId: string): Promise<number> {
  const res = await app.request(`/api/clones/task-author/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify({ message: "hi" }),
  })
  await res.body?.cancel()
  return res.status

}

function contextFile(taskId: string): string {
  return fs.readFileSync(path.join(fakeHome, ".octopus", "tasks", taskId, "context.md"), "utf-8")
}

beforeAll(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "rsync-gate-home-"))
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome
  db = new Database(":memory:")
  applySchema(db)
  sessionDAO = new AgentSessionDAO(db)
  taskDAO = new TaskDAO(db)
  initAgentService(sessionDAO, new SafetyDAO(db))
  appWithGate = new Hono()
  appWithGate.route("/api/clones", createCloneSessionRoutes({
    sessionDAO, taskDAO, repoSyncService: makeStub(),
  }))
  appNoGate = new Hono()
  appNoGate.route("/api/clones", createCloneSessionRoutes({ sessionDAO, taskDAO }))
})

afterAll(() => {
  db.close()
  fs.rmSync(fakeHome, { recursive: true, force: true })
})

beforeEach(() => {
  calls.length = 0
})

describe("clone chat repo-sync 门", () => {
  it("v4 有项目：先补触发 sync + await wait（chat 前），context.md 带新鲜度行", async () => {
    const sid = await createSession()
    insertTask("e2e-td-g1", sid, { format: "v4" }, ["demo-repo"])
    // route 的 taskHomePath 存在性检查 → 预建 home 目录
    fs.mkdirSync(path.join(fakeHome, ".octopus", "tasks", "e2e-td-g1"), { recursive: true })

    expect(await chat(appWithGate, sid)).toBe(200)

    // 门三拍（sync → wait → notes），全部先于 stream 建立（calls 已完整）
    expect(calls).toContain("sync:e2e-td-g1:demo-repo")
    expect(calls).toContain("wait:e2e-td-g1")
    expect(calls.indexOf("wait:e2e-td-g1")).toBeLessThan(calls.indexOf("notes"))
    // wait 必须先于 runtime.chat：门在 chat 段之前跑完，stub 的 wait 记录在第 2 位
    expect(calls.slice(0, 3)).toEqual(["sync:e2e-td-g1:demo-repo", "wait:e2e-td-g1", "notes"])

    const ctx = contextFile("e2e-td-g1")
    expect(ctx).toContain("仓库新鲜度: [main @c0ffee00 · 已同步 ✓]")
    expect(ctx).toContain("demo-repo")
  })

  it("已有快照 → 不重复补触发 sync，仍 await wait", async () => {
    const sid = await createSession()
    insertTask("e2e-td-g2", sid, { format: "v4" }, ["demo-repo"])
    fs.mkdirSync(path.join(fakeHome, ".octopus", "tasks", "e2e-td-g2"), { recursive: true })

    // hasSnapshot stub 恒 false 会重复触发；这里用第二实例验证 true 分支
    const stubSeen = makeStub({ hasSnapshot: true })
    const app2 = new Hono()
    app2.route("/api/clones", createCloneSessionRoutes({ sessionDAO, taskDAO, repoSyncService: stubSeen }))
    expect(await chat(app2, sid)).toBe(200)
    expect(calls.some((c) => c.startsWith("sync:"))).toBe(false)
    expect(calls).toContain("wait:e2e-td-g2")
  })

  it("v3 行（无 v4 旗标）→ 门整体跳过，context.md 无新鲜度行", async () => {
    const sid = await createSession()
    insertTask("e2e-td-g3", sid, { task_type: "coding" }, ["demo-repo"])
    fs.mkdirSync(path.join(fakeHome, ".octopus", "tasks", "e2e-td-g3"), { recursive: true })

    expect(await chat(appWithGate, sid)).toBe(200)
    expect(calls.length).toBe(0)
    expect(contextFile("e2e-td-g3")).not.toContain("仓库新鲜度")
  })

  it("deps 缺省 repoSyncService（旧调用方形态）→ turn 正常，无门", async () => {
    const sid = await createSession()
    insertTask("e2e-td-g4", sid, { format: "v4" }, ["demo-repo"])
    fs.mkdirSync(path.join(fakeHome, ".octopus", "tasks", "e2e-td-g4"), { recursive: true })

    expect(await chat(appNoGate, sid)).toBe(200)
    expect(calls.length).toBe(0)
    expect(contextFile("e2e-td-g4")).not.toContain("仓库新鲜度")
  })
})
