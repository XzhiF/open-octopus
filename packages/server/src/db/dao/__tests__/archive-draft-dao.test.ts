import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { ArchiveDraftDAO } from "../archive-draft-dao"

describe("ArchiveDraftDAO", () => {
  let db: Database.Database
  let dao: ArchiveDraftDAO

  beforeEach(() => {
    db = new Database(":memory:")
    db.exec(`
      CREATE TABLE IF NOT EXISTS archive_drafts (
        workspace_id TEXT PRIMARY KEY,
        org TEXT NOT NULL,
        analysis_report TEXT NOT NULL,
        experiences TEXT NOT NULL DEFAULT '[]',
        skills TEXT NOT NULL DEFAULT '[]',
        stats TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
    dao = new ArchiveDraftDAO(db)
  })

  afterEach(() => { db.close() })

  it("upsert creates new draft", () => {
    dao.upsert({
      workspace_id: "ws-1",
      org: "test-org",
      analysis_report: '{"summary":"test"}',
      experiences: "[]",
      skills: "[]",
      stats: "{}",
    })
    const draft = dao.findByWorkspaceId("ws-1")
    expect(draft).toBeDefined()
    expect(draft!.org).toBe("test-org")
    expect(draft!.analysis_report).toBe('{"summary":"test"}')
  })

  it("upsert overwrites existing draft", () => {
    dao.upsert({
      workspace_id: "ws-1", org: "test-org",
      analysis_report: '{"summary":"v1"}', experiences: "[]", skills: "[]", stats: "{}",
    })
    dao.upsert({
      workspace_id: "ws-1", org: "test-org",
      analysis_report: '{"summary":"v2"}', experiences: "[]", skills: "[]", stats: "{}",
    })
    const draft = dao.findByWorkspaceId("ws-1")
    expect(draft!.analysis_report).toBe('{"summary":"v2"}')
  })

  it("findByWorkspaceId returns undefined for missing", () => {
    expect(dao.findByWorkspaceId("nonexistent")).toBeUndefined()
  })

  it("delete removes draft", () => {
    dao.upsert({
      workspace_id: "ws-1", org: "test-org",
      analysis_report: "{}", experiences: "[]", skills: "[]", stats: "{}",
    })
    dao.delete("ws-1")
    expect(dao.findByWorkspaceId("ws-1")).toBeUndefined()
  })
})
