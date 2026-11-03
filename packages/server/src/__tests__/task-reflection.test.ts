// packages/server/src/__tests__/task-reflection.test.ts
//
// M3-3 — archiving knowledge reflection: store round-trip, per-entry decision
// (ingest/skip), idempotency, and the archive read model.
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { writeReflectionStore, readReflectionStore } from "../services/tasks/reflection-store"

const ORG = "e2e-task-reflection"
const NOW = new Date().toISOString()

let db: Database.Database
let tmp: string
let service: TasksService
let home: string

function insertTask(id: string): void {
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, task_spec, created_at, updated_at)
    VALUES (?, ?, ?, 'archiving', '{"format":"v4"}', ?, ?)
  `).run(id, ORG, `任务 ${id}`, NOW, NOW)
  home = path.join(tmp, "tasks", id)
  fs.mkdirSync(home, { recursive: true })
}

function seedReflection(): void {
  writeReflectionStore(home, {
    task_id: "t-r",
    created_at: NOW,
    entries: [
      { id: "refl-1", title: "长词优先匹配", content: "敏感词要先长后短。", target: "GLOSSARY · 敏感词匹配" },
      { id: "refl-2", title: "修复轮不换绑定流", content: "打回只派 task-fix。" },
    ],
    decisions: {},
  })
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "task-reflection-"))
  service = new TasksService(
    db,
    new SSEService(),
    new AgentSessionDAO(db),
    new TaskHomeService(tmp),
    undefined,
    { get: () => null } as never,
  )
})

afterAll(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("reflection store + decisions", () => {
  it("round-trips entries and reads them in the archive model", () => {
    insertTask("t-r")
    seedReflection()
    const store = readReflectionStore(home)!
    expect(store.entries).toHaveLength(2)
    const archive = service.readArchive("t-r")
    expect(archive.reflection?.entries[0].title).toBe("长词优先匹配")
    expect(archive.reflection?.decisions).toEqual({})
  })

  it("archive read model exposes project ids + structured report + knowledge snapshot", () => {
    insertTask("t-model")
    db.prepare("UPDATE tasks SET project_ids = ? WHERE id = ?").run(JSON.stringify(["api", "web"]), "t-model")
    const archiveDir = path.join(home, "archive")
    fs.mkdirSync(archiveDir, { recursive: true })
    fs.writeFileSync(path.join(archiveDir, "report.json"), JSON.stringify({
      taskId: "t-model",
      date: "20261031",
      ok: false,
      projects: [
        {
          project: "api", ok: true, adrMerged: 1, adrSkipped: [], termsAppended: 0,
          termConflicts: [], commit: "abc", pushed: true, pr: { action: "created" },
        },
        {
          project: "web", ok: false, adrMerged: 0, adrSkipped: [], termsAppended: 0,
          termConflicts: [], commit: null, pushed: false, pr: null,
          error: "git push origin feat/x failed: protected branch",
        },
      ],
      unattributedAdrs: [],
      unattributedNotes: 0,
    }), "utf-8")
    service.setArchiveKnowledgeHook(() => ({ pack_items: 7, compile_state: "running", compile_position: null }))
    try {
      const archive = service.readArchive("t-model")
      expect(archive.projects).toEqual(["api", "web"])
      expect(archive.report?.ok).toBe(false)
      expect(archive.report?.projects[1].error).toContain("protected branch")
      expect(archive.knowledge).toEqual({ pack_items: 7, compile_state: "running", compile_position: null })
    } finally {
      service.setArchiveKnowledgeHook(null)
    }
  })

  it("archive read model attaches the persisted wiki compile receipt (archive/wiki-result.json)", () => {
    insertTask("t-wiki")
    const archiveDir = path.join(home, "archive")
    fs.mkdirSync(archiveDir, { recursive: true })
    fs.writeFileSync(path.join(archiveDir, "wiki-result.json"), JSON.stringify({
      status: "committed",
      started_at: "2026-11-03T06:46:31.000Z",
      finished_at: "2026-11-03T06:48:42.000Z",
      commit: "5a5a669",
      changed: true,
      deduped: false,
      created: 2,
      updated: 1,
      contradictions: 1,
      finding_ids: ["fnd-1"],
      touched: [
        { path: "entities/ent-a.md", type: "entity", created: false },
        { path: "topics/top-b.md", type: "topic", created: true },
      ],
      warnings: [],
    }), "utf-8")
    service.setArchiveKnowledgeHook(() => ({ pack_items: 7, compile_state: null, compile_position: null }))
    try {
      const archive = service.readArchive("t-wiki")
      expect(archive.knowledge?.wiki_result).toMatchObject({
        status: "committed",
        commit: "5a5a669",
        created: 2,
        updated: 1,
        contradictions: 1,
        finding_ids: ["fnd-1"],
      })
      expect(archive.knowledge?.wiki_result?.touched).toHaveLength(2)
    } finally {
      service.setArchiveKnowledgeHook(null)
    }
  })

  it("archive read model attaches persisted case archive results (archive/case-result.json)", () => {
    insertTask("t-case")
    const archiveDir = path.join(home, "archive")
    fs.mkdirSync(archiveDir, { recursive: true })
    fs.writeFileSync(path.join(archiveDir, "case-result.json"), JSON.stringify([
      {
        queue_task_id: "caw-t-case-01",
        action: "merged",
        symptom: "登录接口 500：cookie 未清",
        case_path: "cases/2026-10-27-case-acc38e5918.md",
        occurrences_before: 1,
        occurrences_after: 2,
        finished_at: "2026-11-03T06:49:00.000Z",
      },
    ]), "utf-8")
    service.setArchiveKnowledgeHook(() => ({ pack_items: 7, compile_state: null, compile_position: null }))
    try {
      const archive = service.readArchive("t-case")
      expect(archive.knowledge?.case_results).toHaveLength(1)
      expect(archive.knowledge?.case_results?.[0]).toMatchObject({
        action: "merged",
        case_path: "cases/2026-10-27-case-acc38e5918.md",
        occurrences_before: 1,
        occurrences_after: 2,
      })
    } finally {
      service.setArchiveKnowledgeHook(null)
    }
  })

  it("archive read model exposes open wiki findings for the archive chat", () => {
    insertTask("t-find")
    service.setArchiveKnowledgeHook(() => ({
      pack_items: 7,
      compile_state: "committed",
      compile_position: null,
      findings: [{
        id: "fnd-1",
        kind: "contradiction",
        status: "open",
        title: "矛盾：固定窗口 ↔ 滑动窗口",
        detail: { old_claim: "固定窗口", new_claim: "滑动窗口" },
        pages: ["topics/gateway.md"],
        rawRef: "raw/archives/task-t-find/07-archive-summary.md",
        source: "compile",
        createdAt: "2026-11-03T06:48:00.000Z",
      }],
    }))
    try {
      const archive = service.readArchive("t-find")
      expect(archive.knowledge?.findings).toHaveLength(1)
      expect(archive.knowledge?.findings?.[0]).toMatchObject({
        id: "fnd-1",
        status: "open",
        pages: ["topics/gateway.md"],
      })
    } finally {
      service.setArchiveKnowledgeHook(null)
    }
  })

  it("skip is recorded and idempotent", async () => {
    insertTask("t-skip")
    seedReflection()
    const first = await service.decideReflection("t-skip", { entry_id: "refl-1", action: "skip" })
    expect(first.decision.action).toBe("skip")
    const second = await service.decideReflection("t-skip", { entry_id: "refl-1", action: "skip" })
    expect(second.decision.at).toBe(first.decision.at)
    expect(readReflectionStore(home)!.decisions["refl-1"].action).toBe("skip")
  })

  it("ingest passes title/content/origin to the knowledge channel", async () => {
    insertTask("t-ingest")
    seedReflection()
    const calls: Array<{ title: string; text: string; origin: string }> = []
    const result = await service.decideReflection(
      "t-ingest",
      { entry_id: "refl-2", action: "ingest", title: "改过的标题" },
      async (input) => {
        calls.push(input)
        return { raw_path: "raw/inbox/x.md", compile_task_id: "q-1" }
      },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      title: "改过的标题",
      text: "打回只派 task-fix。",
      origin: "task-reflection:t-ingest:refl-2",
    })
    expect(result.decision.raw_path).toBe("raw/inbox/x.md")
    expect(result.decision.compile_task_id).toBe("q-1")
    expect(readReflectionStore(home)!.decisions["refl-2"].action).toBe("ingest")
  })

  it("rejects unknown entry / missing store / unavailable ingest", async () => {
    insertTask("t-missing")
    await expect(service.decideReflection("t-missing", { entry_id: "x", action: "skip" })).rejects.toThrow()
    seedReflection()
    await expect(service.decideReflection("t-missing", { entry_id: "nope", action: "skip" })).rejects.toThrow()
    await expect(service.decideReflection("t-missing", { entry_id: "refl-1", action: "ingest" })).rejects.toThrow()
  })
})

describe("archive amendments (2026-10-31)", () => {
  it("append-only: writes JSONL, reads back in the archive model, and can ingest to wiki", async () => {
    insertTask("t-amend")
    db.prepare("UPDATE tasks SET status='done' WHERE id='t-amend'").run()
    const calls: Array<{ title: string; text: string; origin: string }> = []
    const out = await service.appendArchiveAmendment(
      "t-amend",
      {
        reason: "补一条收尾决策",
        content: "上线后再补一个灰度开关。",
        target: "ADR · 灰度",
        ingest: true,
      },
      async (input) => {
        calls.push(input)
        return { raw_path: "raw/inbox/amend.md", compile_task_id: "q-amend" }
      },
    )
    expect(out.amendment.reason).toBe("补一条收尾决策")
    expect(out.amendment.ingest).toEqual({ raw_path: "raw/inbox/amend.md", compile_task_id: "q-amend" })
    const lines = fs.readFileSync(path.join(home, "archive", "amendments.jsonl"), "utf-8").trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      title: "补一条收尾决策",
      text: "> 修订自归档任务 t-amend（补一条收尾决策）\n\n上线后再补一个灰度开关。",
      origin: `task-amendment:t-amend:${out.amendment.id}`,
    })
    const archive = service.readArchive("t-amend")
    expect(archive.amendments).toHaveLength(1)
    expect(archive.amendments[0].target).toBe("ADR · 灰度")
  })

  it("rejects before done and requires reason/content", async () => {
    insertTask("t-amend-open")
    await expect(
      service.appendArchiveAmendment("t-amend-open", { reason: "r", content: "c" }),
    ).rejects.toThrow()
    db.prepare("UPDATE tasks SET status='done' WHERE id='t-amend-open'").run()
    await expect(
      service.appendArchiveAmendment("t-amend-open", { reason: "", content: "c" }),
    ).rejects.toThrow()
    await expect(
      service.appendArchiveAmendment("t-amend-open", { reason: "r", content: "" }),
    ).rejects.toThrow()
  })
})
