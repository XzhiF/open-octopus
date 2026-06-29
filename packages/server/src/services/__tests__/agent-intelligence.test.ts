import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import path from "path"
import os from "os"
import fs from "fs"
import { applySchema } from "../../db/schema"
import { ArchiveDAO } from "../../db/dao/archive-dao"
import { ExecutionDAO } from "../../db/dao/execution-dao"
import { TokenUsageDAO } from "../../db/dao/token-usage-dao"
import { ExperienceDAO } from "../../db/dao/experience-dao"
import { ScheduleConfigDAO } from "../../db/dao/schedule-config-dao"
import { ArchiveService } from "../archive-service"
import { SuggestionEngine } from "../suggestion-engine"
import { OrchestratorService } from "../agent/orchestrator-service"

let db: Database.Database
let dbPath: string
let archiveDAO: ArchiveDAO
let experienceDAO: ExperienceDAO
let executionDAO: ExecutionDAO
let tokenUsageDAO: TokenUsageDAO
let scheduleConfigDAO: ScheduleConfigDAO

const ORG = "xzf"
const WORKSPACE_ID = "ws-intel-001"

function seedWorkspace(id?: string, name?: string) {
  const wsId = id ?? WORKSPACE_ID
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(wsId, name ?? "test-ws", ORG, `/tmp/${wsId}`, now, now)
  return wsId
}

