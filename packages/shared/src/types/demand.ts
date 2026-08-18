import { z } from "zod"

// ─── AC1: Status enum (7 lifecycle + failed terminal) ───────────

export const demandStatusSchema = z.enum([
  "draft",
  "discussing",
  "incubated",
  "ready",
  "dispatched",
  "executing",
  "done",
  "failed",
])
export type DemandStatus = z.infer<typeof demandStatusSchema>

// ─── AC2: Priority enum (4 levels) ─────────────────────────────

export const demandPrioritySchema = z.enum([
  "critical",
  "high",
  "normal",
  "low",
])
export type DemandPriority = z.infer<typeof demandPrioritySchema>

// ─── Shared: exec_workflow_chain item ───────────────────────────

const execWorkflowItemSchema = z.object({
  workflow_ref: z.string().min(1),
  input_values: z.record(z.unknown()).default({}),
})

// ─── AC3: Full Demand schema ────────────────────────────────────

export const demandSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  status: demandStatusSchema.default("draft"),
  priority: demandPrioritySchema.default("normal"),
  project_ids: z.array(z.string().min(1)).min(1),
  demand_workflow_ref: z.string().min(1),
  exec_workflow_chain: z.array(execWorkflowItemSchema).default([]),
  workspace_id: z.string().optional(),
  ready_at: z.string().nullable().optional(),
  dispatched_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  result: z.string().nullable().optional(),
  error_message: z.string().nullable().optional(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
})
export type Demand = z.infer<typeof demandSchema>

// ─── AC4: Create input (no server-side fields) ──────────────────

export const createDemandInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  project_ids: z.array(z.string().min(1)).min(1),
  demand_workflow_ref: z.string().min(1),
  exec_workflow_chain: z.array(execWorkflowItemSchema).default([]),
  priority: demandPrioritySchema.default("normal"),
})
export type CreateDemandInput = z.infer<typeof createDemandInputSchema>

// ─── AC5: Update input (all fields optional) ────────────────────

export const updateDemandInputSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  priority: demandPrioritySchema.optional(),
})
export type UpdateDemandInput = z.infer<typeof updateDemandInputSchema>
