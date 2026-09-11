// packages/server/src/services/tasks/task-materialize.ts
//
// ADR-0021 票03: the task→run materializer, moved VERBATIM out of
// `services/scheduler/scheduler-service.ts` and into the task domain.
//
// Why it moves: this function knows what a TaskSpec is — goals, AC, subunits,
// phases, resources, the composition threshold. The scheduler has no business
// knowing any of that; its job is "run the definition you were given". While the
// materializer lived on the scheduler side, `readyTask` had to reach across the
// boundary to build the envelope's config, and that one call is how the two
// domains ended up owning each other's data. The body is unchanged on purpose:
// the shapes it produces are consumed byte-for-byte by workspace scaffolding and
// the composition workflow, so this is a relocation, not a redesign.
//
// What it produces is now a LAUNCH PLAN rather than a schedule row's config: the
// built-in task-lifecycle job materializes per launch (see task-lifecycle-service)
// instead of freezing one copy into `schedules` at enqueue time. Materializing per
// launch is also strictly more correct — a spec edit between two rounds takes
// effect on the next one, which the frozen envelope could not do without a rewrite.

import type { TaskSpec, ResourceRef, WorkflowConfig } from "@octopus/shared"
import fs from "fs"
import path from "path"
import { resolveInputValues, parseWorkflowInputDefs } from "../scheduler/template-resolver"
import { COMPOSITION_WF_REF } from "../scheduler/orchestration-strategy"
import { batchRelPath } from "./task-artifact-sync"

/** phase-handoff-chaining (ticket 01): the internal input_values key carrying the
 *  newline-joined home absolute paths of the accepted predecessor phases' handoff.md
 *  files. Lives here because both producers (the launch-step resolver below) and
 *  consumers (workflow YAML `$vars.prev_handoff_paths`) read the same string. */
export const PREV_HANDOFF_PATHS_KEY = "prev_handoff_paths"

// SG9 (ticket 06): composite requires subunits.length >= 2 (1-subunit → simple
// workflow_chain). The dispatch seam (TasksService.readyTask) uses the same
// threshold; materialize + isCompositeTask (workflow-executor) mirror it so
// simple 1-subunit tasks skip the coordinator-ws (ADR-0009 N+1→1 optimization).
export function isCompositeTaskSpec(task_spec: TaskSpec): boolean {
  return (task_spec.subunits?.length ?? 0) >= 2
}

/** One v4 phase fully resolved at the ready gate (absolute specPath verified
 *  against the task home; inputValues placeholder-resolved — management keys
 *  appended here by buildTaskLaunchConfig). */
export interface TaskV4PhaseConfig {
  index: number
  name: string
  slug: string
  specPath: string
  specDir: string
  workflowRef: string
  inputValues: Record<string, string>
}

/**
 * Materialize a TaskSpec into the WorkflowConfig its run executes.
 *
 *   1. task_spec is NOT included in the output — it lives in the tasks table
 *      (v2-D1); the plan carries only the runtime shape (workspace_spec +
 *      workflow_chain + requires), not the authoring WHAT.
 *   2. The composite path injects input_values.subunit_count on workflow_chain[0]
 *      so the composition-task workflow's Loop break_when reads it without
 *      re-parsing task_spec.subunits at runtime.
 *   3. The simple path (subunits < 2) uses the provided workflow_ref directly and
 *      skips the coordinator-ws (ADR-0009).
 *   4. `resources` (tasks.resources[] + every subunit's resources[]) → config.requires
 *      (skill→skills, agent→agent_files, command→commands, rule→rules; UNION + dedupe),
 *      omitted entirely when empty.
 *   5. taskArtifactsDir / taskWorkflowsDir land in workflow_chain[0].input_values as
 *      $vars.task_artifacts_dir / $vars.task_workflows_dir (ticket 08 D14 + ADR-0013),
 *      written LAST so they win over user-supplied input_values with the same key.
 *      Undefined for legacy tasks without a task home (key omitted, not errored).
 *   6. v4Phases (the ready gate's resolution) adds `format:'v4'` + `phases:[...]` and
 *      PRE-LOADS workflow_chain[0] with phase 1. `phases`/`format` are intentional
 *      unknown keys for workflowConfigSchema (stripped on a strict re-parse, not
 *      rejected) — the persisted JSON carries them.
 */
