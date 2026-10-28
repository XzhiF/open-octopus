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
  canRunTaskAction,
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
    expect(canRunTaskAction("author", "running", "pause").ok).toBe(false)
    expect(canRunTaskAction("base", "running", "pause").ok).toBe(false)
    expect(canRunTaskAction("doer", "archiving", "pause").ok).toBe(false)
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
