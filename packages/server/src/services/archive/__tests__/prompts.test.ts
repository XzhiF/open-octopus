import { describe, it, expect } from "vitest"
import type { ArchiveContext } from "../context-builder"
import {
  buildRetrospectivePrompt,
  buildExperiencePrompt,
  buildSkillDiscoveryPrompt,
} from "../prompts"

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ArchiveContext> = {}): ArchiveContext {
  return {
    workspace: {
      id: "ws-1",
      name: "my-workspace",
      org: "test-org",
      description: "Test workspace for unit testing",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-02-01T00:00:00Z",
      lifespan_days: 31,
    },
    executions: [
      {
        index: 0,
        workflow_name: "deploy-flow",
        status: "completed",
        duration_s: 45.2,
        cost: 0.12,
        started_at: "2024-01-15T10:00:00Z",
        failedNodes: [],
      },
      {
        index: 1,
        workflow_name: "deploy-flow",
        status: "failed",
        duration_s: 12.5,
        cost: 0.05,
        started_at: "2024-01-20T14:00:00Z",
        failedNodes: [
          {
            node_id: "step-build",
            node_type: "agent",
            errorSnippet: "Error: build failed with exit code 1",
          },
        ],
      },
      {
        index: 2,
        workflow_name: "review-flow",
        status: "completed",
        duration_s: 30.0,
        cost: 0.08,
        started_at: "2024-01-25T09:00:00Z",
        failedNodes: [],
      },
    ],
    workflows: [
      {
        name: "deploy-flow",
        count: 2,
        successCount: 1,
        failCount: 1,
        successRate: 0.5,
        avgCost: 0.085,
        avgDuration_s: 28.85,
        nodeTypes: ["agent", "bash"],
        costTrend: "stable",
        costTrendDirection: "stable",
      },
      {
        name: "review-flow",
        count: 1,
        successCount: 1,
        failCount: 0,
        successRate: 1.0,
        avgCost: 0.08,
        avgDuration_s: 30.0,
        nodeTypes: ["agent"],
        costTrend: "stable",
        costTrendDirection: "stable",
      },
    ],
    errorCatalog: [
      {
        node_id: "step-build",
        workflow_name: "deploy-flow",
        frequency: 3,
        errorSnippet: "Error: build failed with exit code 1",
        lastOccurred: "2024-01-20T14:00:00Z",
        workflowCount: 1,
      },
    ],
    costProfile: {
      total_cost: 0.25,
      daily_avg: 0.008,
      trend_direction: "stable",
      trend_pct: 0,
      modelBreakdown: [
        { model: "claude-sonnet-4-20250514", calls: 10, tokens: 50000, cost: 0.2 },
        { model: "claude-haiku-4-20250414", calls: 5, tokens: 20000, cost: 0.05 },
      ],
    },
    nodePatterns: [
      {
        node_type: "agent",
        node_id: "step-build",
        frequency: 5,
        successRate: 0.8,
        avgDuration_s: 15.0,
        workflowNames: ["deploy-flow"],
      },
      {
        node_type: "bash",
        node_id: "step-test",
        frequency: 3,
        successRate: 1.0,
        avgDuration_s: 5.0,
        workflowNames: ["deploy-flow", "review-flow"],
      },
    ],
    existingKnowledge: [
      { id: "rule-1", text: "Always run tests before deploying", scope: "workspace" },
      { id: "rule-2", text: "Use staging environment for review workflows", scope: "workflow" },
    ],
    totalExecutionCount: 3,
    totalSuccessCount: 2,
    ...overrides,
  }
}

function makeEmptyCtx(): ArchiveContext {
  return makeCtx({
    executions: [],
    workflows: [],
    errorCatalog: [],
    costProfile: {
      total_cost: 0,
      daily_avg: 0,
      trend_direction: "stable",
      trend_pct: 0,
      modelBreakdown: [],
    },
    nodePatterns: [],
    existingKnowledge: [],
    totalExecutionCount: 0,
    totalSuccessCount: 0,
  })
}

// ── buildRetrospectivePrompt ────────────────────────────────────────────────

describe("buildRetrospectivePrompt", () => {
  it("contains workspace name and key stats", () => {
    const ctx = makeCtx()
    const prompt = buildRetrospectivePrompt(ctx)

    expect(prompt).toContain("my-workspace")
    expect(prompt).toContain("test-org")
    expect(prompt).toContain("31") // lifespan_days
    expect(prompt).toContain("Test workspace for unit testing")
  })

  it("contains execution overview stats", () => {
    const ctx = makeCtx()
    const prompt = buildRetrospectivePrompt(ctx)

    expect(prompt).toContain("3") // total executions
    expect(prompt).toContain("0.25") // total cost
  })

  it("contains per-workflow breakdown details", () => {
    const ctx = makeCtx()
    const prompt = buildRetrospectivePrompt(ctx)

    expect(prompt).toContain("deploy-flow")
    expect(prompt).toContain("review-flow")
    expect(prompt).toContain("agent")
    expect(prompt).toContain("bash")
    expect(prompt).toContain("50%") // success rate of deploy-flow
  })

  it("contains error catalog with failure details", () => {
    const ctx = makeCtx()
    const prompt = buildRetrospectivePrompt(ctx)

    expect(prompt).toContain("step-build")
    expect(prompt).toContain("build failed with exit code 1")
    expect(prompt).toContain("deploy-flow")
  })

  it("contains cost distribution by model", () => {
    const ctx = makeCtx()
    const prompt = buildRetrospectivePrompt(ctx)

    expect(prompt).toContain("claude-sonnet-4-20250514")
    expect(prompt).toContain("claude-haiku-4-20250414")
    expect(prompt).toContain("50000") // tokens
  })

  it("contains cost trend information", () => {
    const ctx = makeCtx()
    const prompt = buildRetrospectivePrompt(ctx)

    expect(prompt).toContain("stable")
    expect(prompt).toContain("0.008") // daily_avg
  })

  it("contains expected JSON output format instructions", () => {
    const prompt = buildRetrospectivePrompt(makeCtx())

    expect(prompt).toContain("summary")
    expect(prompt).toContain("execution_patterns")
    expect(prompt).toContain("cost_efficiency")
    expect(prompt).toContain("error_patterns")
    expect(prompt).toContain("workflow_health")
    expect(prompt).toContain("recommendations")
    expect(prompt).toContain("JSON")
  })

  it("handles empty executions and workflows gracefully", () => {
    const ctx = makeEmptyCtx()
    const prompt = buildRetrospectivePrompt(ctx)

    // Should still contain workspace metadata
    expect(prompt).toContain("my-workspace")
    // Should contain output format instructions even with no data
    expect(prompt).toContain("JSON")
    expect(prompt).toContain("summary")
    // Should mention 0 executions
    expect(prompt).toContain("0")
  })
})