export function buildTaskLaunchConfig(
  task_spec: TaskSpec,
  project_ids: string[],
  org: string,
  workflow_ref?: string,
  skills?: string[],
  resources?: ResourceRef[],
  taskArtifactsDir?: string,
  taskWorkflowsDir?: string,
  v4Phases?: TaskV4PhaseConfig[],
): WorkflowConfig {
  const isComposite = isCompositeTaskSpec(task_spec)
  const projects = project_ids.map((id) => ({ name: id, source_path: '', group: '' }))
  // branch_prefix must match /^[a-zA-Z0-9_-]+$/ (workspaceSpecSchema). Derive a
  // safe, stable prefix from org so multiple drafts in the same org share a prefix.
  const branchPrefix = `taskpool-${org}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 50) || 'taskpool'

  // Ticket 08: build the input_values for workflow_chain[0]. Simple tasks carry
  // task_artifacts_dir directly (execute passes firstStep.input_values to the
  // workflow). Composite tasks carry subunit_count (SG5) + task_artifacts_dir
  // (the latter is read by buildCompositeInputValues at execute time, AC2).
  // task-workflow-presets (T4): resolve ${goal}/${ac} placeholders in
  // task_spec.input_values and merge into simpleInputValues. Management keys
  // (task_artifacts_dir, task_workflows_dir) are written LAST so they take
  // priority over any user-supplied input_values with the same key.
  const { values: resolvedInputs, unresolved } = resolveInputValues(
    task_spec.input_values,
    task_spec.goal,
    task_spec.ac,
  )
  // Best-effort at dispatch: an unresolved placeholder (e.g. `${goaal}`) is a
  // gate-visible defect — the ready-gate pushes it into missing before enqueue.
  // If one slips through here, warn and keep the "" value instead of blocking
  // the whole dispatch (SW-BP13: never let a data quirk kill the run).
  if (unresolved.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[task-materialize] input_values has unresolved placeholders for a task — check before ready: ${unresolved.join(", ")}`,
    )
  }
  const simpleInputValues: Record<string, unknown> = { ...resolvedInputs }
  const compositeInputValues: Record<string, unknown> = {
    subunit_count: task_spec.subunits?.length ?? 0,
  }
  if (taskArtifactsDir) {
    simpleInputValues.task_artifacts_dir = taskArtifactsDir
    compositeInputValues.task_artifacts_dir = taskArtifactsDir
  }
  // task-workflow-handoff (ADR-0013): task_workflows_dir injection (mirrors
  // task_artifacts_dir). The launch path reads it to copy {home}/workflows/
  // YAMLs into the execution ws `workflows/`.
  if (taskWorkflowsDir) {
    simpleInputValues.task_workflows_dir = taskWorkflowsDir
    compositeInputValues.task_workflows_dir = taskWorkflowsDir
  }
  const config: WorkflowConfig = {
    schema_version: '3.0',
    type: 'workflow',
    workspace_spec: {
      org,
      branch_prefix: branchPrefix,
      projects: projects.length
        ? projects
        : [{ name: 'default', source_path: '', group: '' }],
    },
    workflow_chain: isComposite
      ? [{
          // SG5: inject subunit_count so the composition-task Loop break_when can
          // read it without re-parsing task_spec.subunits at runtime. The subunits
          // array itself is NOT injected here (task_spec is dropped); the canonical
          // input source for iteration control is subunit_count.
          workflow_ref: COMPOSITION_WF_REF,
          input_values: compositeInputValues as unknown as Record<string, string>,
        }]
      : [{ workflow_ref: workflow_ref ?? '', input_values: simpleInputValues as unknown as Record<string, string> }],
    max_retain: 10,
  }
  // Re-attach skills post-validation (survives JSON.stringify; Zod would strip on
  // re-parse but we only parse-read, not re-validate, on GET).
  if (skills?.length) {
    ;(config as WorkflowConfig & { skills?: string[] }).skills = skills
  }
  // SG7 (ticket 07): propagate task-level + subunit-level resources → config.requires.
  // UNION + dedupe across all sources (task.resources + each subunit.resources).
  // Omitted entirely when no resources → config.requires stays undefined (backward
  // compat: 06's AC4 doesn't expect requires, and existing definitions have none).
  const requires = buildConfigRequires(task_spec, resources)
  if (requires) {
    config.requires = requires
  }
  // task-phase-redesign (ticket 04): v4 overlay. The gate resolved every phase (spec
  // exists / ref resolvable / required inputs non-empty); here we append the management
  // keys per-phase (same priority rule as the simple path) and mirror phase 1 into
  // workflow_chain[0] so the launch path runs it unchanged.
  if (v4Phases && v4Phases.length > 0) {
    const planPhases = v4Phases.map((p) => ({
      ...p,
      inputValues: {
        ...p.inputValues,
        ...(taskArtifactsDir ? { task_artifacts_dir: taskArtifactsDir } : {}),
        ...(taskWorkflowsDir ? { task_workflows_dir: taskWorkflowsDir } : {}),
      },
    }))
    const ext = config as WorkflowConfig & {
      format?: string
      phases?: typeof planPhases
    }
    ext.format = 'v4'
    ext.phases = planPhases
    config.workflow_chain = [{
      workflow_ref: planPhases[0].workflowRef,
      input_values: planPhases[0].inputValues as unknown as Record<string, string>,
    }]
  }
  return config
}

