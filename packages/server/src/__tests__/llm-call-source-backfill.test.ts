import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema, backfillLlmCallSourcePath } from "../db/schema"

/**
 * billing-coverage-2 票01 —— source_path 历史回填（KD21，数据诚实：可推断者如实，余 unknown）。
 * 模拟老库：llm_calls 行 source_path 为 NULL，按既有写入点特征反推——
 *   同 node_execution 的 ntu source='interaction' → interaction
 *   同 node_execution 的 ntu source='harness'    → harness
 *   node_execution/execution 关联存在            → workflow
 *   推不出                                        → unknown
 * 幂等：二次跑零变更（票 AC3）。
 */
let db: Database.Database

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  const now = new Date().toISOString()
  db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-1', 'WS', '/tmp/ws', 'default', ?, ?)").run(now, now)
  for (const [id, wf] of [["e-wf", "t.yaml"], ["e-ix", "ix.yaml"]] as const) {
    db.prepare(`
      INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, started_at, completed_at, org, created_at, updated_at)
      VALUES (?, 'ws-1', '0', ?, 'W', 'completed', ?, ?, 'default', ?, ?)
    `).run(id, wf, now, now, now, now)
  }
  db.prepare(`
    INSERT INTO node_executions (id, execution_id, node_id, node_type, status, retry_count, duration, started_at, completed_at)
    VALUES ('ne-wf', 'e-wf', 'n1', 'agent', 'completed', 0, 10, ?, ?)
  `).run(now, now)
  db.prepare(`
    INSERT INTO node_executions (id, execution_id, node_id, node_type, status, retry_count, duration, started_at, completed_at)
    VALUES ('ne-ix', 'e-ix', 'n2', 'agent', 'completed', 0, 10, ?, ?)
  `).run(now, now)
  db.prepare(`
    INSERT INTO node_executions (id, execution_id, node_id, node_type, status, retry_count, duration, started_at, completed_at)
    VALUES ('ne-ha', 'e-wf', 'n3', 'agent', 'completed', 0, 10, ?, ?)
  `).run(now, now)
  // 账本特征行（回填推断依据；NEW-r2：ntu 是纯 token 账，无 cost 列）
  const ntu = db.prepare(`
    INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source, created_at)
    VALUES (?, ?, 'm', 1, 1, 0, 0, ?, ?)
  `)
  ntu.run("ntu-wf", "ne-wf", "node", now)
  ntu.run("ntu-ix", "ne-ix", "interaction", now)
  ntu.run("ntu-ha", "ne-ha", "harness", now)
  // 老 llm_calls 行（不带 source_path = NULL）
  const legacy = db.prepare(`
    INSERT INTO llm_calls (id, node_execution_id, execution_id, turn_index, call_index, timestamp, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
    VALUES (?, ?, ?, 1, 0, 1, 1, 0, 0, 0, 0)
  `)
  legacy.run("lc-wf", "ne-wf", "e-wf")        // 有 workflow 账本特征 + node_execution 关联
  legacy.run("lc-ix", "ne-ix", "e-ix")        // interaction 写入特征（也有 node_execution 关联 → 优先级验证）
  legacy.run("lc-ha", "ne-ha", "e-wf")        // harness 特征（同样有 node_execution 关联 → 优先级验证）
  // 推不出的孤儿行（引用已被清理的执行 —— FK 临时放行模拟老库历史态）
  db.pragma("foreign_keys = OFF")
  legacy.run("lc-orphan", "gone-ne", "gone-ex")
  db.pragma("foreign_keys = ON")
  expect((db.prepare("SELECT COUNT(*) c FROM llm_calls WHERE source_path IS NULL").get() as { c: number }).c).toBe(4)
})

afterEach(() => {
  db.close()
})

function sourceOf(id: string): string | null {
  return (db.prepare("SELECT source_path FROM llm_calls WHERE id = ?").get(id) as { source_path: string | null }).source_path
}

describe("source_path 历史回填（KD21）", () => {
  it("可推断者如实回填；unknown 只出现在推不出行（AC3）", () => {
    backfillLlmCallSourcePath(db)
    expect(sourceOf("lc-wf")).toBe("workflow")
    expect(sourceOf("lc-ix")).toBe("interaction") // interaction 特征优先于 execution 关联
    expect(sourceOf("lc-ha")).toBe("harness")
    expect(sourceOf("lc-orphan")).toBe("unknown")
    expect((db.prepare("SELECT COUNT(*) c FROM llm_calls WHERE source_path IS NULL").get() as { c: number }).c).toBe(0)
  })

  it("幂等可重跑：二次跑零变更（AC3）", () => {
    backfillLlmCallSourcePath(db)
    const before = (db.prepare("SELECT id, source_path FROM llm_calls ORDER BY id").all() as Array<{ id: string; source_path: string }> ).map(r => `${r.id}:${r.source_path}`).join("|")
    const again = backfillLlmCallSourcePath(db)
    expect(again).toBe(0)
    const after = (db.prepare("SELECT id, source_path FROM llm_calls ORDER BY id").all() as Array<{ id: string; source_path: string }> ).map(r => `${r.id}:${r.source_path}`).join("|")
    expect(after).toBe(before)
  })

  it("已回填行不被二次覆盖（新写入带值 → 迁移不碰）", () => {
    db.prepare("UPDATE llm_calls SET source_path = 'session_compress' WHERE id = 'lc-orphan'").run()
    backfillLlmCallSourcePath(db)
    expect(sourceOf("lc-orphan")).toBe("session_compress")
    expect(sourceOf("lc-wf")).toBe("workflow")
  })

  it("(source_path, timestamp) 索引就位（筛选/小计支撑）", () => {
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_llm_calls_source_ts'").get() as { sql: string } | undefined
    expect(idx?.sql).toContain("source_path")
    expect(idx?.sql).toContain("timestamp")
  })
})
