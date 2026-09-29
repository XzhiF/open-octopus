// P1 B4 票2B-1：TokenUsageDAO 已迁 postgres.js —— 日志分析各聚合（health / failure
// patterns / anomalies / cost）经 TokenUsageDAO 全部读 PG；ExecutionDAO（B5 批）仍 SQLite，
// getExecutionLogs 的 workspace 路径 / node error 回查走 sqlite db。故本文件双引擎：
// PG 随机库喂分析聚合（dao-fixture 姿势），:memory: SQLite 喂 execDao 读路径。
// 断言语义与条数逐条保持。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import path from "path"
import os from "os"
import fs from "fs"
import { applySchema } from "../../db/schema"
import { LogAnalysisService } from "../log-analysis"
import { TokenUsageDAO, ExecutionDAO } from "../../db/dao"
import { describePg, setupPgSchema, type PgFixture } from "../../db/pg/__tests__/dao-fixture"

let pg: PgFixture
let db: Database.Database
let service: LogAnalysisService
const WORKSPACE_ID = "ws-test-001"
const ORG = "xzf"

// ── PG 侧造数（分析聚合读路径）────────────────────────────────────
async function pgSeedWorkspace(id: string, name = "test-ws") {
  await pg.sql.unsafe(
    "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())",
    [id, name, ORG, id === WORKSPACE_ID ? "/tmp/test-ws" : `/tmp/${id}`],
  )
}

async function pgSeedExecution(opts: {
  id: string
  workspaceId?: string
  workflowRef: string
  status: string
  daysAgo?: number
  duration?: number | null
  parentId?: string
}) {
  const daysAgo = opts.daysAgo ?? 0
  const date = new Date(Date.now() - daysAgo * 86400000).toISOString()
  await pg.sql.unsafe(
    `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at, duration)
     VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $7, $8)`,
    [opts.id, opts.workspaceId ?? WORKSPACE_ID, opts.parentId ?? "0", opts.workflowRef, opts.status, ORG, date, opts.duration ?? null],
  )
}

async function pgSeedNodeExecution(opts: {
  id: string
  executionId: string
  nodeId: string
  nodeType: string
  status: string
  duration?: number | null
  error?: string | null
  exitCode?: number | null
  daysAgo?: number
}) {
  const daysAgo = opts.daysAgo ?? 0
  const date = new Date(Date.now() - daysAgo * 86400000).toISOString()
  await pg.sql.unsafe(
    `INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, duration, error, exit_code)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9)`,
    [opts.id, opts.executionId, opts.nodeId, opts.nodeType, opts.status, date, opts.duration ?? null, opts.error ?? null, opts.exitCode ?? null],
  )
}

// ── SQLite 侧造数（仅 execDao：getExecutionLogs 读路径）────────────
function seedWorkspace() {
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(WORKSPACE_ID, "test-ws", ORG, "/tmp/test-ws", now, now)
}

beforeEach(async () => {
  pg = await setupPgSchema()
  db = new Database(":memory:")
  applySchema(db)
  service = new LogAnalysisService(new TokenUsageDAO(pg.sql), new ExecutionDAO(db))
  await pgSeedWorkspace(WORKSPACE_ID)
  seedWorkspace()
})

afterEach(async () => {
  db.close()
  await pg.close()
})

