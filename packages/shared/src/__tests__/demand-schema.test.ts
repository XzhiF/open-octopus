import { describe, it, expect } from "vitest"
import {
  demandStatusSchema,
  demandPrioritySchema,
  demandSchema,
  createDemandInputSchema,
  updateDemandInputSchema,
} from "../types/demand"
import type {
  Demand,
  DemandStatus,
  DemandPriority,
  CreateDemandInput,
  UpdateDemandInput,
} from "../types/demand"

// ─── AC1: demandStatusSchema ────────────────────────────────────

describe("demandStatusSchema (AC1)", () => {
  const validStatuses: DemandStatus[] = [
    "draft",
    "discussing",
    "incubated",
    "ready",
    "dispatched",
    "executing",
    "done",
    "failed",
  ]

  it.each(validStatuses)("accepts valid status: %s", (status) => {
    const result = demandStatusSchema.safeParse(status)
    expect(result.success).toBe(true)
  })

  it("rejects invalid status", () => {
    const result = demandStatusSchema.safeParse("invalid")
    expect(result.success).toBe(false)
  })

  it("rejects empty string", () => {
    const result = demandStatusSchema.safeParse("")
    expect(result.success).toBe(false)
  })

  it("covers exactly 7+1 statuses (7 lifecycle + failed)", () => {
    // 7 lifecycle states: draft, discussing, incubated, ready, dispatched, executing, done
    // plus terminal: failed
    expect(validStatuses).toHaveLength(8)
  })
})

// ─── AC2: demandPrioritySchema ──────────────────────────────────

describe("demandPrioritySchema (AC2)", () => {
  const validPriorities: DemandPriority[] = ["critical", "high", "normal", "low"]

  it.each(validPriorities)("accepts valid priority: %s", (priority) => {
    const result = demandPrioritySchema.safeParse(priority)
    expect(result.success).toBe(true)
  })

  it("rejects invalid priority", () => {
    const result = demandPrioritySchema.safeParse("urgent")
    expect(result.success).toBe(false)
  })

  it("covers exactly 4 priorities", () => {
    expect(validPriorities).toHaveLength(4)
  })
})

// ─── AC3: demandSchema ──────────────────────────────────────────

describe("demandSchema (AC3)", () => {
  const validDemand = {
    id: "demand-001",
    title: "Implement user authentication",
    description: "Support JWT + OAuth2",
    status: "draft" as const,
    priority: "high" as const,
    project_ids: ["open-octopus"],
    demand_workflow_ref: "spec-forge",
    exec_workflow_chain: [
      { workflow_ref: "spec-impl", input_values: {} },
    ],
    workspace_id: "ws-001",
    ready_at: null,
    dispatched_at: null,
    completed_at: null,
    result: null,
    error_message: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
  }

  it("validates a complete demand", () => {
    const result = demandSchema.safeParse(validDemand)
    expect(result.success).toBe(true)
  })

  it("validates demand with minimal required fields", () => {
    const result = demandSchema.safeParse({
      id: "demand-001",
      title: "Minimal demand",
      status: "draft",
      priority: "normal",
      project_ids: ["proj-a"],
      demand_workflow_ref: "spec-forge",
      exec_workflow_chain: [],
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    })
    expect(result.success).toBe(true)
  })

  it("defaults priority to normal", () => {
    const result = demandSchema.safeParse({
      id: "demand-001",
      title: "Test",
      status: "draft",
      project_ids: ["proj-a"],
      demand_workflow_ref: "spec-forge",
      exec_workflow_chain: [],
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.priority).toBe("normal")
    }
  })

  it("defaults status to draft", () => {
    const result = demandSchema.safeParse({
      id: "demand-001",
      title: "Test",
      project_ids: ["proj-a"],
      demand_workflow_ref: "spec-forge",
      exec_workflow_chain: [],
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.status).toBe("draft")
    }
  })

  it("rejects demand without id", () => {
    const { id, ...noId } = validDemand
    const result = demandSchema.safeParse(noId)
    expect(result.success).toBe(false)
  })

  it("rejects invalid status", () => {
    const result = demandSchema.safeParse({ ...validDemand, status: "invalid" })
    expect(result.success).toBe(false)
  })

  it("rejects invalid priority", () => {
    const result = demandSchema.safeParse({ ...validDemand, priority: "urgent" })
    expect(result.success).toBe(false)
  })

  it("accepts demand with all terminal timestamps set", () => {
    const result = demandSchema.safeParse({
      ...validDemand,
      status: "done",
      ready_at: "2025-01-01T01:00:00Z",
      dispatched_at: "2025-01-01T02:00:00Z",
      completed_at: "2025-01-01T03:00:00Z",
      result: "success",
    })
    expect(result.success).toBe(true)
  })

  it("accepts demand with error_message on failed status", () => {
    const result = demandSchema.safeParse({
      ...validDemand,
      status: "failed",
      error_message: "Workflow execution failed",
    })
    expect(result.success).toBe(true)
  })

  // Type inference test (compile-time check)
  it("exports correct TypeScript types", () => {
    const result = demandSchema.safeParse(validDemand)
    expect(result.success).toBe(true)
    if (result.success) {
      // If this compiles, the Demand type is correct
      const demand: Demand = result.data
      expect(demand.id).toBe("demand-001")
    }
  })
})

