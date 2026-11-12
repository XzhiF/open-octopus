import { z } from "zod"

// ── Cabin (directory-bound long-lived cockpit) ──
// Shared DTOs. Persisted shape lives in server db/types.ts; derived views
// (attention/health/iteration progress) are computed by deriveCabinView (K3: never stored).

export const CabinStatusSchema = z.enum(["draft", "initializing", "active", "dormant", "archived"])
export type CabinStatus = z.infer<typeof CabinStatusSchema>

export const CabinJobKindSchema = z.enum(["task", "workflow", "subagent"])
export type CabinJobKind = z.infer<typeof CabinJobKindSchema>

export const CabinJobEventKindSchema = z.enum(["dispatch", "report", "attention", "handback", "note", "human_input", "resume"])
export type CabinJobEventKind = z.infer<typeof CabinJobEventKindSchema>

export const CabinAutonomySchema = z.enum(["off", "observe", "auto"])
export type CabinAutonomy = z.infer<typeof CabinAutonomySchema>

/** Immutable authorization recorded per dispatch (C5). */
export const CabinMandateSchema = z.object({
  strength: z.enum(["explicit", "inferred"]),
  scope: z.string().optional(),
  basis: z.string().optional(),
  policyVersion: z.number().optional(),
})
export type CabinMandate = z.infer<typeof CabinMandateSchema>

export const CabinSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  workspace_id: z.string().nullable(),
  main_session_id: z.string().nullable(),
  requirements: z.string(),
  status: CabinStatusSchema,
  mainline_strategy: z.string(),
  org: z.string().nullable(),
  focused_job_id: z.string().nullable(),
  version: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  last_active_at: z.string().nullable(),
  archived_at: z.string().nullable(),
})
export type CabinDTO = z.infer<typeof CabinSchema>

export const CabinIterationSchema = z.object({
  id: z.string(),
  cabin_id: z.string(),
  code: z.string(),
  name: z.string(),
  sort_order: z.number(),
  status: z.enum(["pending", "active", "done"]),
  /** Derived from member tasks (tasks.iteration_id), not stored. */
  progress: z.number().optional(),
  task_count: z.number().optional(),
})
export type CabinIteration = z.infer<typeof CabinIterationSchema>

export const CabinJobSchema = z.object({
  id: z.string(),
  cabin_id: z.string(),
  kind: CabinJobKindSchema,
  ref_id: z.string().nullable(),
  session_id: z.string().nullable(),
  iteration_id: z.string().nullable(),
  title: z.string(),
  mandate: CabinMandateSchema.nullable(),
  prompt: z.string().nullable(),
  priority: z.number(),
  created_at: z.string(),
  ended_at: z.string().nullable(),
  /** Derived from the underlying entity (task/execution/subagent), not stored. */
  status: z.string().optional(),
})
export type CabinJob = z.infer<typeof CabinJobSchema>

export const CabinJobEventSchema = z.object({
  id: z.string(),
  job_id: z.string(),
  cabin_id: z.string(),
  kind: CabinJobEventKindSchema,
  actor: z.string().nullable(),
  payload: z.record(z.unknown()).nullable(),
  created_at: z.string(),
})
export type CabinJobEvent = z.infer<typeof CabinJobEventSchema>

/** One serial-inbox item (C4). awaiting = "whom it waits for" (superagent stage). */
export const CabinAttentionItemSchema = z.object({
  id: z.string(),
  job_id: z.string().nullable(),
  stage: z.enum(["review", "answer", "adjudicate", "approval", "blocked"]),
  awaiting: z.enum(["person", "working", "idle", "ended"]),
  title: z.string(),
  question: z.string().optional(),
  detail: z.string().optional(),
  task_id: z.string().nullable(),
  repo: z.string().nullable(),
  wt: z.string().nullable(),
  deep_link: z.string().nullable(),
  priority: z.number(),
})
export type CabinAttentionItem = z.infer<typeof CabinAttentionItemSchema>

export const CabinHealthSchema = z.object({
  running: z.number(),
  queued: z.number(),
  dormant: z.number(),
  workers: z.number(),
  max: z.number(),
})
export type CabinHealth = z.infer<typeof CabinHealthSchema>

/** Derived cockpit view (K3: computed, never persisted). */
export const CabinViewSchema = z.object({
  cabin: CabinSchema,
  attention: z.array(CabinAttentionItemSchema),
  health: CabinHealthSchema,
  iterations: z.array(CabinIterationSchema),
  open_findings: z.number(),
})
export type CabinView = z.infer<typeof CabinViewSchema>

/** Init gate cold-load snapshot (truth on disk .cabin/init-state.json). */
export const CabinInitItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  sub: z.string().optional(),
  state: z.enum(["pending", "running", "done", "failed"]),
  error: z.string().optional(),
  fix_hint: z.string().optional(),
  deep_link: z.string().optional(),
})
export type CabinInitItem = z.infer<typeof CabinInitItemSchema>
export const CabinInitStateSchema = z.object({
  items: z.array(CabinInitItemSchema),
})
export type CabinInitState = z.infer<typeof CabinInitStateSchema>