describePg("getHealthSummary", () => {
  it("返回空数据的摘要", async () => {
    const result = await service.getHealthSummary(WORKSPACE_ID, 30)
    expect(result.totalExecutions).toBe(0)
    expect(result.successRate).toBe(0)
    expect(result.failureRate).toBe(0)
    expect(result.dailyTrend).toEqual([])
  })

  it("计算成功率和失败率", async () => {
    await pgSeedExecution({ id: "e1", workflowRef: "wf-a", status: "completed", daysAgo: 1 })
    await pgSeedExecution({ id: "e2", workflowRef: "wf-a", status: "completed", daysAgo: 2 })
    await pgSeedExecution({ id: "e3", workflowRef: "wf-a", status: "failed", daysAgo: 3 })

    const result = await service.getHealthSummary(WORKSPACE_ID, 30)
    expect(result.totalExecutions).toBe(3)
    expect(result.successRate).toBeCloseTo(66.7, 0)
    expect(result.failureRate).toBeCloseTo(33.3, 0)
  })

  it("生成每日趋势数据", async () => {
    await pgSeedExecution({ id: "e1", workflowRef: "wf-a", status: "completed", daysAgo: 1 })
    await pgSeedExecution({ id: "e2", workflowRef: "wf-a", status: "failed", daysAgo: 1 })
    await pgSeedExecution({ id: "e3", workflowRef: "wf-a", status: "completed", daysAgo: 3 })

    const result = await service.getHealthSummary(WORKSPACE_ID, 7)
    expect(result.dailyTrend.length).toBeGreaterThan(0)
    const today = result.dailyTrend.find(d => d.successCount + d.failedCount === 2)
    expect(today).toBeDefined()
    expect(today!.successCount).toBe(1)
    expect(today!.failedCount).toBe(1)
  })

  it("只统计指定 workspace 的数据", async () => {
    const otherWs = "ws-other"
    await pgSeedWorkspace(otherWs, "other")
    await pgSeedExecution({ id: "e1", workflowRef: "wf-a", status: "completed" })
    await pgSeedExecution({ id: "e-other", workspaceId: otherWs, workflowRef: "wf-b", status: "failed" })

    const result = await service.getHealthSummary(WORKSPACE_ID, 30)
    expect(result.totalExecutions).toBe(1)
  })
})

describePg("getFailurePatterns", () => {
  it("返回空数据的失败模式", async () => {
    const result = await service.getFailurePatterns(WORKSPACE_ID, 30)
    expect(result.errorCategories).toEqual([])
    expect(result.fragilityRanking).toEqual([])
    expect(result.failureChains).toEqual([])
  })

  it("按 exit_code 分类错误", async () => {
    await pgSeedExecution({ id: "e1", workflowRef: "wf-a", status: "failed", daysAgo: 1 })
    await pgSeedNodeExecution({ id: "ne1", executionId: "e1", nodeId: "step-1", nodeType: "bash", status: "failed", exitCode: 124, error: "timeout", daysAgo: 1 })
    await pgSeedNodeExecution({ id: "ne2", executionId: "e1", nodeId: "step-2", nodeType: "bash", status: "failed", exitCode: 1, error: "script error", daysAgo: 1 })

    const result = await service.getFailurePatterns(WORKSPACE_ID, 30)
    expect(result.errorCategories.length).toBeGreaterThan(0)
    const timeoutCat = result.errorCategories.find(c => c.category === "timeout")
    expect(timeoutCat).toBeDefined()
    expect(timeoutCat!.count).toBe(1)
  })

  it("计算节点脆弱度排行", async () => {
    // Create a fragile node (high failure rate)
    for (let i = 0; i < 5; i++) {
      await pgSeedExecution({ id: `e-frag-${i}`, workflowRef: "wf-fragile", status: "failed", daysAgo: i })
      await pgSeedNodeExecution({
        id: `ne-frag-${i}`,
        executionId: `e-frag-${i}`,
        nodeId: "fragile-step",
        nodeType: "bash",
        status: "failed",
        exitCode: 1,
        error: "error",
        daysAgo: i
      })
    }

    const result = await service.getFailurePatterns(WORKSPACE_ID, 30)
    expect(result.fragilityRanking.length).toBeGreaterThan(0)
    const fragileNode = result.fragilityRanking.find(n => n.nodeId === "fragile-step")
    expect(fragileNode).toBeDefined()
    expect(fragileNode!.failures).toBe(5)
    expect(fragileNode!.failureRate).toBe(100)
  })
})

