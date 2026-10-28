import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../schema"
import { ArchiveDraftDAO } from "../archive-draft-dao"

describe("ArchiveDraftDAO", () => {
  let db: Database.Database
  let dao: ArchiveDraftDAO

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new ArchiveDraftDAO(db)
  })

  afterEach(() => { db.close() })

  it("upsert creates new draft", () => {
    dao.upsert({
      workspace_id: "ws-1",
      analysis_report: '{"summary":"test"}',
      experiences: "[]",
      skills: "[]",
      stats: "{}",
    })
    const draft = dao.findByWorkspaceId("ws-1")
    expect(draft).toBeDefined()
    expect(draft!.analysis_report).toBe('{"summary":"test"}')
  })

  it("upsert overwrites existing draft", () => {
    dao.upsert({
      workspace_id: "ws-1", repo_group: "test-org",
      analysis_report: '{"summary":"v1"}', experiences: "[]", skills: "[]", stats: "{}",
    })
    dao.upsert({
      workspace_id: "ws-1", repo_group: "test-org",
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
      workspace_id: "ws-1", repo_group: "test-org",
      analysis_report: "{}", experiences: "[]", skills: "[]", stats: "{}",
    })
    dao.delete("ws-1")
    expect(dao.findByWorkspaceId("ws-1")).toBeUndefined()
  })
})