// ── buildExperiencePrompt ───────────────────────────────────────────────────

describe("buildExperiencePrompt", () => {
  it("contains workspace name and metadata", () => {
    const ctx = makeCtx()
    const prompt = buildExperiencePrompt(ctx)

    expect(prompt).toContain("my-workspace")
    expect(prompt).toContain("test-org")
    expect(prompt).toContain("31") // lifespan_days
  })

  it("contains execution history with failed nodes and error snippets", () => {
    const ctx = makeCtx()
    const prompt = buildExperiencePrompt(ctx)

    expect(prompt).toContain("deploy-flow")
    expect(prompt).toContain("step-build")
    expect(prompt).toContain("build failed with exit code 1")
    expect(prompt).toContain("review-flow")
  })

  it("contains existing knowledge rules for conflict avoidance", () => {
    const ctx = makeCtx()
    const prompt = buildExperiencePrompt(ctx)

    expect(prompt).toContain("Always run tests before deploying")
    expect(prompt).toContain("Use staging environment for review workflows")
    expect(prompt).toContain("rule-1")
    expect(prompt).toContain("rule-2")
  })

  it("contains error frequency analysis", () => {
    const ctx = makeCtx()
    const prompt = buildExperiencePrompt(ctx)

    expect(prompt).toContain("step-build")
    expect(prompt).toContain("3") // frequency
  })

  it("contains expected JSON output format instructions", () => {
    const prompt = buildExperiencePrompt(makeCtx())

    expect(prompt).toContain("text")
    expect(prompt).toContain("scope")
    expect(prompt).toContain("target")
    expect(prompt).toContain("confidence")
    expect(prompt).toContain("evidence")
    expect(prompt).toContain("category")
    expect(prompt).toContain("conflicts")
    expect(prompt).toContain("JSON")
    expect(prompt).toContain("15") // max experiences
  })

  it("instructs to prioritize cross-execution patterns", () => {
    const prompt = buildExperiencePrompt(makeCtx())
    expect(prompt).toMatch(/cross.execution/i)
  })

  it("handles empty executions and workflows gracefully", () => {
    const ctx = makeEmptyCtx()
    const prompt = buildExperiencePrompt(ctx)

    expect(prompt).toContain("my-workspace")
    expect(prompt).toContain("JSON")
    expect(prompt).toContain("0")
  })
})

// ── buildSkillDiscoveryPrompt ───────────────────────────────────────────────

describe("buildSkillDiscoveryPrompt", () => {
  it("contains workspace name and metadata", () => {
    const ctx = makeCtx()
    const prompt = buildSkillDiscoveryPrompt(ctx)

    expect(prompt).toContain("my-workspace")
    expect(prompt).toContain("test-org")
    expect(prompt).toContain("31") // lifespan_days
  })

  it("contains workflow node types and patterns", () => {
    const ctx = makeCtx()
    const prompt = buildSkillDiscoveryPrompt(ctx)

    expect(prompt).toContain("deploy-flow")
    expect(prompt).toContain("review-flow")
    expect(prompt).toContain("agent")
    expect(prompt).toContain("bash")
  })

  it("contains most-used node patterns (top 15)", () => {
    const ctx = makeCtx()
    const prompt = buildSkillDiscoveryPrompt(ctx)

    expect(prompt).toContain("step-build")
    expect(prompt).toContain("step-test")
    expect(prompt).toContain("5") // frequency of step-build
  })

  it("contains repeated manual interventions from failed nodes", () => {
    const ctx = makeCtx()
    const prompt = buildSkillDiscoveryPrompt(ctx)

    expect(prompt).toContain("step-build")
    expect(prompt).toContain("build failed with exit code 1")
  })

  it("contains expected JSON output format instructions", () => {
    const prompt = buildSkillDiscoveryPrompt(makeCtx())

    expect(prompt).toContain("name")
    expect(prompt).toContain("description")
    expect(prompt).toContain("content_outline")
    expect(prompt).toContain("reason")
    expect(prompt).toContain("evidence_workflows")
    expect(prompt).toContain("evidence_executions")
    expect(prompt).toContain("estimated_reuse")
    expect(prompt).toContain("JSON")
    expect(prompt).toContain("kebab-case")
    expect(prompt).toContain("5") // max 0-5 candidates
  })

  it("handles empty executions and workflows gracefully", () => {
    const ctx = makeEmptyCtx()
    const prompt = buildSkillDiscoveryPrompt(ctx)

    expect(prompt).toContain("my-workspace")
    expect(prompt).toContain("JSON")
    expect(prompt).toContain("kebab-case")
  })
})