describePg("getAnomalies", () => {
  it("返回空数据的异常检测", async () => {
    const result = await service.getAnomalies(WORKSPACE_ID, 30)
    expect(result.durationAnomalies).toEqual([])
    expect(result.consecutiveFailures).toEqual([])
    expect(result.costAnomalies).toEqual([])
  })

  it("检测连续失败", async () => {
    for (let i = 0; i < 4; i++) {
      await pgSeedExecution({ id: `e-streak-${i}`, workflowRef: "wf-streak", status: "failed", daysAgo: i })
    }
    const result = await service.getAnomalies(WORKSPACE_ID, 30)
    expect(result.consecutiveFailures.length).toBe(1)
    expect(result.consecutiveFailures[0].streakLength).toBe(4)
    expect(result.consecutiveFailures[0].workflowRef).toBe("wf-streak")
  })

  it("检测耗时异常（Z-Score）", async () => {
    // Create 15 normal executions
    for (let i = 0; i < 15; i++) {
      await pgSeedExecution({ id: `e-normal-${i}`, workflowRef: "wf-anomaly", status: "completed", daysAgo: i, duration: 1000 })
      await pgSeedNodeExecution({
        id: `ne-normal-${i}`,
        executionId: `e-normal-${i}`,
        nodeId: "normal-step",
        nodeType: "bash",
        status: "completed",
        duration: 1000,
        daysAgo: i
      })
    }
    // Create 1 anomalous execution (10x duration)
    await pgSeedExecution({ id: "e-anomaly", workflowRef: "wf-anomaly", status: "completed", daysAgo: 0, duration: 10000 })
    await pgSeedNodeExecution({
      id: "ne-anomaly",
      executionId: "e-anomaly",
      nodeId: "normal-step",
      nodeType: "bash",
      status: "completed",
      duration: 10000,
      daysAgo: 0
    })

    const result = await service.getAnomalies(WORKSPACE_ID, 30)
    expect(result.durationAnomalies.length).toBeGreaterThan(0)
    const anomaly = result.durationAnomalies.find(a => a.executionId === "e-anomaly")
    expect(anomaly).toBeDefined()
    expect(anomaly!.zScore).toBeGreaterThan(2)
  })
})

describePg("getCostAnalysis", () => {
  it("返回空数据的成本分析", async () => {
    const result = await service.getCostAnalysis(WORKSPACE_ID, 30)
    expect(result.costTrend).toEqual([])
    expect(result.tokenDistribution).toEqual([])
    expect(result.costByWorkflow).toEqual([])
  })

  it("计算成本趋势", async () => {
    // Create executions with token usage
    for (let i = 0; i < 3; i++) {
      const daysAgo = i
      const date = new Date(Date.now() - daysAgo * 86400000).toISOString()
      const execId = `e-cost-${i}`
      const nodeId = `ne-cost-${i}`

      await pgSeedExecution({ id: execId, workflowRef: "wf-cost", status: "completed", daysAgo })
      await pgSeedNodeExecution({
        id: nodeId,
        executionId: execId,
        nodeId: "cost-step",
        nodeType: "agent",
        status: "completed",
        daysAgo
      })

      // Add token usage（NEW-r2:ntu 纯 token;钱的 0.05/笔 由事实行 × 兜底价派生）
      await pg.sql.unsafe(
        `INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, created_at)
         VALUES ($1, $2, 'claude-3', 1000, 500, $3)`,
        [`tu-${i}`, nodeId, date],
      )
      await pg.sql.unsafe(
        `INSERT INTO llm_calls (id, node_execution_id, execution_id, turn_index, call_index, model,
           timestamp, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, workspace_id, source_path)
         VALUES ($1, $2, $3, 1, 0, 'claude-3', $4, 1, 1000, 500, 0, 0, $5, 'workflow')`,
        [`lc-${i}`, nodeId, execId, new Date(date).getTime(), WORKSPACE_ID],
      )
    }

    // 兜底价 USD:1000×50/1e6 = 0.05/笔
    const t = new Date().toISOString()
    await pg.sql.unsafe(`INSERT INTO billing_price_config (id, vendor, model_id, input_unit_price,
        output_unit_price, cache_write_unit_price, cache_read_unit_price, currency, valid_from, valid_to, created_at, updated_at)
      VALUES ('pp-claude3', 'v', 'claude-3', 50, 0, 0, 0, 'USD', NULL, NULL, $1, $2)`, [t, t])

    const result = await service.getCostAnalysis(WORKSPACE_ID, 30)
    expect(result.costTrend.length).toBeGreaterThan(0)
    expect(result.costByWorkflow.length).toBe(1)
    expect(result.costByWorkflow[0].workflowRef).toBe("wf-cost")
    expect(result.costByWorkflow[0].totalCostUsd).toBeCloseTo(0.15, 2)
  })
})

