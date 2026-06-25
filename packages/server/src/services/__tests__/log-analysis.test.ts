import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import path from "path"
import os from "os"
import fs from "fs"
import { applySchema } from "../../db/schema"
import { LogAnalysisService } from "../log-analysis"
import { TokenUsageDAO, ExecutionDAO } from "../../db/dao"

let db: Database.Database
let dbPath: string
let service: LogAnalysisService
const WORKSPACE_ID = "ws-test-001"
const ORG = "xzf"

function seedWorkspace() {
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(WORKSPACE_ID, "test-ws", ORG, "/tmp/test-ws", now, now)
}

function seedExecution(opts: {
  id: string
  workflowRef: string
  status: string
  daysAgo?: number
  duration?: number
  parentId?: string
}) {
  const daysAgo = opts.daysAgo ?? 0
  const date = new Date(Date.now() - daysAgo * 86400000).toISOString()
  db.prepare(
    `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at, duration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id, WORKSPACE_ID, opts.parentId ?? "0",
    opts.workflowRef, opts.workflowRef, opts.status,
    ORG, date, date, opts.duration ?? null
  )
}

function seedNodeExecution(opts: {
  id: string
  executionId: string
  nodeId: string
  nodeType: string
  status: string
  duration?: number
  error?: string
  exitCode?: number
  daysAgo?: number
}) {
  const daysAgo = opts.daysAgo ?? 0
  const date = new Date(Date.now() - daysAgo * 86400000).toISOString()
  db.prepare(
    `INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, duration, error, exit_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id, opts.executionId, opts.nodeId, opts.nodeType, opts.status,
    date, date, opts.duration ?? null, opts.error ?? null, opts.exitCode ?? null
  )
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-analytics-${Date.now()}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
  service = new LogAnalysisService(new TokenUsageDAO(db), new ExecutionDAO(db))
  seedWorkspace()
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

describe("getHealthSummary", () => {
  it("返回空数据的摘要", () => {
    const result = service.getHealthSummary(WORKSPACE_ID, 30)
    expect(result.totalExecutions).toBe(0)
    expect(result.successRate).toBe(0)
    expect(result.failureRate).toBe(0)
    expect(result.dailyTrend).toEqual([])
  })

  it("计算成功率和失败率", () => {
    seedExecution({ id: "e1", workflowRef: "wf-a", status: "completed", daysAgo: 1 })
    seedExecution({ id: "e2", workflowRef: "wf-a", status: "completed", daysAgo: 2 })
    seedExecution({ id: "e3", workflowRef: "wf-a", status: "failed", daysAgo: 3 })

    const result = service.getHealthSummary(WORKSPACE_ID, 30)
    expect(result.totalExecutions).toBe(3)
    expect(result.successRate).toBeCloseTo(66.7, 0)
    expect(result.failureRate).toBeCloseTo(33.3, 0)
  })

  it("生成每日趋势数据", () => {
    seedExecution({ id: "e1", workflowRef: "wf-a", status: "completed", daysAgo: 1 })
    seedExecution({ id: "e2", workflowRef: "wf-a", status: "failed", daysAgo: 1 })
    seedExecution({ id: "e3", workflowRef: "wf-a", status: "completed", daysAgo: 3 })

    const result = service.getHealthSummary(WORKSPACE_ID, 7)
    expect(result.dailyTrend.length).toBeGreaterThan(0)
    const today = result.dailyTrend.find(d => d.successCount + d.failedCount === 2)
    expect(today).toBeDefined()
    expect(today!.successCount).toBe(1)
    expect(today!.failedCount).toBe(1)
  })

  it("只统计指定 workspace 的数据", () => {
    const otherWs = "ws-other"
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(otherWs, "other", ORG, "/tmp/other", now, now)
    seedExecution({ id: "e1", workflowRef: "wf-a", status: "completed" })
    db.prepare(
      "INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("e-other", otherWs, "0", "wf-b", "wf-b", "failed", ORG, now, now)

    const result = service.getHealthSummary(WORKSPACE_ID, 30)
    expect(result.totalExecutions).toBe(1)
  })
})

describe("getFailurePatterns", () => {
  it("返回空数据的失败模式", () => {
    const result = service.getFailurePatterns(WORKSPACE_ID, 30)
    expect(result.errorCategories).toEqual([])
    expect(result.fragilityRanking).toEqual([])
    expect(result.failureChains).toEqual([])
  })

  it("按 exit_code 分类错误", () => {
    seedExecution({ id: "e1", workflowRef: "wf-a", status: "failed", daysAgo: 1 })
    seedNodeExecution({ id: "ne1", executionId: "e1", nodeId: "step-1", nodeType: "bash", status: "failed", exitCode: 124, error: "timeout", daysAgo: 1 })
    seedNodeExecution({ id: "ne2", executionId: "e1", nodeId: "step-2", nodeType: "bash", status: "failed", exitCode: 1, error: "script error", daysAgo: 1 })

    const result = service.getFailurePatterns(WORKSPACE_ID, 30)
    expect(result.errorCategories.length).toBeGreaterThan(0)
    const timeoutCat = result.errorCategories.find(c => c.category === "timeout")
    expect(timeoutCat).toBeDefined()
    expect(timeoutCat!.count).toBe(1)
  })

  it("计算节点脆弱度排行", () => {
    // Create a fragile node (high failure rate)
    for (let i = 0; i < 5; i++) {
      seedExecution({ id: `e-frag-${i}`, workflowRef: "wf-fragile", status: "failed", daysAgo: i })
      seedNodeExecution({
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

    const result = service.getFailurePatterns(WORKSPACE_ID, 30)
    expect(result.fragilityRanking.length).toBeGreaterThan(0)
    const fragileNode = result.fragilityRanking.find(n => n.nodeId === "fragile-step")
    expect(fragileNode).toBeDefined()
    expect(fragileNode!.failures).toBe(5)
    expect(fragileNode!.failureRate).toBe(100)
  })
})

describe("getAnomalies", () => {
  it("返回空数据的异常检测", () => {
    const result = service.getAnomalies(WORKSPACE_ID, 30)
    expect(result.durationAnomalies).toEqual([])
    expect(result.consecutiveFailures).toEqual([])
    expect(result.costAnomalies).toEqual([])
  })

  it("检测连续失败", () => {
    for (let i = 0; i < 4; i++) {
      seedExecution({ id: `e-streak-${i}`, workflowRef: "wf-streak", status: "failed", daysAgo: i })
    }
    const result = service.getAnomalies(WORKSPACE_ID, 30)
    expect(result.consecutiveFailures.length).toBe(1)
    expect(result.consecutiveFailures[0].streakLength).toBe(4)
    expect(result.consecutiveFailures[0].workflowRef).toBe("wf-streak")
  })

  it("检测耗时异常（Z-Score）", () => {
    // Create 15 normal executions
    for (let i = 0; i < 15; i++) {
      seedExecution({ id: `e-normal-${i}`, workflowRef: "wf-anomaly", status: "completed", daysAgo: i, duration: 1000 })
      seedNodeExecution({
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
    seedExecution({ id: "e-anomaly", workflowRef: "wf-anomaly", status: "completed", daysAgo: 0, duration: 10000 })
    seedNodeExecution({
      id: "ne-anomaly",
      executionId: "e-anomaly",
      nodeId: "normal-step",
      nodeType: "bash",
      status: "completed",
      duration: 10000,
      daysAgo: 0
    })

    const result = service.getAnomalies(WORKSPACE_ID, 30)
    expect(result.durationAnomalies.length).toBeGreaterThan(0)
    const anomaly = result.durationAnomalies.find(a => a.executionId === "e-anomaly")
    expect(anomaly).toBeDefined()
    expect(anomaly!.zScore).toBeGreaterThan(2)
  })
})

describe("getCostAnalysis", () => {
  it("返回空数据的成本分析", () => {
    const result = service.getCostAnalysis(WORKSPACE_ID, 30)
    expect(result.costTrend).toEqual([])
    expect(result.tokenDistribution).toEqual([])
    expect(result.costByWorkflow).toEqual([])
  })

  it("计算成本趋势", () => {
    // Create executions with token usage
    for (let i = 0; i < 3; i++) {
      const daysAgo = i
      const date = new Date(Date.now() - daysAgo * 86400000).toISOString()
      const execId = `e-cost-${i}`
      const nodeId = `ne-cost-${i}`

      seedExecution({ id: execId, workflowRef: "wf-cost", status: "completed", daysAgo })
      seedNodeExecution({
        id: nodeId,
        executionId: execId,
        nodeId: "cost-step",
        nodeType: "agent",
        status: "completed",
        daysAgo
      })

      // Add token usage
      db.prepare(
        `INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(`tu-${i}`, nodeId, "claude-3", 1000, 500, 0.05, date)
    }

    const result = service.getCostAnalysis(WORKSPACE_ID, 30)
    expect(result.costTrend.length).toBeGreaterThan(0)
    expect(result.costByWorkflow.length).toBe(1)
    expect(result.costByWorkflow[0].workflowRef).toBe("wf-cost")
    expect(result.costByWorkflow[0].totalCostUsd).toBeCloseTo(0.15, 2)
  })
})

describe("getExecutionLogs", () => {
  it("execution 不存在时返回空", async () => {
    const result = await service.getExecutionLogs(WORKSPACE_ID, "nonexistent")
    expect(result.contextLines).toEqual([])
    expect(result.totalLines).toBe(0)
  })

  it("日志文件不存在时返回空 contextLines", async () => {
    seedExecution({ id: "e-nolog", workflowRef: "wf-a", status: "failed" })
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

describe("缓存机制", () => {
  it("相同参数返回缓存结果", () => {
    const result1 = service.getHealthSummary(WORKSPACE_ID, 30)
    const result2 = service.getHealthSummary(WORKSPACE_ID, 30)
    expect(result1).toBe(result2) // Same reference (cached)
  })

  it("不同参数返回不同结果", () => {
    const result1 = service.getHealthSummary(WORKSPACE_ID, 30)
    const result2 = service.getHealthSummary(WORKSPACE_ID, 7)
    expect(result1).not.toBe(result2)
  })

  it("invalidateWorkspaceCache 清除缓存", () => {
    const result1 = service.getHealthSummary(WORKSPACE_ID, 30)
    service.invalidateWorkspaceCache(WORKSPACE_ID)
    const result2 = service.getHealthSummary(WORKSPACE_ID, 30)
    expect(result1).not.toBe(result2) // Different reference (cache cleared)
  })
})
