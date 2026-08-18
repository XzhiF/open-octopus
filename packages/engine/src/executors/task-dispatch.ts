// packages/engine/src/executors/task-dispatch.ts
//
// TaskDispatchExecutor — fans out a child schedule for one subunit of a composite
// task and pauses the parent composition workflow until the child completes (G1).
//
// Reuses the interaction/approval pause-resume infrastructure: execute() returns
// `pending_task_dispatch` + metadata on the first call (no in-memory Promise
// blocking the event loop); a NEW executor instance constructed with `childOutput`
// in its config handles the resume (the server re-invokes the engine via the
// trigger-source-agnostic retryFrom path — same mechanism interaction/approval use).
//
// On resume, output_mapping writes child outputs to BOTH the parent VarPool
// (sub_workflow precedent) and the node's result outputs so downstream nodes can
// read `$<taskDispatchId>.output.<key>` for aggregation (moa synthesis).

import { VarPool, applyOutputsMapping, substituteVars } from "@octopus/shared"
import type {
  NodeDef,
  CrossExecResolver,
  TaskDispatchPort,
  ScheduleHandle,
  SubunitSpec,
} from "@octopus/shared"
import type { NodeExecutor, NodeExecutionResult, TaskDispatchMetadata } from "./types"
import type { TaskDispatchConfig } from "./executor-config"

export class TaskDispatchExecutor implements NodeExecutor {
  private config: TaskDispatchConfig

  constructor(
    private node: NodeDef,
    private pool: VarPool,
    config?: TaskDispatchConfig,
  ) {
    this.config = config ?? {}
  }

  async execute(): Promise<NodeExecutionResult> {
    const start = Date.now()

    if (this.config.signal?.aborted) {
      return {
        outputs: {},
        status: "cancelled",
        durationMs: 0,
        logLines: ["task_dispatch cancelled before execution"],
      }
    }

    // Resume path: child schedule completed, output provided → map + complete.
    if (this.config.childOutput !== undefined) {
      return this.processCompletion(this.config.childOutput, start)
    }

    // First call: resolve subunit → dispatch → pause.
    return this.dispatchAndPause(start)
  }

  /** First-call path: resolve the subunit reference, dispatch via the port, then pause. */
  private async dispatchAndPause(start: number): Promise<NodeExecutionResult> {
    const logLines: string[] = []

    if (!this.config.port) {
      return {
        outputs: {},
        status: "failed",
        durationMs: Date.now() - start,
        logLines: ["task_dispatch node has no TaskDispatchPort injected — cannot dispatch child schedule"],
        error: "TaskDispatchPort not available",
      }
    }

    let subunit: SubunitSpec
    try {
      subunit = this.resolveSubunit()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        outputs: {},
        status: "failed",
        durationMs: Date.now() - start,
        logLines: [`task_dispatch subunit resolution failed: ${msg}`],
        error: `Subunit resolution failed: ${msg}`,
      }
    }

    logLines.push(`task_dispatch: dispatching subunit "${subunit.name}" (workflow_ref: ${subunit.workflow_ref})`)

    // Ticket 08 (AC3/D14): resolve input_mapping from the parent pool and merge
    // into the subunit's input_values before dispatching. This forwards parent
    // vars (e.g. $vars.task_artifacts_dir) to the child schedule's input_values
    // so the child workflow's $vars.task_artifacts_dir is set. Mirrors
    // sub-workflow.ts resolveMappingValue (pure $vars.xxx → pool.get, preserving
    // type; $nodeId.output.xxx → nodeOutputs; templates → substituteVars).
    // Gated on this.node.input_mapping presence so existing nodes without it
    // are unaffected (backward compat — the subunit passes through unchanged).
    const subunitToDispatch = this.applyInputMapping(subunit, logLines)