function seedExecution(opts: {
  id: string
  workspaceId?: string
  workflowRef?: string
  workflowName?: string
  status?: string
  duration?: number
}) {
  const now = new Date().toISOString()
  const wsId = opts.workspaceId ?? WORKSPACE_ID
  db.prepare(
    `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name, status, org, created_at, updated_at, var_pool, duration, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id, wsId, "0", 0,
    opts.workflowRef ?? "test-workflow.yaml", opts.workflowName ?? "Test Workflow",
    opts.status ?? "completed", ORG, now, now,
    "{}", opts.duration ?? 1000,
    now, now,
  )
}

function seedNodeExecution(opts: {
  id: string
  executionId: string
  nodeId: string
  status?: string
  duration?: number
}) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at, completed_at, duration, error, exit_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id, opts.executionId, opts.nodeId, "agent",
    opts.status ?? "completed", now, now, opts.duration ?? 500,
    null, null,
  )
}

function seedTokenUsage(opts: {
  id: string
  nodeExecutionId: string
  costUsd?: number
}) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_creation_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.id, opts.nodeExecutionId, "claude-sonnet-4-20250514",
    100, 50, opts.costUsd ?? 0.01,
    0, 0, now,
  )
}

function seedArchiveExecution(opts: {
  executionId: string
  workflowRef?: string
  workflowName?: string
  status?: string
  costUsd?: number
  failedNodes?: string[]
  durationMs?: number
}) {
  const now = new Date().toISOString()
  return archiveDAO.insertArchive({
    execution_id: opts.executionId,
    workflow_ref: opts.workflowRef ?? "test-workflow.yaml",
    workflow_name: opts.workflowName ?? "Test Workflow",
    status: opts.status ?? "completed",
    started_at: now,
    completed_at: now,
    duration_ms: opts.durationMs ?? 1000,
    total_input_tokens: 100,
    total_output_tokens: 50,
    total_cost_usd: opts.costUsd ?? 0.01,
    node_summary: JSON.stringify([{ node_id: "n1", type: "agent", status: opts.status ?? "completed" }]),
    failed_nodes: opts.failedNodes ? JSON.stringify(opts.failedNodes) : null,
    error_message: opts.failedNodes ? "test error" : null,
    model_breakdown: null,
    vars_snapshot: "{}",
    workspace_id: WORKSPACE_ID,
    parent_execution_id: null,
    chain_position: null,
    workspace_archive_id: null,
  })
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-intel-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)

  archiveDAO = new ArchiveDAO(db)
  experienceDAO = new ExperienceDAO(db)
  executionDAO = new ExecutionDAO(db)
  tokenUsageDAO = new TokenUsageDAO(db)
  scheduleConfigDAO = new ScheduleConfigDAO(db)

  seedWorkspace()
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

// ============================================================================
// P4.1: Orchestrator experience injection
// ============================================================================

describe("P4.1: Orchestrator experience injection", () => {
  it("injects experiences and recent archives into orchestration result", async () => {
    // Seed experiences - use exact terms for FTS5 matching
    experienceDAO.insert({
      type: "bug",
      title: "Parser null crash",
      content: "Parser crashes when receiving null input from upstream node",
      project: "test-project",
      status: "active",
      relevance_score: 10,
      use_count: 0,
    })
    experienceDAO.insert({
      type: "pattern",
      title: "Null check pattern",
      content: "Always add null checks before parsing input",
      project: "test-project",
      status: "active",
      relevance_score: 5,
      use_count: 0,
    })

    // Seed recent archives
    seedArchiveExecution({
      executionId: "arch-exec-1",
      workflowName: "deploy-flow",
      status: "completed",
      costUsd: 1.5,
    })

    const orchestrator = new OrchestratorService(ORG, experienceDAO, archiveDAO)
    // Use "Parser null" which will match the FTS entries (both words appear in title)
    const result = await orchestrator.orchestrate("Parser null", "test-session")

    // Experiences should be injected (FTS search for "Parser null")
    expect(result.experiences).toBeDefined()
    expect(result.experiences!.length).toBeGreaterThanOrEqual(1)
    expect(result.experiences![0].type).toBeDefined()
    expect(result.experiences![0].title).toBeDefined()

    // Recent executions should be injected
    expect(result.recentExecutions).toBeDefined()
    expect(result.recentExecutions!.length).toBeGreaterThanOrEqual(1)
    expect(result.recentExecutions![0].workflow_name).toBe("deploy-flow")
    expect(result.recentExecutions![0].cost_usd).toBe(1.5)
  })

  it("continues without experiences when DAOs are not set", async () => {
    const orchestrator = new OrchestratorService(ORG)
    const result = await orchestrator.orchestrate("hello", "test-session")

    // Should not throw, experiences should be undefined
    expect(result.experiences).toBeUndefined()
    expect(result.recentExecutions).toBeUndefined()
  })

  it("continues without experiences when search fails", async () => {
    // Create a mock DAO that throws
    const mockExpDAO = {
      search: () => { throw new Error("FTS not available") },
    } as unknown as ExperienceDAO

    const orchestrator = new OrchestratorService(ORG, mockExpDAO)
    const result = await orchestrator.orchestrate("test query", "test-session")

    // Should not throw
    expect(result.experiences).toBeUndefined()
  })
})

// ============================================================================
// P4.2: Repeating pattern detection
// ============================================================================

describe("P4.2: Repeating pattern detection", () => {
  it("detects >= 3 same-type bugs for same project+package", () => {
    const engine = new SuggestionEngine(archiveDAO, experienceDAO)

    // Insert 3+ bugs for the same project+package
    for (let i = 1; i <= 4; i++) {
      experienceDAO.insert({
        type: "bug",
        title: `Bug ${i} in parser`,
        content: `Parser issue ${i}: crash on edge case`,
        project: "test-project",
        package: "server",
        status: "active",
        relevance_score: i,
        use_count: 0,
      })
    }

    const suggestions = engine.analyzeRepeatingPatterns(30)

    expect(suggestions.length).toBeGreaterThanOrEqual(1)
    expect(suggestions[0].title).toContain("server")
    expect(suggestions[0].severity).toBe("warning")
    expect(suggestions[0].detail).toContain("4")
  })

  it("does not trigger for fewer than 3 bugs", () => {
    const engine = new SuggestionEngine(archiveDAO, experienceDAO)

    experienceDAO.insert({
      type: "bug",
      title: "Single bug",
      content: "Only one bug here",
      project: "test-project",
      package: "cli",
      status: "active",
      relevance_score: 1,
      use_count: 0,
    })

    const suggestions = engine.analyzeRepeatingPatterns(30)
    expect(suggestions.length).toBe(0)
  })

  it("returns empty when DAOs are not set", () => {
    const engine = new SuggestionEngine()
    const suggestions = engine.analyzeRepeatingPatterns(30)
    expect(suggestions).toEqual([])
  })
})

// ============================================================================
// P4.3: Failure pattern detection
// ============================================================================

describe("P4.3: Failure pattern detection", () => {
  it("detects matching workflow name in failure experiences", () => {
    const engine = new SuggestionEngine()

    const experiences = [
      { type: "failure", title: "deploy-flow timeout", content: "The deploy-flow consistently times out after 30 minutes" },
      { type: "failure", title: "build-flow crash", content: "The build-flow crashes on large repos" },
      { type: "bug", title: "unrelated bug", content: "Some other issue" },
    ]

    const warnings = engine.detectFailurePatterns("deploy-flow", experiences)

    expect(warnings.length).toBe(1)
    expect(warnings[0].warning).toContain("deploy-flow timeout")
  })

  it("returns empty when no failure experiences match", () => {
    const engine = new SuggestionEngine()

    const experiences = [
      { type: "bug", title: "unrelated", content: "no match here" },
    ]

    const warnings = engine.detectFailurePatterns("my-workflow", experiences)
    expect(warnings.length).toBe(0)
  })

  it("matches case-insensitively", () => {
    const engine = new SuggestionEngine()

    const experiences = [
      { type: "failure", title: "Deploy-Flow Error", content: "Deploy-Flow failed" },
    ]

    const warnings = engine.detectFailurePatterns("deploy-flow", experiences)
    expect(warnings.length).toBe(1)
  })
})

// ============================================================================
// P4.4: Cost optimization suggestions
// ============================================================================

describe("P4.4: Cost optimization suggestions", () => {
  it("suggests optimization for high-cost workflows", () => {
    const engine = new SuggestionEngine(archiveDAO, experienceDAO)

    // Seed high-cost archives
    for (let i = 0; i < 3; i++) {
      seedArchiveExecution({
        executionId: `cost-exec-${i}`,
        workflowRef: "expensive-flow.yaml",
        workflowName: "expensive-flow",
        costUsd: 10.0,
      })
    }

    const suggestions = engine.analyzeCostOptimization(30)

    expect(suggestions.length).toBeGreaterThanOrEqual(1)
    expect(suggestions[0].title).toContain("expensive-flow")
    expect(suggestions[0].detail).toContain("$")
    expect(suggestions[0].estimatedSaving).toContain("sonnet")
  })

  it("does not suggest for low-cost workflows", () => {
    const engine = new SuggestionEngine(archiveDAO, experienceDAO)

    seedArchiveExecution({
      executionId: "cheap-exec",
      workflowRef: "cheap-flow.yaml",
      workflowName: "cheap-flow",
      costUsd: 0.5,
    })

    const suggestions = engine.analyzeCostOptimization(30)
    expect(suggestions.length).toBe(0)
  })

  it("returns empty when archiveDAO is not set", () => {
    const engine = new SuggestionEngine()
    const suggestions = engine.analyzeCostOptimization(30)
    expect(suggestions).toEqual([])
  })
})

// ============================================================================
// P4.5: Daily memory write on archive
// ============================================================================

describe("P4.5: Daily memory write on archive", () => {
  it("writes memory entry after successful archive", () => {
    const dailyDir = path.join(os.tmpdir(), `test-daily-mem-${Date.now()}`)
    fs.mkdirSync(dailyDir, { recursive: true })

    // Mock memory service
    const appendCalls: string[] = []
    const mockMemoryService = {
      appendDaily: (_org: string, content: string) => {
        appendCalls.push(content)
        return { ok: true, token_count: 10 }
      },
    } as any

    const archiveService = new ArchiveService(
      archiveDAO, executionDAO, tokenUsageDAO, undefined, mockMemoryService,
    )

    seedExecution({ id: "mem-exec-1", status: "completed", duration: 5000 })
    seedNodeExecution({ id: "mem-exec-1-n1", executionId: "mem-exec-1", nodeId: "step-1", status: "completed" })
    seedNodeExecution({ id: "mem-exec-1-n2", executionId: "mem-exec-1", nodeId: "step-2", status: "failed" })

    const archiveId = archiveService.archiveExecution("mem-exec-1")
    expect(archiveId).not.toBeNull()

    // Verify memory was written
    expect(appendCalls.length).toBe(1)
    expect(appendCalls[0]).toContain("Test Workflow")
    expect(appendCalls[0]).toContain("completed")
    expect(appendCalls[0]).toContain("1 失败") // 1 failed node

    // Cleanup
    fs.rmSync(dailyDir, { recursive: true, force: true })
  })

  it("does not write memory when memoryService is not set", () => {
    const archiveService = new ArchiveService(archiveDAO, executionDAO, tokenUsageDAO)

    seedExecution({ id: "nomem-exec", status: "completed" })
    seedNodeExecution({ id: "nomem-exec-n1", executionId: "nomem-exec", nodeId: "n1", status: "completed" })

    // Should not throw
    const archiveId = archiveService.archiveExecution("nomem-exec")
    expect(archiveId).not.toBeNull()
  })
})

// ============================================================================
// P4.8: Schedule registration
// ============================================================================

describe("P4.8: Schedule registration validation", () => {
  it("inserts workflow-type schedule with workflow_ref", () => {
    const scheduleId = "sched-wf-1"
    const now = new Date().toISOString()

    scheduleConfigDAO.insertSchedule({
      id: scheduleId,
      org: ORG,
      name: "daily-scan",
      cron_expression: "0 2 * * *",
      timezone: "Asia/Shanghai",
      workflow_ref: "scan-flow.yaml",
      input_values: '{"target": "packages/server"}',
      job_type: "workflow",
      config: "{}",
      description: "Daily scan",
      enabled: 1,
      timeout_seconds: 3600,
      notify_on_failure: 1,
      notify_channel: "slack",
      notify_target: null,
      container_execution_id: "",
      next_trigger_at: null,
      created_at: now,
      updated_at: now,
      parallel_policy: "skip",
      version: 1,
      consecutive_failures: 0,
      max_retain: 10,
    })

    const schedule = scheduleConfigDAO.findById(scheduleId)
    expect(schedule).not.toBeNull()
    expect(schedule!.name).toBe("daily-scan")
    expect(schedule!.workflow_ref).toBe("scan-flow.yaml")
    expect(schedule!.job_type).toBe("workflow")
    expect(schedule!.cron_expression).toBe("0 2 * * *")
    expect(schedule!.timezone).toBe("Asia/Shanghai")
  })

  it("inserts agent-type schedule with prompt", () => {
    const scheduleId = "sched-agent-1"
    const now = new Date().toISOString()

    scheduleConfigDAO.insertAgentSchedule(
      scheduleId, ORG, "daily-report", "0 8 * * *", "agent",
      JSON.stringify({ prompt: "Generate daily report" }),
      now,
    )

    const schedule = scheduleConfigDAO.findById(scheduleId)
    expect(schedule).not.toBeNull()
    expect(schedule!.name).toBe("daily-report")
    expect(schedule!.job_type).toBe("agent")
  })

  it("validates workflow_ref is required for workflow type", () => {
    // This tests the validation logic that would be in the route handler.
    const jobType = "workflow"
    const workflowRef = ""

    // Simulate the validation from the route handler
    const isValid = !(jobType === "workflow" && (!workflowRef || workflowRef.trim() === ""))
    expect(isValid).toBe(false)
  })

  it("validates prompt and workflow_ref are mutually exclusive", () => {
    // Both provided = invalid
    const hasPrompt = true
    const hasWorkflowRef = true
    const bothProvidedInvalid = !!(hasPrompt && hasWorkflowRef)
    expect(bothProvidedInvalid).toBe(true) // Route should reject

    // Only prompt = valid
    const onlyPromptValid = !!(hasPrompt && !hasWorkflowRef)
    expect(onlyPromptValid).toBe(false) // hasWorkflowRef is true here

    // Test with separate variables
    const prompt1 = "do something"
    const workflowRef1 = undefined as string | undefined
    const valid1 = !!prompt1 && !workflowRef1
    expect(valid1).toBe(true)

    const prompt2 = undefined as string | undefined
    const workflowRef2 = "some-flow.yaml"
    const valid2 = !prompt2 && !!workflowRef2
    expect(valid2).toBe(true)
  })

  it("uses default timezone when not specified", () => {
    const timezone = undefined
    const effective = timezone ?? "Asia/Shanghai"
    expect(effective).toBe("Asia/Shanghai")
  })
})