/** SG7 (ticket 07): build config.requires from task-level resources[] +
 *  task_spec.subunits[].resources[] (UNION, deduped). Returns undefined when
 *  the union is empty (no resources anywhere) so the config stays minimal.
 *  Mapping: skill→skills, agent→agent_files, command→commands, rule→rules. */
export function buildConfigRequires(
  task_spec: TaskSpec,
  taskResources?: ResourceRef[],
): { skills: string[]; agent_files: string[]; commands: string[]; rules: string[] } | undefined {
  const all: ResourceRef[] = [...(taskResources ?? []), ...(task_spec.resources ?? [])]
  for (const su of task_spec.subunits ?? []) {
    all.push(...(su.resources ?? []))
  }
  if (all.length === 0) return undefined

  const skills = new Set<string>()
  const agent_files = new Set<string>()
  const commands = new Set<string>()
  const rules = new Set<string>()
  for (const ref of all) {
    switch (ref.type) {
      case "skill": skills.add(ref.name); break
      case "agent": agent_files.add(ref.name); break
      case "command": commands.add(ref.name); break
      case "rule": rules.add(ref.name); break
    }
  }
  const result: { skills: string[]; agent_files: string[]; commands: string[]; rules: string[] } = {
    skills: [...skills],
    agent_files: [...agent_files],
    commands: [...commands],
    rules: [...rules],
  }
  // Only return when at least one bucket is non-empty (defensive — `all` was
  // non-empty but an unknown type could land in no bucket; keep the contract).
  if (result.skills.length === 0 && result.agent_files.length === 0
    && result.commands.length === 0 && result.rules.length === 0) {
    return undefined
  }
  return result
}

/** Composite-task input_values for the composition workflow — the verbatim
 *  WorkflowExecutor.buildCompositeInputValues rule, re-homed with the rest of the
 *  task knowledge. The composition Loop consumes `subunits` as REAL objects
 *  (exposing $iteration.subunit), `subunit_count` for its break_when, `goal` as the
 *  moa topic and `integration_prompt` as the aggregator prompt; these mirror
 *  composition-task.yaml's `variables` block.
 *
 *  AC2: PRESERVES task_artifacts_dir from the plan's chain[0] — this function
 *  REPLACES firstStep.input_values wholesale, so without the carry-over the injected
 *  management key would be dropped (the "chain input_values replacement drops
 *  injected keys" hazard SW-BP7).
 *
 *  The scheduler version had to reach back into the tasks table through the
 *  schedule's origin_id to find the spec; here the caller hands the spec over
 *  directly, which is the whole point of the relocation. */
export function buildCompositeInputValues(
  task_spec: TaskSpec,
  plan: WorkflowConfig,
): Record<string, unknown> {
  const chainInputValues = plan.workflow_chain[0]?.input_values as Record<string, unknown> | undefined
  const taskArtifactsDir = chainInputValues?.task_artifacts_dir
  const artifactsEntry = taskArtifactsDir ? { task_artifacts_dir: taskArtifactsDir } : {}
  const subunits = task_spec.subunits ?? []
  return {
    subunits,
    subunit_count: subunits.length,
    goal: task_spec.goal ?? '',
    integration_prompt: task_spec.integration_goal?.prompt ?? '',
    ...artifactsEntry,
  }
}

