import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { ExecutionDAO } from "../db/dao/execution-dao"

// perf/agent-event-optimize — v43 迁移：
//   1) agent_events.timestamp 历史文本行(合并写路径落的 ISO 串)回填为 epoch-ms 整数，
//      否则 retention 的 `timestamp < ?`(epoch) 永不命中(SQLite 整数恒小于文本) → 无限膨胀；
//   2) 冗余索引 idx_agent_events_node 下线（与 PK 左前缀重复）；
//   3) 新增 idx_agent_events_ts 服务 retention 范围扫描（由 schema.sql 建立）。

const ISO_OLD = "2020-01-02T03:04:05.006Z"

function insertRawAgentEvent(nodeExecId: string, order: number, ts: string | number) {
  db.prepare(
    `INSERT INTO agent_events (node_execution_id,event_order,turn_index,event_type,timestamp,content,content_length)
     VALUES (?,?,0,'tool_call',?,'{}',2)`
  ).run(nodeExecId, order, ts)
}

let db: Database.Database

function indexNames(): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_events'").all() as { name: string }[])
    .map(r => r.name)
}

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
})

describe("schema v43 — agent_events timestamp 回填 + 索引收口", () => {
  it("applySchema 后索引形态：无冗余 node 索引，有 turn + ts 索引", () => {
    const names = indexNames()
    expect(names).not.toContain("idx_agent_events_node")
    expect(names).toContain("idx_agent_events_turn")
    expect(names).toContain("idx_agent_events_ts")
  })

  it("存量文本时间戳 → 二次 applySchema 回填为整数 epoch-ms", () => {
    // 模拟旧库：手工再造被删的冗余索引 + 灌入 ISO 文本行(INTEGER affinity 不会转换非数字串)
    db.exec("CREATE INDEX IF NOT EXISTS idx_agent_events_node ON agent_events(node_execution_id)")
    insertRawAgentEvent("ne-1", 0, ISO_OLD)
    insertRawAgentEvent("ne-1", 1, 1577934245006) // 已是整数的行不动
    expect((db.prepare("SELECT typeof(timestamp) t FROM agent_events WHERE event_order=0").get() as { t: string }).t).toBe("text")

    applySchema(db)

    const rows = db.prepare("SELECT event_order, typeof(timestamp) t, timestamp ts FROM agent_events ORDER BY event_order").all() as Array<{ event_order: number; t: string; ts: number }>
    expect(rows.map(r => r.t)).toEqual(["integer", "integer"])
    expect(Math.abs(rows[0].ts - Date.parse(ISO_OLD))).toBeLessThanOrEqual(2)
    expect(rows[1].ts).toBe(1577934245006)
    expect(indexNames()).not.toContain("idx_agent_events_node") // 迁移重入时也保持删除
  })

  it("无法解析的文本时间戳保留原样且不阻断启动", () => {
    insertRawAgentEvent("ne-2", 0, "not-a-date")
    expect(() => applySchema(db)).not.toThrow()
    const rows = db.prepare("SELECT typeof(timestamp) t FROM agent_events").all() as { t: string }[]
    expect(rows[0].t).toBe("text")
  })

  it("回填后 retention 能命中旧行(含曾经永删不掉的文本行)", () => {
    insertRawAgentEvent("ne-3", 0, ISO_OLD) // 旧 bug 形态：ISO 文本
    const fresh = db.prepare("SELECT COUNT(*) c FROM agent_events WHERE typeof(timestamp)='text'").get() as { c: number }
    expect(fresh.c).toBe(1)

    applySchema(db) // v43 回填

    const dao = new ExecutionDAO(db)
    const cutoff = Date.now() - 90 * 86_400_000
    expect(dao.deleteOldAgentEvents(cutoff).changes).toBe(1)
  })

  it("幂等：多次 applySchema 不重复改写整数行", () => {
    insertRawAgentEvent("ne-4", 0, ISO_OLD)
    applySchema(db)
    const once = (db.prepare("SELECT timestamp ts FROM agent_events").get() as { ts: number }).ts
    applySchema(db)
    applySchema(db)
    const after = (db.prepare("SELECT timestamp ts FROM agent_events").get() as { ts: number }).ts
    expect(after).toBe(once)
  })
})