describePg("getExecutionLogs", () => {
  // execDao（ExecutionDAO，B5 批）仍读 SQLite —— 该 describe 的造数落 sqlite db。
  function seedExecution(id: string, workspaceId: string, workflowRef: string, status: string) {
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, workspaceId, "0", workflowRef, workflowRef, status, ORG, now, now)
    return now
  }

  it("execution 不存在时返回空", async () => {
    const result = await service.getExecutionLogs(WORKSPACE_ID, "nonexistent")
    expect(result.contextLines).toEqual([])
    expect(result.totalLines).toBe(0)
  })

  it("日志文件不存在时返回空 contextLines", async () => {
    seedExecution("e-nolog", WORKSPACE_ID, "wf-a", "failed")
    const result = await service.getExecutionLogs(WORKSPACE_ID, "e-nolog", "step-1")
    expect(result.executionId).toBe("e-nolog")
    expect(result.contextLines).toEqual([])
  })

  it("读取 JSONL 日志并提取上下文", async () => {
    // Create a workspace with a real path
    const testWsPath = path.join(os.tmpdir(), `test-ws-${Date.now()}`)
    fs.mkdirSync(testWsPath, { recursive: true })

    const wsId = "ws-with-logs"
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(wsId, "test-ws-with-logs", ORG, testWsPath, now, now)

    // Create execution
    const execId = "e-with-logs"
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(execId, wsId, "0", "wf-log", "wf-log", "failed", ORG, now, now)

    // Create node execution with error
    db.prepare(
      `INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, error, exit_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("ne-log", execId, "step-1", "bash", "failed", now, now, "Test error", 1)

    // Create log file
    const logDir = path.join(testWsPath, "logs", execId)
    fs.mkdirSync(logDir, { recursive: true })
    const logFile = path.join(logDir, "step-1.jsonl")

    const logLines = [
      { timestamp: "2026-06-04T10:00:00Z", event: "start", data: "Starting" },
      { timestamp: "2026-06-04T10:00:01Z", event: "log", data: "Processing" },
      { timestamp: "2026-06-04T10:00:02Z", event: "error", data: "Test error" },
      { timestamp: "2026-06-04T10:00:03Z", event: "end", data: "Failed" }
    ]
    fs.writeFileSync(logFile, logLines.map(l => JSON.stringify(l)).join("\n"))

    const result = await service.getExecutionLogs(wsId, execId, "step-1")
    expect(result.executionId).toBe(execId)
    expect(result.nodeId).toBe("step-1")
    expect(result.contextLines.length).toBeGreaterThan(0)
    expect(result.exitCode).toBe(1)

    // Cleanup
    fs.rmSync(testWsPath, { recursive: true, force: true })
  })
})

describePg("缓存机制", () => {
  it("相同参数返回缓存结果", async () => {
    const result1 = await service.getHealthSummary(WORKSPACE_ID, 30)
    const result2 = await service.getHealthSummary(WORKSPACE_ID, 30)
    expect(result1).toBe(result2) // Same reference (cached)
  })

  it("不同参数返回不同结果", async () => {
    const result1 = await service.getHealthSummary(WORKSPACE_ID, 30)
    const result2 = await service.getHealthSummary(WORKSPACE_ID, 7)
    expect(result1).not.toBe(result2)
  })

  it("invalidateWorkspaceCache 清除缓存", async () => {
    const result1 = await service.getHealthSummary(WORKSPACE_ID, 30)
    service.invalidateWorkspaceCache(WORKSPACE_ID)
    const result2 = await service.getHealthSummary(WORKSPACE_ID, 30)
    expect(result1).not.toBe(result2) // Different reference (cache cleared)
  })
})