/**
 * The v4 ready-gate's phase contract, as a pure function.
 *
 * Moved verbatim out of `TasksService.gateV4Phases` (票03) because the built-in
 * task-lifecycle job must resolve phases at LAUNCH time, not only at enqueue time:
 * with the frozen envelope gone, each launch re-derives its plan from the task's own
 * task_spec + home, which is also what makes a spec edit land on the next round (K16)
 * instead of being shadowed by a copy taken when the task was enqueued.
 *
 * For each phase (1-based `i`, array order):
 *   ① specPath file EXISTS — relative resolves under the task home (ADR-0011 +
 *      ADR-0018: the home holds the draft baseline / last collected final state),
 *      absolute paths verbatim ⇒ miss: `phase:<i>:spec-missing`
 *   ② workflow_ref resolves against the SAME set as v3 (installed built-ins ∪
 *      task-home workflows/, ADR-0013) ⇒ miss: `phase:<i>:workflow-ref`
 *   ③ the resolved workflow's required inputs are non-empty AFTER the v4 placeholder
 *      vocabulary resolves (${goal}/${ac}/${phase.slug}/${phase.spec_dir}/${task.home}/
 *      ${task_artifacts_dir}); unknown or empty-resolving placeholders surface as
 *      `phase:<i>:input:<key>` too (never a 500 — v3 AC3 discipline inherited).
 *
 * ① and ② run independently so the UI sees every defect at once; ③ only runs when ②
 * hit (no workflow content to parse otherwise). A phase that passes all three yields a
 * TaskV4PhaseConfig. Empty/missing phases ⇒ single `phase:0:no-phases`. Throws nothing
 * — the caller turns a non-empty missing list into TaskReadyGateError.
 *
 * `resolveRef` is injected rather than called here so the resolution set (which needs
 * BuiltInWorkflowService + TaskHomeService) stays the caller's wiring; the function
 * itself does only fs reads.
 */
export function resolveV4Phases(args: {
  taskSpec: TaskSpec
  homeDir: string
  taskArtifactsDir: string
  resolveRef: (ref: string) => { content: string } | null
}): { missing: string[]; phases: TaskV4PhaseConfig[] } {
  const { taskSpec, homeDir, taskArtifactsDir, resolveRef } = args
  const missing: string[] = []
  const phases = taskSpec.phases ?? []
  if (phases.length < 1) {
    return { missing: ["phase:0:no-phases"], phases: [] }
  }
  const resolved: TaskV4PhaseConfig[] = []
  phases.forEach((p, idx) => {
    const i = idx + 1
    // ① spec file exists (relative ⇒ under the task home)
    const absSpec = path.isAbsolute(p.specPath) ? p.specPath : path.join(homeDir, p.specPath)
    const specOk = fs.existsSync(absSpec) && fs.statSync(absSpec).isFile()
    if (!specOk) missing.push(`phase:${i}:spec-missing`)
    // ② workflow_ref resolvable (single resolve serves ③'s content too)
    const ref = (p.workflowRef ?? "").trim()
    const resolution = ref ? resolveRef(ref) : null
    if (!resolution) {
      missing.push(`phase:${i}:workflow-ref`)
      return
    }
    // ③ required inputs non-empty after v4 placeholder resolution
    const inputDefs = parseWorkflowInputDefs(resolution.content)
    // ${phase.batch_rel}: home-relative posix batch dir — the ws-isomorphic position
    // seed copies the batch into (ADR-0018 spec-consuming flows bind this).
    // Out-of-home/absolute specPath ⇒ "" → key unresolved (gate misses).
    const batchRel = (() => {
      const rel = batchRelPath(homeDir, path.dirname(absSpec))
      return rel ? rel.split(path.sep).join("/") : ""
    })()
    const { values, unresolved } = resolveInputValues(
      p.inputValues,
      taskSpec.goal,
      taskSpec.ac,
      {
        phaseSlug: p.slug,
        phaseSpecDir: path.dirname(absSpec),
        phaseBatchRel: batchRel,
        taskHome: homeDir,
        taskArtifactsDir,
      },
    )
    for (const key of unresolved) missing.push(`phase:${i}:input:${key}`)
    for (const def of inputDefs) {
      if (def.required && !values[def.name]?.trim()) {
        missing.push(`phase:${i}:input:${def.name}`)
      }
    }
    if (specOk) {
      resolved.push({
        index: i,
        name: p.name,
        slug: p.slug,
        specPath: absSpec,
        specDir: path.dirname(absSpec),
        workflowRef: ref,
        inputValues: values,
      })
    }
  })
  // Dedupe — an unresolved placeholder on a required input can hit both the
  // `input:<key>` (unresolved) and `input:<name>` (empty-required) paths.
  return { missing: Array.from(new Set(missing)), phases: resolved }
}

