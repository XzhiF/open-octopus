import { randomUUID } from "crypto"
import type { DemandDAO } from "../../db/dao/demand-dao"
import type { DemandRow } from "../../db/types"
import {
  demandSchema,
  createDemandInputSchema,
  type CreateDemandInput,
  type Demand,
  type DemandStatus,
} from "@octopus/shared"

/**
 * Valid state transitions for the demand lifecycle.
 * See spec: 8-state lifecycle with failed → ready retry path.
 */
const VALID_TRANSITIONS: Record<DemandStatus, DemandStatus[]> = {
  draft: ["discussing"],
  discussing: ["incubated"],
  incubated: ["ready"],
  ready: ["dispatched"],
  dispatched: ["executing"],
  executing: ["done", "failed"],
  done: [],
  failed: ["ready"],
}

/**
 * Thrown when a demand status transition is not allowed by the state machine.
 */
export class InvalidTransitionError extends Error {
  constructor(
    public readonly demandId: string,
    public readonly currentStatus: string,
    public readonly targetStatus: string,
  ) {
    super(
      `Invalid transition for demand "${demandId}": cannot move from "${currentStatus}" to "${targetStatus}"`,
    )
    this.name = "InvalidTransitionError"
  }
}

/**
 * Thrown when a demand is not found by ID.
 */
export class DemandNotFoundError extends Error {
  constructor(public readonly demandId: string) {
    super(`Demand not found: "${demandId}"`)
    this.name = "DemandNotFoundError"
  }
}

/**
 * Convert a DemandRow (DB representation) to a Demand (Zod-validated domain object).
 * Handles JSON string → array conversions for project_ids and exec_workflow_chain.
 */
function rowToDemand(row: DemandRow): Demand {
  return demandSchema.parse({
    id: row.id,
    title: row.title,
    description: row.description || undefined,
    status: row.status,
    priority: row.priority,
    project_ids: safeJsonParse(row.project_ids, []),
    demand_workflow_ref: row.demand_workflow_ref,
    exec_workflow_chain: safeJsonParse(row.exec_workflow_chain, []),
    workspace_id: row.workspace_id ?? undefined,
    ready_at: row.ready_at ?? null,
    dispatched_at: row.dispatched_at ?? null,
    completed_at: row.completed_at ?? null,
    result: row.result ?? null,
    error_message: row.error_message ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  })
}

function safeJsonParse(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/**
 * DemandFilter options for list().
 */
export interface DemandFilter {
  status?: string
  priority?: string
  createdAtFrom?: string
  createdAtTo?: string
}

/**
 * Paginated result wrapper.
 */
export interface PaginatedResult<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
}

/**
 * DemandService — business logic layer on top of DemandDAO.
 * Enforces the state machine, validates inputs via Zod, and converts
 * between row types and domain types.
 */
export class DemandService {
  constructor(private readonly dao: DemandDAO) {}

  /**
   * Create a new demand. Validates input via Zod, generates a UUID,
   * inserts via DAO, and returns the created Demand.
   */
  create(input: CreateDemandInput): Demand {
    // Zod validate input
    const validated = createDemandInputSchema.parse(input)

    const now = new Date().toISOString()
    const id = randomUUID()

    const row: DemandRow = {
      id,
      title: validated.title,
      description: validated.description ?? "",
      status: "draft",
      priority: validated.priority ?? "normal",
      project_ids: JSON.stringify(validated.project_ids),
      demand_workflow_ref: validated.demand_workflow_ref,
      exec_workflow_chain: JSON.stringify(validated.exec_workflow_chain ?? []),
      workspace_id: null,
      ready_at: null,
      dispatched_at: null,
      completed_at: null,
      result: null,
      error_message: null,
      created_at: now,
      updated_at: now,
    }

    this.dao.insert(row)

    // Read back from DB to ensure round-trip consistency
    const inserted = this.dao.findById(id)
    if (!inserted) {
      throw new Error(`Failed to read back demand after insert: ${id}`)
    }

    return rowToDemand(inserted)
  }

  /**
   * Get a demand by ID. Returns null if not found.
   */
  getById(id: string): Demand | null {
    const row = this.dao.findById(id)
    if (!row) return null
    return rowToDemand(row)
  }

  /**
   * List demands with optional filtering and pagination.
   */
  list(
    filter?: DemandFilter,
    page?: number,
    pageSize?: number,
  ): PaginatedResult<Demand> {
    const result = this.dao.list({
      status: filter?.status,
      priority: filter?.priority,
      createdAtFrom: filter?.createdAtFrom,
      createdAtTo: filter?.createdAtTo,
      page: page ?? 1,
      pageSize: pageSize ?? 20,
    })

    return {
      data: result.data.map(rowToDemand),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    }
  }

  /**
   * Update the status of a demand, enforcing the state machine.
   * Throws InvalidTransitionError if the transition is not allowed.
   * Throws DemandNotFoundError if the demand does not exist.
   */
  updateStatus(id: string, newStatus: DemandStatus): Demand {
    const row = this.dao.findById(id)
    if (!row) {
      throw new DemandNotFoundError(id)
    }

    const currentStatus = row.status as DemandStatus
    const allowed = VALID_TRANSITIONS[currentStatus] ?? []

    if (!allowed.includes(newStatus)) {
      throw new InvalidTransitionError(id, currentStatus, newStatus)
    }

    this.dao.updateStatus(id, newStatus)

    // Read back to return the updated Demand
    const updated = this.dao.findById(id)
    if (!updated) {
      throw new Error(`Failed to read back demand after status update: ${id}`)
    }

    return rowToDemand(updated)
  }

  /**
   * Mark a demand as ready. Must be in 'incubated' status.
   * Convenience wrapper around updateStatus(id, 'ready').
   */
  markReady(id: string): Demand {
    return this.updateStatus(id, "ready")
  }

  /**
   * Retry a failed demand. Must be in 'failed' status.
   * Sets status to 'ready' and clears the error_message.
   */
  retry(id: string): Demand {
    const result = this.updateStatus(id, "ready")
    this.dao.setError(id, null)

    // Read back to return the updated Demand with cleared error
    const updated = this.dao.findById(id)
    if (!updated) {
      throw new Error(`Failed to read back demand after retry: ${id}`)
    }

    return rowToDemand(updated)
  }

  /**
   * Set or clear the error message on a demand.
   */
  setError(id: string, message: string | null): void {
    this.dao.setError(id, message)
  }
}