// ─── AC4: createDemandInputSchema ───────────────────────────────

describe("createDemandInputSchema (AC4)", () => {
  const validInput: CreateDemandInput = {
    title: "Implement user authentication",
    description: "Support JWT + OAuth2",
    project_ids: ["open-octopus"],
    demand_workflow_ref: "spec-forge",
    exec_workflow_chain: [
      { workflow_ref: "spec-impl", input_values: {} },
    ],
    priority: "high",
  }

  it("validates a complete create input", () => {
    const result = createDemandInputSchema.safeParse(validInput)
    expect(result.success).toBe(true)
  })

  it("validates minimal create input (no optional fields)", () => {
    const result = createDemandInputSchema.safeParse({
      title: "Minimal demand",
      project_ids: ["proj-a"],
      demand_workflow_ref: "spec-forge",
      exec_workflow_chain: [],
    })
    expect(result.success).toBe(true)
  })

  it("defaults priority to normal when omitted", () => {
    const result = createDemandInputSchema.safeParse({
      title: "Test",
      project_ids: ["proj-a"],
      demand_workflow_ref: "spec-forge",
      exec_workflow_chain: [],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.priority).toBe("normal")
    }
  })

  it("rejects missing title", () => {
    const { title, ...noTitle } = validInput
    const result = createDemandInputSchema.safeParse(noTitle)
    expect(result.success).toBe(false)
  })

  // AC7: title length 1-200
  it("rejects empty title", () => {
    const result = createDemandInputSchema.safeParse({
      ...validInput,
      title: "",
    })
    expect(result.success).toBe(false)
  })

  it("rejects title exceeding 200 characters", () => {
    const result = createDemandInputSchema.safeParse({
      ...validInput,
      title: "a".repeat(201),
    })
    expect(result.success).toBe(false)
  })

  it("accepts title at exactly 200 characters", () => {
    const result = createDemandInputSchema.safeParse({
      ...validInput,
      title: "a".repeat(200),
    })
    expect(result.success).toBe(true)
  })

  it("accepts title at exactly 1 character", () => {
    const result = createDemandInputSchema.safeParse({
      ...validInput,
      title: "a",
    })
    expect(result.success).toBe(true)
  })

  // AC7: project_ids non-empty array
  it("rejects empty project_ids array", () => {
    const result = createDemandInputSchema.safeParse({
      ...validInput,
      project_ids: [],
    })
    expect(result.success).toBe(false)
  })

  it("rejects missing project_ids", () => {
    const { project_ids, ...noProjects } = validInput
    const result = createDemandInputSchema.safeParse(noProjects)
    expect(result.success).toBe(false)
  })

  it("accepts multiple project_ids", () => {
    const result = createDemandInputSchema.safeParse({
      ...validInput,
      project_ids: ["proj-a", "proj-b", "proj-c"],
    })
    expect(result.success).toBe(true)
  })

  it("does not accept server-side fields (id, workspace_id, timestamps)", () => {
    // Even if passed, these should not appear in the parsed output
    const result = createDemandInputSchema.safeParse({
      ...validInput,
      id: "should-be-stripped",
      workspace_id: "should-be-stripped",
      created_at: "should-be-stripped",
      updated_at: "should-be-stripped",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).not.toHaveProperty("id")
      expect(result.data).not.toHaveProperty("workspace_id")
      expect(result.data).not.toHaveProperty("created_at")
      expect(result.data).not.toHaveProperty("updated_at")
    }
  })

  // Type inference test
  it("exports CreateDemandInput type", () => {
    const result = createDemandInputSchema.safeParse(validInput)
    expect(result.success).toBe(true)
    if (result.success) {
      const input: CreateDemandInput = result.data
      expect(input.title).toBe(validInput.title)
    }
  })
})

