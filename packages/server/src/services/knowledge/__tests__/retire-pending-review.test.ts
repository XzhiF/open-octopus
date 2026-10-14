/**
 * 票08 清理账 S1 — pending_review 蓝绿退役（导出先于 drop，红线1「归档先于删除」）。
 *
 * 真盘零触碰：DB 用 in-memory fixture（自建 pending_review 表，独立于 schema.sql），
 * 导出件落 tmpdir 假归档目录。断言全走外部行为：文件产物 + 表/索引存在性 + 行数。
 *
 * 覆盖：
 *   A1 正常退役：有数据 → 导出件落盘（内容=全量行）→ 表+三索引消失
 *   A2 空表也留审计：0 行仍落导出件（rowCount:0）→ drop
 *   A3 幂等：对已 drop 库再跑 → 跳过、不报错、不重复导出、表仍无
 *   A4 红线（顺序断言）：导出失败 → 结构上中止 → 绝不 drop（表仍在）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import {
  pendingReviewExists,
  retirePendingReview,
} from "../retire-pending-review"

const PENDING_REVIEW_DDL = `
CREATE TABLE pending_review (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'rule',
  source TEXT NOT NULL DEFAULT 'system',
  source_ref TEXT NOT NULL DEFAULT '',
  source_label TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  target_file TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'project',
  conflicts TEXT DEFAULT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  auto_approve INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT DEFAULT NULL,
  user_notes TEXT DEFAULT NULL
);
CREATE INDEX idx_pending_status ON pending_review(status);
CREATE INDEX idx_pending_review_source ON pending_review(source);
CREATE INDEX idx_pending_review_type_status ON pending_review(type, status);
`

function makeDbWithPendingReview(rows: number): Database.Database {
  const db = new Database(":memory:")
  db.exec(PENDING_REVIEW_DDL)
  const ins = db.prepare(
    `INSERT INTO pending_review (id, type, source, content, status) VALUES (?, ?, ?, ?, ?)`,
  )
  for (let i = 0; i < rows; i++) {
    ins.run(`r-${i}`, "rule", "workspace_archive", `rule text ${i}`, "pending")
  }
  return db
}

function indexCount(db: Database.Database): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND name IN ('idx_pending_status','idx_pending_review_source','idx_pending_review_type_status')`,
      )
      .get() as { c: number }
  ).c
}

describe("retirePendingReview — 蓝绿退役", () => {
  let archiveDir: string
  let db: Database.Database | null = null

  beforeEach(() => {
    archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "aa08-archive-"))
    db = null
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(archiveDir, { recursive: true, force: true })
  })

  it("A1 有数据：导出件落盘含全量行，表+三索引被 drop", () => {
    db = makeDbWithPendingReview(3)
    expect(pendingReviewExists(db)).toBe(true)

    const res = retirePendingReview(db, { archiveDir, now: () => new Date("2026-10-14T12:00:00Z") })

    expect(res).toMatchObject({ exported: true, rows: 3, dropped: true, skipped: false })
    expect(res.exportPath).toBeTruthy()

    // 导出件：合法 JSON + 契约元数据 + 3 行内容（外部真相源=构造 fixture 的行文本）
    const parsed = JSON.parse(fs.readFileSync(res.exportPath!, "utf-8"))
    expect(parsed.table).toBe("pending_review")
    expect(parsed.rowCount).toBe(3)
    expect(parsed.exportedAt).toBe("2026-10-14T12:00:00.000Z")
    expect(parsed.rows.map((r: { content: string }) => r.content).sort()).toEqual([
      "rule text 0",
      "rule text 1",
      "rule text 2",
    ])

    // drop 面：表 + 三索引都消失
    expect(pendingReviewExists(db)).toBe(false)
    expect(indexCount(db)).toBe(0)
  })

  it("A2 空表也落审计导出件（rowCount:0）再 drop", () => {
    db = makeDbWithPendingReview(0)
    const res = retirePendingReview(db, { archiveDir, now: () => new Date("2026-10-14T00:00:00Z") })

    expect(res).toMatchObject({ exported: true, rows: 0, dropped: true, skipped: false })
    const parsed = JSON.parse(fs.readFileSync(res.exportPath!, "utf-8"))
    expect(parsed.rowCount).toBe(0)
    expect(parsed.rows).toEqual([])
    expect(pendingReviewExists(db)).toBe(false)
  })

  it("A3 幂等：已 drop 库再跑 → 跳过、不报错、不新增导出件、表仍无", () => {
    db = makeDbWithPendingReview(2)
    const first = retirePendingReview(db, { archiveDir, now: () => new Date("2026-10-14T01:00:00Z") })
    expect(first.dropped).toBe(true)

    const filesAfterFirst = fs.readdirSync(archiveDir).length
    const second = retirePendingReview(db, { archiveDir, now: () => new Date("2026-10-14T02:00:00Z") })

    expect(second).toMatchObject({ skipped: true, exported: false, dropped: false, rows: 0 })
    expect(second.exportPath).toBeUndefined()
    expect(fs.readdirSync(archiveDir).length).toBe(filesAfterFirst) // 无重复导出件
    expect(pendingReviewExists(db)).toBe(false)
  })

  it("A4 红线：导出失败（归档目录父路径非法）→ 结构上中止 → 绝不 drop（表仍在）", () => {
    db = makeDbWithPendingReview(5)
    // 把归档目录指向一个"文件当父目录"的路径 → mkdir/write 必失败
    const blocker = path.join(archiveDir, "blocker-file")
    fs.writeFileSync(blocker, "not-a-dir")
    const badArchiveDir = path.join(blocker, "sub-archive")

    expect(() =>
      retirePendingReview(db!, { archiveDir: badArchiveDir, now: () => new Date("2026-10-14T03:00:00Z") }),
    ).toThrow()

    // 关键负断言：drop 没发生（导出先于删除，失败即止）
    expect(pendingReviewExists(db)).toBe(true)
    expect(indexCount(db)).toBe(3)
  })
})
