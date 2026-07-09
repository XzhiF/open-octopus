import { describe, it, expect } from "vitest"
import type { ArchiveContext, ExistingRule } from "../context-builder"
import type {
  AnalysisReport,
  ExperienceCandidate,
  SkillCandidate,
} from "../analysis-assembler"
import {
  assembleAnalysis,
  computeStats,
  deduplicateExperiences,
  detectConflicts,
  rankExperiences,
  rankSkills,
} from "../analysis-assembler"

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ArchiveContext> = {}): ArchiveContext {
  return {
    workspace: {
      id: "ws-1",
      name: "my-workspace",
      org: "test-org",
      description: "Test workspace",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-11T00:00:00Z",
      lifespan_days: 10,
    },
    executions: [
      { index: 0, workflow_name: "deploy", status: "completed", duration_s: 40, cost: 0.1, started_at: "2024-01-02T00:00:00Z", failedNodes: [] },
      { index: 1, workflow_name: "deploy", status: "completed", duration_s: 60, cost: 0.2, started_at: "2024-01-05T00:00:00Z", failedNodes: [] },
      { index: 2, workflow_name: "review", status: "failed", duration_s: 20, cost: 0.05, started_at: "2024-01-08T00:00:00Z", failedNodes: [] },
      { index: 3, workflow_name: "deploy", status: "completed", duration_s: 80, cost: 0.15, started_at: "2024-01-10T00:00:00Z", failedNodes: [] },
    ],
    workflows: [
      { name: "deploy", count: 3, successCount: 2, failCount: 1, successRate: 0.667, avgCost: 0.15, avgDuration_s: 60, nodeTypes: ["agent"], costTrend: "stable", costTrendDirection: "stable" },
      { name: "review", count: 1, successCount: 0, failCount: 1, successRate: 0, avgCost: 0.05, avgDuration_s: 20, nodeTypes: ["agent"], costTrend: "stable", costTrendDirection: "stable" },
    ],
    errorCatalog: [],
    costProfile: { total_cost: 0.5, daily_avg: 0.05, trend_direction: "stable", trend_pct: 0, modelBreakdown: [] },
    nodePatterns: [],
    existingKnowledge: [],
    ...overrides,
  }
}

function makeReport(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    summary: "Test summary",
    execution_patterns: [],
    cost_efficiency: { rating: "efficient", analysis: "Good", optimization_ideas: [] },
    error_patterns: [],
    recommendations: [],
    ...overrides,
  }
}

function makeExp(overrides: Partial<ExperienceCandidate> = {}): ExperienceCandidate {
  return {
    id: "exp-1",
    text: "Always use parameterized queries",
    scope: "global",
    target: "all",
    confidence: 0.9,
    evidence: "deploy,review",
    category: "security",
    conflicts: [],
    ...overrides,
  }
}

