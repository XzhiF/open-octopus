// packages/server/src/__tests__/task-tools.test.ts
//
// M2-3 — pure action gate + card builders + persisted card shape.
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import {
  appendTaskToolCard,
  buildActionRequestCard,
  buildLaunchProposalCard,
  canExecuteLaunch,
  canRunTaskAction,
  canStartArchive,
  executeLaunchAction,
  type TaskLaunchToolsService,
} from "../services/chat/task-tools"
import type { TaskThreadProfile } from "../services/tasks/task-thread-service"

const NOW = "2026-10-28T12:00:00.000Z"

function profile(overrides: Partial<TaskThreadProfile["task"]> = {}, identity: TaskThreadProfile["identity"] = "doer"): TaskThreadProfile {
  return {
    identity,
    cwd: "C:/tmp/ws",
    plugins: [],
    context: "",
    autoCommit: false,
    readOnly: false,
    takeover: false,
    acceptanceGuide: false,
    archiveGuide: false,
    archiveConsent: false,
    task: {
      id: "t-1",
      name: "昵称敏感词过滤组件",
      status: "running",
      displayStatus: "running",
      phaseIndex: 1,
      roundIndex: 1,
      awaitingReview: false,
      workspaceId: "ws-1",
      wsPath: "C:/tmp/ws",
      taskHome: "C:/tmp/home/t-1",
      slug: "nickname",
      branch: "feat-nickname",
      ...overrides,
    },
  }
}

describe("canRunTaskAction", () => {
  it("doer + matching state allows; every other combination refuses", () => {
    expect(canRunTaskAction("doer", "running", "pause").ok).toBe(true)
    expect(canRunTaskAction("doer", "paused", "resume").ok).toBe(true)
    expect(canRunTaskAction("doer", "ready", "trigger").ok).toBe(true)
    expect(canRunTaskAction("doer", "archiving", "retry_archive").ok).toBe(true)
    expect(canRunTaskAction("doer", "running", "inject").ok).toBe(true)

    expect(canRunTaskAction("doer", "ready", "pause").ok).toBe(false)
    expect(canRunTaskAction("doer", "awaiting_review", "abort").ok).toBe(false)
    expect(canRunTaskAction("doer", "awaiting_archive", "abort").ok).toBe(true)
    expect(canRunTaskAction("author", "running", "pause").ok).toBe(false)
    expect(canRunTaskAction("base", "running", "pause").ok).toBe(false)
    expect(canRunTaskAction("doer", "archiving", "pause").ok).toBe(false)
  })
})

describe("canStartArchive — 归档前的明确同意门", () => {
  it("only doer + awaiting_archive + confirmed=true may start archive", () => {
    expect(canStartArchive("doer", "awaiting_archive", true).ok).toBe(true)
    expect(canStartArchive("doer", "awaiting_archive", false).reason).toContain("必须等用户明确说")
    expect(canStartArchive("author", "awaiting_archive", true).reason).toContain("执行者")
    expect(canStartArchive("doer", "archiving", true).reason).toContain("待归档")
    expect(canStartArchive("doer", "ready", true).ok).toBe(false)
  })
})

describe("canExecuteLaunch — 对话里的明确启动指令", () => {
  it("author + draft + confirmed 才允许 launch_now / enqueue", () => {
    expect(canExecuteLaunch("author", "draft", "launch_now", true).ok).toBe(true)
    expect(canExecuteLaunch("author", "draft", "enqueue", true).ok).toBe(true)
    expect(canExecuteLaunch("author", "draft", "launch_now", false).reason).toContain("必须等用户")
    expect(canExecuteLaunch("doer", "draft", "launch_now", true).reason).toContain("作者")
    expect(canExecuteLaunch("author", "running", "launch_now", true).reason).toContain("draft")
    expect(canExecuteLaunch("author", "ready", "enqueue", true).reason).toContain("draft")
  })

  it("trigger 只给 doer + ready + confirmed", () => {
    expect(canExecuteLaunch("doer", "ready", "trigger", true).ok).toBe(true)
    expect(canExecuteLaunch("author", "ready", "trigger", true).reason).toContain("执行者")
    expect(canExecuteLaunch("doer", "draft", "trigger", true).reason).toContain("ready")
    expect(canExecuteLaunch("doer", "ready", "trigger", false).reason).toContain("必须等用户")
  })
})

