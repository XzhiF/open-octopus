// packages/shared/src/simulator/schemas.ts
//
// Zod schemas for workflow test fixtures.
// Validates *.test.yaml files before simulation.

import { z } from "zod"

// ── Mock Definition Schemas ───────────────────────────────────

const BaseMockDefSchema = z.object({
  status: z.enum(["completed", "failed"]).optional(),
  output: z.string().optional(),
  outputs: z.record(z.string(), z.any()).optional(),
  update_vars: z.record(z.string(), z.any()).optional(),
  error: z.string().optional(),
})

export const AgentMockDefSchema = BaseMockDefSchema

export const SwarmMockDefSchema = BaseMockDefSchema

export const BashMockDefSchema = BaseMockDefSchema.extend({
  exit_code: z.number().int().optional(),
})

export const PythonMockDefSchema = BaseMockDefSchema.extend({
  exit_code: z.number().int().optional(),
})

export const ApprovalMockDefSchema = z.object({
  choice: z.string(),
  comment: z.string().optional(),
})

export const InteractionMockDefSchema = z.object({
  summary: z.string(),
  rounds: z.number().int().positive().optional(),
  vars_update: z.record(z.string(), z.any()).optional(),
  outputs: z.record(z.string(), z.any()).optional(),
})

// Forward reference for recursive loop mock
// IMPORTANT: LoopMockDefSchema (required `nodes`) and ApprovalMockDefSchema (required `choice`)
// must come BEFORE the permissive BaseMockDef variants, otherwise AgentMockDefSchema (all-optional)
// matches first and Zod's strip mode silently drops `nodes`/`iterations`/`choice` fields.
export const MockDefSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    LoopMockDefSchema,
    ApprovalMockDefSchema,
    InteractionMockDefSchema,
    BashMockDefSchema,
    PythonMockDefSchema,
    AgentMockDefSchema,
    SwarmMockDefSchema,
  ])
)

export const LoopMockDefSchema = z.object({
  iterations: z.number().int().positive().optional(),
  nodes: z.record(z.string(), z.union([MockDefSchema, z.array(MockDefSchema)])),
})

// ── Assertion Schemas ─────────────────────────────────────────

export const NodeTraceAssertionSchema = z.object({
  executed: z.array(z.string()).optional(),
  skipped: z.array(z.string()).optional(),
  order: z.array(z.string()).optional(),
})

export const NodeOutputAssertionSchema = z.object({
  output: z.string().optional(),
  outputs: z.record(z.string(), z.any()).optional(),
  status: z.string().optional(),
})

export const LogAssertionSchema = z.object({
  contains: z.array(z.string()).optional(),
  not_contains: z.array(z.string()).optional(),
})

export const AssertionDefSchema = z.object({
  status: z.enum(["completed", "failed", "completed_with_failures", "paused", "cancelled"]).optional(),
  vars: z.record(z.string(), z.any()).optional(),
  node_trace: NodeTraceAssertionSchema.optional(),
  node_outputs: z.record(z.string(), NodeOutputAssertionSchema).optional(),
  logs: z.record(z.string(), LogAssertionSchema).optional(),
})

// ── Test Scenario & Fixture ────────────────────────────────────

export const TestScenarioSchema = z.object({
  name: z.string(),
  inputs: z.record(z.string(), z.string()).optional(),
  mocks: z.record(z.string(), MockDefSchema),
  real_execution: z.array(z.string()).optional(),
  assertions: AssertionDefSchema,
})

export const TestFixtureSchema = z.object({
  scenarios: z.array(TestScenarioSchema).min(1, "At least one scenario is required"),
})

// ── Inferred types ────────────────────────────────────────────

export type TestFixtureInput = z.infer<typeof TestFixtureSchema>
export type TestScenarioInput = z.infer<typeof TestScenarioSchema>
export type AssertionDefInput = z.infer<typeof AssertionDefSchema>