function makeSkill(overrides: Partial<SkillCandidate> = {}): SkillCandidate {
  return {
    name: "deploy-helper",
    description: "Automated deploy skill",
    content_outline: ["step1", "step2"],
    reason: "repeated pattern",
    evidence_workflows: ["deploy"],
    evidence_executions: [0, 1],
    estimated_reuse: "high",
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("computeStats", () => {
  it("computes stats from context", () => {
    const ctx = makeCtx()
    const stats = computeStats(ctx)

    expect(stats.execution_count).toBe(4)
    expect(stats.success_rate).toBe(75) // 3 completed out of 4
    expect(stats.total_cost).toBe(0.5)
    expect(stats.total_duration_ms).toBe(200_000) // 40+60+20+80 = 200 seconds
    expect(stats.avg_cost_per_execution).toBe(0.125)
    expect(stats.avg_duration_ms).toBe(50_000)
    expect(stats.lifespan_days).toBe(10)
    expect(stats.workflow_count).toBe(2)
  })

  it("handles empty executions", () => {
    const ctx = makeCtx({ executions: [] })
    const stats = computeStats(ctx)

    expect(stats.execution_count).toBe(0)
    expect(stats.success_rate).toBe(0)
    expect(stats.total_cost).toBe(0)
    expect(stats.total_duration_ms).toBe(0)
    expect(stats.avg_cost_per_execution).toBe(0)
    expect(stats.avg_duration_ms).toBe(0)
  })
})

describe("deduplicateExperiences", () => {
  it("keeps highest confidence per normalized text", () => {
    const exps: ExperienceCandidate[] = [
      makeExp({ id: "a", text: "Always use parameterized queries", confidence: 0.7 }),
      makeExp({ id: "b", text: "  always  use   parameterized  QUERIES  ", confidence: 0.95 }),
      makeExp({ id: "c", text: "Prefer composition over inheritance", confidence: 0.8 }),
    ]

    const result = deduplicateExperiences(exps)
    expect(result).toHaveLength(2)

    const paramQuery = result.find((e) => e.id === "b")
    expect(paramQuery).toBeDefined()
    expect(paramQuery!.confidence).toBe(0.95)
  })

  it("returns empty for empty input", () => {
    expect(deduplicateExperiences([])).toEqual([])
  })
})

describe("detectConflicts", () => {
  it("detects overlap when keyword overlap > 60%", () => {
    const exps = [makeExp({ id: "e1", text: "Always use parameterized queries for database access" })]
    const rules: ExistingRule[] = [
      { id: "r1", text: "Always use parameterized queries for safe database", scope: "global" },
    ]

    const result = detectConflicts(exps, rules)
    expect(result[0].conflicts).toHaveLength(1)
    expect(result[0].conflicts[0].type).toBe("overlaps")
    expect(result[0].conflicts[0].existingRule).toBe("r1")
  })

  it("detects contradiction when opposite verbs present", () => {
    const exps = [makeExp({ id: "e1", text: "Always use async handlers for all operations" })]
    const rules: ExistingRule[] = [
      { id: "r1", text: "Never use async handlers for these operations", scope: "global" },
    ]

    const result = detectConflicts(exps, rules)
    expect(result[0].conflicts).toHaveLength(1)
    expect(result[0].conflicts[0].type).toBe("contradicts")
  })

  it("detects contradiction with short verb pairs (use/avoid, add/remove)", () => {
    const exps = [makeExp({ id: "e1", text: "Use parameterized queries for all database access" })]
    const rules: ExistingRule[] = [
      { id: "r1", text: "Avoid parameterized queries for cached database reads", scope: "global" },
    ]

    const result = detectConflicts(exps, rules)
    expect(result[0].conflicts).toHaveLength(1)
    expect(result[0].conflicts[0].type).toBe("contradicts")
  })

  it("does not flag when keyword overlap is low", () => {
    const exps = [makeExp({ id: "e1", text: "Use parameterized SQL queries" })]
    const rules: ExistingRule[] = [
      { id: "r1", text: "Deploy infrastructure with terraform modules", scope: "global" },
    ]

    const result = detectConflicts(exps, rules)
    expect(result[0].conflicts).toHaveLength(0)
  })

  it("appends to existing conflicts without replacing", () => {
    const exps = [
      makeExp({
        id: "e1",
        text: "Always use parameterized queries for database",
        conflicts: [{ existingRule: "pre-existing", type: "overlaps" }],
      }),
    ]
    const rules: ExistingRule[] = [
      { id: "r1", text: "Always use parameterized queries for safe database", scope: "global" },
    ]

    const result = detectConflicts(exps, rules)
    expect(result[0].conflicts).toHaveLength(2)
    expect(result[0].conflicts[0].existingRule).toBe("pre-existing")
    expect(result[0].conflicts[1].existingRule).toBe("r1")
  })

  it("handles empty rules", () => {
    const exps = [makeExp()]
    const result = detectConflicts(exps, [])
    expect(result[0].conflicts).toHaveLength(0)
  })
})

describe("rankExperiences", () => {
  it("sorts by confidence * evidenceCount descending", () => {
    const exps: ExperienceCandidate[] = [
      makeExp({ id: "a", confidence: 0.5, evidence: "deploy" }), // score = 0.5 * 1 = 0.5
      makeExp({ id: "b", confidence: 0.9, evidence: "deploy,review,test" }), // score = 0.9 * 3 = 2.7
      makeExp({ id: "c", confidence: 0.8, evidence: "deploy,review" }), // score = 0.8 * 2 = 1.6
    ]

    const result = rankExperiences(exps)
    expect(result.map((e) => e.id)).toEqual(["b", "c", "a"])
  })

  it("treats empty evidence as count 1", () => {
    const exps: ExperienceCandidate[] = [
      makeExp({ id: "a", confidence: 0.5, evidence: "" }), // score = 0.5 * 1 = 0.5
      makeExp({ id: "b", confidence: 0.3, evidence: "" }), // score = 0.3 * 1 = 0.3
    ]

    const result = rankExperiences(exps)
    expect(result.map((e) => e.id)).toEqual(["a", "b"])
  })
})

describe("rankSkills", () => {
  it("sorts by reuse order then evidence_workflows length", () => {
    const skills: SkillCandidate[] = [
      makeSkill({ name: "low", estimated_reuse: "low", evidence_workflows: ["a", "b", "c"] }),
      makeSkill({ name: "high-1", estimated_reuse: "high", evidence_workflows: ["a"] }),
      makeSkill({ name: "high-2", estimated_reuse: "high", evidence_workflows: ["a", "b"] }),
      makeSkill({ name: "med", estimated_reuse: "medium", evidence_workflows: ["a"] }),
    ]

    const result = rankSkills(skills)
    expect(result.map((s) => s.name)).toEqual(["high-2", "high-1", "med", "low"])
  })
})

describe("assembleAnalysis", () => {
  it("assembles full preview from all inputs", () => {
    const ctx = makeCtx()
    const report = makeReport()
    const exps = [
      makeExp({ id: "e1", text: "Always use parameterized queries", confidence: 0.9, evidence: "deploy,review" }),
      makeExp({ id: "e2", text: "Prefer composition over inheritance", confidence: 0.7, evidence: "test" }),
    ]
    const skills = [makeSkill()]

    const preview = assembleAnalysis(ctx, report, exps, skills)

    expect(preview.stats.execution_count).toBe(4)
    expect(preview.stats.success_rate).toBe(75)
    expect(preview.analysis).toBe(report)
    expect(preview.experiences).toHaveLength(2)
    expect(preview.skills).toHaveLength(1)
  })

  it("deduplicates and ranks experiences in output", () => {
    const ctx = makeCtx()
    const report = makeReport()
    const exps = [
      makeExp({ id: "dup1", text: "use parameterized queries", confidence: 0.5 }),
      makeExp({ id: "dup2", text: "USE   parameterized   queries", confidence: 0.9 }),
      makeExp({ id: "unique", text: "prefer immutability", confidence: 0.8 }),
    ]

    const preview = assembleAnalysis(ctx, report, exps, [])
    // After dedup, should have 2 experiences
    expect(preview.experiences).toHaveLength(2)
    // dup2 (higher confidence) should come first (0.9 > 0.8)
    expect(preview.experiences[0].id).toBe("dup2")
  })

  it("handles empty inputs", () => {
    const ctx = makeCtx({ executions: [] })
    const report = makeReport()
    const preview = assembleAnalysis(ctx, report, [], [])

    expect(preview.stats.execution_count).toBe(0)
    expect(preview.experiences).toEqual([])
    expect(preview.skills).toEqual([])
    expect(preview.analysis).toBe(report)
  })
})