// ─── AC5: updateDemandInputSchema ───────────────────────────────

describe("updateDemandInputSchema (AC5)", () => {
  it("allows partial updates", () => {
    const result = updateDemandInputSchema.safeParse({ title: "Updated title" })
    expect(result.success).toBe(true)
  })

  it("allows empty object (all optional)", () => {
    const result = updateDemandInputSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it("allows updating priority only", () => {
    const result = updateDemandInputSchema.safeParse({ priority: "critical" })
    expect(result.success).toBe(true)
  })

  it("allows updating description only", () => {
    const result = updateDemandInputSchema.safeParse({
      description: "New description",
    })
    expect(result.success).toBe(true)
  })

  it("allows updating multiple fields", () => {
    const result = updateDemandInputSchema.safeParse({
      title: "Updated",
      description: "Updated desc",
      priority: "low",
    })
    expect(result.success).toBe(true)
  })

  it("rejects empty title when provided", () => {
    const result = updateDemandInputSchema.safeParse({ title: "" })
    expect(result.success).toBe(false)
  })

  it("rejects title exceeding 200 characters", () => {
    const result = updateDemandInputSchema.safeParse({
      title: "a".repeat(201),
    })
    expect(result.success).toBe(false)
  })

  it("rejects invalid priority when provided", () => {
    const result = updateDemandInputSchema.safeParse({ priority: "urgent" })
    expect(result.success).toBe(false)
  })

  // Type inference test
  it("exports UpdateDemandInput type", () => {
    const result = updateDemandInputSchema.safeParse({ title: "test" })
    expect(result.success).toBe(true)
    if (result.success) {
      const input: UpdateDemandInput = result.data
      expect(input.title).toBe("test")
    }
  })
})

// ─── AC7: Cross-cutting validation ─────────────────────────────

describe("Schema validation rules (AC7)", () => {
  it("title boundary: 1 char is valid", () => {
    const result = createDemandInputSchema.safeParse({
      title: "x",
      project_ids: ["proj"],
      demand_workflow_ref: "wf",
      exec_workflow_chain: [],
    })
    expect(result.success).toBe(true)
  })

  it("title boundary: 200 chars is valid", () => {
    const result = createDemandInputSchema.safeParse({
      title: "x".repeat(200),
      project_ids: ["proj"],
      demand_workflow_ref: "wf",
      exec_workflow_chain: [],
    })
    expect(result.success).toBe(true)
  })

  it("title boundary: 201 chars is rejected", () => {
    const result = createDemandInputSchema.safeParse({
      title: "x".repeat(201),
      project_ids: ["proj"],
      demand_workflow_ref: "wf",
      exec_workflow_chain: [],
    })
    expect(result.success).toBe(false)
  })

  it("project_ids: single element is valid", () => {
    const result = createDemandInputSchema.safeParse({
      title: "Test",
      project_ids: ["single-proj"],
      demand_workflow_ref: "wf",
      exec_workflow_chain: [],
    })
    expect(result.success).toBe(true)
  })

  it("project_ids: empty array is rejected", () => {
    const result = createDemandInputSchema.safeParse({
      title: "Test",
      project_ids: [],
      demand_workflow_ref: "wf",
      exec_workflow_chain: [],
    })
    expect(result.success).toBe(false)
  })
})