describe("executeLaunchAction — 与看板同一执行组合", () => {
  function fakeService(): {
    svc: TaskLaunchToolsService
    calls: Array<{ method: string; opts?: { silentCard?: boolean } }>
  } {
    const calls: Array<{ method: string; opts?: { silentCard?: boolean } }> = []
    return {
      calls,
      svc: {
        readyTask: (_id, opts) => {
          calls.push({ method: "ready", opts })
          return { status: "ready" }
        },
        triggerTask: async () => {
          calls.push({ method: "trigger" })
          return { status: "running" }
        },
      },
    }
  }

  it("launch_now = 静默 ready → trigger", async () => {
    const { svc, calls } = fakeService()
    const out = await executeLaunchAction(svc, "t-1", "launch_now")
    expect(out).toMatchObject({ ok: true, task: { status: "running" } })
    expect(calls).toEqual([{ method: "ready", opts: { silentCard: true } }, { method: "trigger" }])
  })

  it("enqueue 只 ready（保留「已入列」卡）", async () => {
    const { svc, calls } = fakeService()
    await executeLaunchAction(svc, "t-1", "enqueue")
    expect(calls).toEqual([{ method: "ready", opts: undefined }])
  })

  it("trigger 只触发；ready gate 失败原样带回 missing", async () => {
    const { svc, calls } = fakeService()
    await executeLaunchAction(svc, "t-1", "trigger")
    expect(calls).toEqual([{ method: "trigger" }])

    const failing: TaskLaunchToolsService = {
      readyTask: () => {
        const err = new Error("Task not ready: missing runbook") as Error & { missing: string[] }
        err.missing = ["runbook"]
        throw err
      },
      triggerTask: async () => ({}),
    }
    const out = await executeLaunchAction(failing, "t-1", "launch_now")
    expect(out).toMatchObject({ ok: false, error: "Task not ready: missing runbook", missing: ["runbook"] })
  })
})

describe("card builders", () => {
  it("launch proposal carries four choices and no destructive payload", () => {
    const card = buildLaunchProposalCard(profile({ status: "draft", displayStatus: "draft" }, "author"), "规格已齐")
    expect(card.kind).toBe("task.launch_proposal")
    expect(card.message).toBe("规格已齐")
    expect(card.actions.map((a) => a.id)).toEqual(["launch_now", "enqueue", "schedule", "keep_editing"])
    expect(card.payload).toEqual({ proposal: "launch" })
  })

  it("action request carries action/reason and optional intervention", () => {
    const ok = buildActionRequestCard(profile(), "inject", "先补测试", "只跑相关测试")
    expect(ok.card?.payload).toMatchObject({ action: "inject", reason: "先补测试", intervention: "只跑相关测试" })
    expect(ok.card?.actions.map((a) => a.id)).toEqual(["confirm_action", "cancel_action"])

    expect(buildActionRequestCard(profile(), "inject", "先补测试").error).toContain("intervention")
    expect(buildActionRequestCard(profile({ displayStatus: "ready" }), "pause", "x").error).toContain("不允许")
    expect(buildActionRequestCard(profile({}, "author"), "pause", "x").error).toContain("执行者")
  })
})

describe("appendTaskToolCard", () => {
  let db: Database.Database
  beforeAll(() => {
    db = new Database(":memory:")
    applySchema(db)
    db.prepare(`
      INSERT INTO sessions (id, org, title, clone_name, session_type, is_active, is_deleted, created_at, updated_at)
      VALUES ('s-1','org','T',NULL,'main',1,0,?,?)
    `).run(NOW, NOW)
  })
  afterAll(() => db.close())

  it("writes a displayType:'event' message with actions", () => {
    appendTaskToolCard(db, "s-1", buildLaunchProposalCard(profile({ status: "draft", displayStatus: "draft" }, "author")))
    const row = db.prepare("SELECT content, metadata FROM messages WHERE session_id='s-1'").get() as {
      content: string
      metadata: string
    }
    expect(row.content).toContain("启动方式待选择")
    const meta = JSON.parse(row.metadata) as {
      displayType: string
      activity: { kind: string; actions: Array<{ id: string }>; payload: unknown }
    }
    expect(meta.displayType).toBe("event")
    expect(meta.activity.kind).toBe("task.launch_proposal")
    expect(meta.activity.actions.map((a) => a.id)).toContain("enqueue")
  })
})