/** One concrete run: WHICH workflow, with WHAT inputs, tagged with which
 *  (phase, round). Everything the execution row needs to be born correct. */
export interface TaskLaunchStep {
  workflowRef: string
  inputValues: Record<string, string>
  /** v4 only — the phase/round tag deriveTaskView + the acceptance ledger read. */
  phaseIndex: number | null
  roundIndex: number | null
  /** v4 only — the phase's home batch dir (seed 下行 / collect 上行 endpoint). */
  specDir: string | null
}

/**
 * Resolve the step a task launch actually runs (票03, was the envelope rewrite in
 * `dispatchPhaseRound`).
 *
 * The envelope used to be MUTATED for this: chain[0] := target phase + status flips +
 * `_phase_index`/`_round_index` stamps written into the stored config, so a crash
 * re-claim would reproduce the same round. A launch plan is built per launch instead,
 * so the same values land on the executions row itself (input_values + phase_index +
 * round_index + task_id) and there is nothing to re-claim from a mutated definition.
 *
 * Round-level routing override (ADR-0018 打回二分路由): `workflowRefOverride` swaps
 * the workflow this round runs (e.g. built-in/task-fix) and `inputOverride` REPLACES
 * the phase's input_values wholesale (fix-round synthesis) — the frozen phases[]
 * binding is untouched, so round 1 of a later re-run returns to the bound workflow.
 */
export function resolveTaskLaunchStep(args: {
  plan: WorkflowConfig
  phaseIndex?: number
  roundIndex?: number
  feedback?: string
  workflowRefOverride?: string
  inputOverride?: Record<string, string>
  prevHandoffPaths?: string[]
}): TaskLaunchStep {
  const { plan, phaseIndex, roundIndex, feedback } = args
  const ext = plan as WorkflowConfig & {
    format?: string
    phases?: TaskV4PhaseConfig[]
  }
  const phase = ext.format === "v4"
    ? (ext.phases ?? []).find((p) => p.index === (phaseIndex ?? 1))
    : undefined

  if (phase) {
    const stepInputValues: Record<string, string> = {
      ...(args.inputOverride ?? phase.inputValues),
      ...(feedback && feedback.trim() ? { feedback } : {}),
      // phase-handoff-chaining: accepted predecessor handoffs, newline-joined.
      // Same-phase rerun/fix never passes it ⇒ never injected.
      ...(args.prevHandoffPaths?.length ? { [PREV_HANDOFF_PATHS_KEY]: args.prevHandoffPaths.join("\n") } : {}),
      // Stamps kept: the var pool exposes them to the workflow and a crash-recovery
      // re-launch of THIS row re-derives identically from the persisted input_values.
      _phase_index: String(phaseIndex ?? 1),
      _round_index: String(roundIndex ?? 1),
    }
    return {
      workflowRef: args.workflowRefOverride?.trim() || phase.workflowRef,
      inputValues: stepInputValues,
      phaseIndex: phaseIndex ?? 1,
      roundIndex: roundIndex ?? 1,
      specDir: phase.specDir ?? null,
    }
  }

  // v3 / legacy / composite: chain[0] is the whole run (task materialization always
  // emits a single-step chain; multi-step chains are the scheduler's own business).
  const first = plan.workflow_chain[0]
  return {
    workflowRef: args.workflowRefOverride?.trim() || first?.workflow_ref || "",
    inputValues: {
      ...((first?.input_values ?? {}) as Record<string, string>),
      ...(args.inputOverride ?? {}),
      ...(feedback && feedback.trim() ? { feedback } : {}),
    },
    phaseIndex: null,
    roundIndex: null,
    specDir: null,
  }
}
