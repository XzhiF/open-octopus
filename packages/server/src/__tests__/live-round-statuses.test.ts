// packages/server/src/__tests__/live-round-statuses.test.ts
//
// 票10 review-2 的防漂移钉：live/cancellable 执行状态词表单源 = shared
// {@link LIVE_ROUND_STATUSES}（「在飞的轮」= 已起跑未终态；停在审批/交互节点的
// 轮仍是 live —— 03 报告认「审批等待」在列，SQL 旧内联字面量漏过它）。
// 本文件钉两头：
//   ① 词汇表本体（独立事实 = ExecutionLifecycle.cancel 的接受语义 + spec 票03/08）；
//   ② findLiveRoundForTask 真 DB 行为 —— 五种在飞状态都能解析，排队/终态不能
//     （漂移 = 某一状态掉出 SQL 的 IN 列表，这里转红）。

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { ExecutionDAO } from "../db/dao"
import { LIVE_ROUND_STATUSES, TERMINAL_EXECUTION_STATUSES } from "@octopus/shared"

let db: Database.Database
let dao: ExecutionDAO
let seq = 0

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  dao = new ExecutionDAO(db)
  db.prepare(`INSERT INTO workspaces (id,name,org,path,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .run("ws-live-1", "live-ws", "e2e-live", "C:/x", new Date().toISOString(), new Date().toISOString())
})
afterAll(() => { db.close() })

function seedRound(taskId: string, execId: string, status: string, startCommit: string | null): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
      status, input_values, var_pool, org, created_at, updated_at, task_id, phase_index, round_index, start_commit_id)
    VALUES (?,?,'0',0,'wf','wf',?,'{}','{}','e2e-live',?,?,?,1,1,?)
  `).run(execId, "ws-live-1", status, now, now, taskId, startCommit)
}

describe("LIVE_ROUND_STATUSES — 在飞轮词表单源", () => {
  it("membership（独立事实：cancel 接受集 = 已起跑未终态；停在审批/交互节点也算 live；排队行不算）", () => {
    expect([...LIVE_ROUND_STATUSES].sort()).toEqual(
      ["pending_approval", "pending_interaction", "pending_resume", "paused", "running"].sort(),
    )
    // 'pending'（排队未启动）与任何终态都不在列 —— 排队没有现场，终态已收口。
    expect(LIVE_ROUND_STATUSES).not.toContain("pending")
    for (const terminal of TERMINAL_EXECUTION_STATUSES) {
      expect(LIVE_ROUND_STATUSES).not.toContain(terminal)
    }
  })

  it("findLiveRoundForTask 对五种在飞状态逐款解析（含停在交互节点的 pending_interaction）", () => {
    for (const status of LIVE_ROUND_STATUSES) {
      const taskId = `t-${seq}`
      seedRound(taskId, `e-${seq}`, status, `sha-${seq}`)
      seq++
      const hit = dao.findLiveRoundForTask(taskId)
      expect(hit, `status ${status} 应算 live 轮`).not.toBeNull()
      expect(hit!.status).toBe(status)
    }
  })

  it("排队行 / 缺 start 锚 / 终态行都不是 live 轮（回落闸不放宽）", () => {
    const t1 = `t-queue-${seq++}`
    seedRound(t1, `e-${seq - 1}`, "pending", "sha-q")
    expect(dao.findLiveRoundForTask(t1)).toBeNull()

    const t2 = `t-nostart-${seq++}`
    seedRound(t2, `e-${seq - 1}`, "running", null)
    expect(dao.findLiveRoundForTask(t2)).toBeNull()

    const t3 = `t-terminal-${seq++}`
    seedRound(t3, `e-${seq - 1}`, "completed", "sha-t")
    expect(dao.findLiveRoundForTask(t3)).toBeNull()
  })
})