    let handle: ScheduleHandle
    try {
      // Port contract: resolves once the child schedule is CREATED (queued), not on
      // completion — so this await does not block the event loop on the child run.
      handle = await this.config.port.dispatchChildSchedule(subunitToDispatch)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        outputs: {},
        status: "failed",
        durationMs: Date.now() - start,
        logLines: [`task_dispatch: dispatchChildSchedule failed: ${msg}`],
        error: `dispatchChildSchedule failed: ${msg}`,
      }
    }

    logLines.push(`task_dispatch: dispatched child schedule ${handle.schedule_id}`)

    // Fire-and-forget: await=false → don't pause; complete immediately.
    if (this.node.await === false) {
      const outputs: Record<string, any> = {
        schedule_id: handle.schedule_id,
        workspace_id: handle.workspace_id,
        subunit: subunit.name,
        last_output: handle.schedule_id,
      }
      this.applyOutputMapping(
        { schedule_id: handle.schedule_id, workspace_id: handle.workspace_id, subunit_name: subunit.name },
        outputs,
        logLines,
      )
      return {
        outputs,
        status: "completed",
        durationMs: Date.now() - start,
        logLines: [...logLines, "task_dispatch: await=false, completed without pausing"],
      }
    }

    const metadata: TaskDispatchMetadata = {
      nodeId: this.node.id,
      scheduleHandle: { schedule_id: handle.schedule_id, workspace_id: handle.workspace_id },
      subunitName: subunit.name,
    }

    return {
      outputs: { schedule_id: handle.schedule_id, subunit: subunit.name },
      status: "pending_task_dispatch",
      durationMs: Date.now() - start,
      logLines: [...logLines, "task_dispatch: awaiting child schedule completion"],
      taskDispatchMetadata: metadata,
    }
  }

  /** Resume path: child schedule completed — apply output_mapping and complete. */
  private processCompletion(
    childOutput: Record<string, unknown>,
    start: number,
  ): NodeExecutionResult {
    const logLines: string[] = ["task_dispatch: resuming with child completion output"]

    const lastOutput = this.deriveLastOutput(childOutput)
    const outputs: Record<string, any> = {
      ...childOutput,
      last_output: lastOutput,
    }

    // output_mapping: { parentVar: childKey } → pool + node outputs (sub_workflow
    // precedent, extended to also expose as $<nodeId>.output.<parentVar> per spec G1
    // so downstream aggregation nodes can read the child's result).
    this.applyOutputMapping(childOutput, outputs, logLines)

    // node.outputs block (interaction/approval precedent) — $vars.x = expr style.
    if (this.node.outputs) {
      applyOutputsMapping(this.node.outputs, outputs, this.pool, lastOutput, undefined)
    }

    return {
      lastOutput,
      outputs,
      status: "completed",
      durationMs: Date.now() - start,
      logLines,
    }
  }

  /**
   * Apply `node.output_mapping: { parentVar: childKey }`. Reads childOutput[childKey],
   * writes to the parent VarPool (so $vars.parentVar resolves) AND to the node's
   * result outputs (so $<nodeId>.output.parentVar resolves for downstream nodes).
   * Missing child keys are logged, not fatal (partial results may still aggregate).
   */
  private applyOutputMapping(
    childOutput: Record<string, unknown>,
    outputs: Record<string, any>,
    logLines: string[],
  ): void {
    if (!this.node.output_mapping) return
    for (const [parentVar, childKey] of Object.entries(this.node.output_mapping)) {
      const value = childOutput[childKey]
      if (value !== undefined) {
        this.pool.set(parentVar, value)
        outputs[parentVar] = value
        logLines.push(`output_mapping: ${parentVar} = ${JSON.stringify(value)}`)
      } else {
        logLines.push(`output_mapping: ${parentVar} ← ${childKey} (not found in child output)`)
      }
    }
  }

  /**
   * Ticket 08 (AC3): Apply `node.input_mapping` to the subunit before dispatch.
   * Resolves each mapping expression from the parent pool and merges the result
   * into a COPY of the subunit's input_values (non-mutating — the task_spec's
   * subunit data is read-only). Returns the original subunit unchanged when
   * input_mapping is absent (backward compat). Mirrors sub-workflow.ts
   * resolveMappingValue: $vars.xxx → pool.get (type-preserving); $nodeId.output.xxx
   * → nodeOutputs; templates/literals → substituteVars.
   */
  private applyInputMapping(
    subunit: SubunitSpec,
    logLines: string[],
  ): SubunitSpec {
    if (!this.node.input_mapping) return subunit
    const nodeOutputs = this.config.nodeOutputs ?? {}
    const enrichedValues: Record<string, unknown> = {}
    for (const [childVar, expr] of Object.entries(this.node.input_mapping)) {
      try {
        const value = this.resolveMappingValue(expr, nodeOutputs)
        if (value !== undefined) {
          enrichedValues[childVar] = value
          logLines.push(`input_mapping: ${childVar} = ${JSON.stringify(value)}`)
        } else {
          logLines.push(`input_mapping: ${childVar} ← ${expr} (resolved to undefined — skipped)`)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logLines.push(`input_mapping error for ${childVar}: ${msg}`)
      }
    }
    // Non-mutating: shallow-copy the subunit with merged input_values. The
    // enrichedValues may carry non-string types (paths, numbers) — cast through
    // unknown to match SubunitSpec.input_values' Record<string, string> at the
    // type level (runtime carries the real values; same pattern as
    // materializeTaskSpecToConfig's input_values cast).
    return {
      ...subunit,
      input_values: { ...subunit.input_values, ...enrichedValues } as unknown as Record<string, string>,
    }
  }

  /**
   * Resolve a mapping expression to its actual value (not stringified).
   * - Pure `$vars.key` → returns pool.get(key) preserving type
   * - Pure `$nodeId.output.key` → returns node output value
   * - Templates or literals → substituteVars (string result)
   * Mirrors sub-workflow.ts:266-284 resolveMappingValue.
   */
  private resolveMappingValue(
    expr: string,
    nodeOutputs: Record<string, Record<string, any>>,
  ): unknown {
    const varsMatch = expr.match(/^\$vars\.([a-zA-Z0-9_]+)$/)
    if (varsMatch) {
      return this.pool.get(varsMatch[1])
    }
    const outputMatch = expr.match(/^\$([a-zA-Z0-9_-]+)\.output\.([a-zA-Z0-9_]+)$/)
    if (outputMatch) {
      return nodeOutputs[outputMatch[1]]?.[outputMatch[2]]
    }
    return substituteVars(expr, this.pool, nodeOutputs)
  }

  /**
   * Resolve the node's `subunit` reference string to a SubunitSpec object.
   * Mirrors sub-workflow resolveMappingValue (sub-workflow.ts:266-284): raw lookups
   * preserve object type (substituteVars would stringify a SubunitSpec, so it is
   * NOT used here). Supports $vars.x, $iteration.x, $nodeId.output.x, and literal JSON.
   */
  private resolveSubunit(): SubunitSpec {
    const ref = this.node.subunit
    if (!ref) {
      throw new Error("task_dispatch node missing required 'subunit' reference")
    }

    const nodeOutputs = this.config.nodeOutputs ?? {}

    // $vars.xxx → pool.get (object-preserving)
    const varsMatch = ref.match(/^\$vars\.([a-zA-Z0-9_]+)$/)
    if (varsMatch) {
      return this.coerceSubunit(this.pool.get(varsMatch[1]), ref)
    }

    // $iteration.xxx → loopContext (composition loop exposes the current subunit)
    const iterMatch = ref.match(/^\$iteration\.([a-zA-Z0-9_]+)$/)
    if (iterMatch) {
      return this.coerceSubunit(this.config.loopContext?.[iterMatch[1]], ref)
    }

    // $nodeId.output.xxx → node output value
    const outputMatch = ref.match(/^\$([a-zA-Z0-9_-]+)\.output\.([a-zA-Z0-9_]+)$/)
    if (outputMatch) {
      return this.coerceSubunit(nodeOutputs[outputMatch[1]]?.[outputMatch[2]], ref)
    }

    // Fallback: literal JSON SubunitSpec
    try {
      return this.coerceSubunit(JSON.parse(ref), ref)
    } catch {
      throw new Error(
        `subunit ref "${ref}" is not a resolvable $vars/$iteration/$node.output reference or valid JSON`,
      )
    }
  }

  /** Validate that the resolved value is shaped like a SubunitSpec before dispatch. */
  private coerceSubunit(value: unknown, ref: string): SubunitSpec {
    if (value === null || value === undefined) {
      throw new Error(`subunit ref "${ref}" resolved to undefined`)
    }
    if (typeof value !== "object") {
      throw new Error(`subunit ref "${ref}" resolved to non-object (${typeof value})`)
    }
    const obj = value as Record<string, unknown>
    if (typeof obj.name !== "string" || typeof obj.workflow_ref !== "string") {
      throw new Error(
        `subunit ref "${ref}" resolved to an object missing required SubunitSpec fields (name, workflow_ref)`,
      )
    }
    return value as SubunitSpec
  }

  /** Derive a string lastOutput from the child output snapshot for log/result display. */
  private deriveLastOutput(childOutput: Record<string, unknown>): string {
    const candidate =
      childOutput.result ?? childOutput.summary ?? childOutput.output ?? childOutput.last_output
    if (typeof candidate === "string") return candidate
    try {
      return JSON.stringify(candidate ?? childOutput)
    } catch {
      return "[task_dispatch child output]"
    }
  }
}
