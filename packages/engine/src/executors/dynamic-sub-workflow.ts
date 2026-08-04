// packages/engine/src/executors/dynamic-sub-workflow.ts
//
// DynamicSubWorkflowExecutor — generates a DAG of agent nodes at runtime via LLM,
// validates through a 3-layer harness with auto-correction, persists as YAML + meta.json,
// then executes the generated DAG as a child workflow.
//
import { VarPool, resolveModelAlias } from "@octopus/shared"
import type { NodeDef, WorkflowDef, ModelAliasConfig } from "@octopus/shared"
import type { NodeExecutor, NodeExecutionResult } from "./types"
import type { DynamicSubWorkflowConfig } from "./executor-config"
import type { IAgentProvider } from "@octopus/providers"
import { AgentNodeRunner } from "./agent-runner"
import { validateL1Structure, validateL2Graph, validateL3Semantics, runValidationPipeline } from "./dynamic-sub-workflow-validation"
import { computeInputHash, buildInputSnapshot } from "./dynamic-sub-workflow-hash"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"

// ─── Types ───────────────────────────────────────────────────────────────────

interface MetaFile {
  generated_at: string
  input_hash: string
  input_snapshot: Record<string, unknown>
  validation_rounds: number
  execution_status: "pending" | "completed" | "failed"
  node_count: number
}

interface GeneratedDAG {
  nodes: Array<{
    id: string
    type: "agent"
    prompt: string
    skills?: string[]
    depends_on?: string[]
    model?: string
  }>
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract JSON from agent response text (handles markdown code fences). */
function extractJsonFromText(text: string): unknown {
  // Try direct parse first
  try {
    return JSON.parse(text)
  } catch { /* continue */ }

  // Try extracting from ```json ... ``` code fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim())
    } catch { /* continue */ }
  }

  // Try finding JSON object in text
  const objMatch = text.match(/\{[\s\S]*"nodes"[\s\S]*\}/)
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0])
    } catch { /* continue */ }
  }

  return null
}

/** Build the DAG generation prompt for the agent. */
function buildGenerationPrompt(
  userPrompt: string,
  inputSnapshot: Record<string, unknown>,
  correctionErrors?: string[],
): string {
  const parts: string[] = []

  parts.push("You are a DAG planner for a workflow engine. Generate a JSON object describing a directed acyclic graph of agent nodes.")
  parts.push("")
  parts.push("## Output Format (STRICT JSON)")
  parts.push('```json')
  parts.push('{')
  parts.push('  "nodes": [')
  parts.push('    {')
  parts.push('      "id": "unique-node-id",')
  parts.push('      "type": "agent",')
  parts.push('      "prompt": "What this agent should do",')
  parts.push('      "skills": ["optional-skill-name"],')
  parts.push('      "depends_on": ["other-node-id"]')
  parts.push('    }')
  parts.push('  ]')
  parts.push('}')
  parts.push('```')
  parts.push("")
  parts.push("## Constraints")
  parts.push("- ALL nodes must have type: \"agent\"")
  parts.push("- ALL nodes must have a non-empty prompt")
  parts.push("- depends_on must reference existing node IDs")
  parts.push("- No circular dependencies allowed")
  parts.push("- Output ONLY the JSON object, no explanation")
  parts.push("")
  parts.push("## Task")
  parts.push(userPrompt)
  parts.push("")
  parts.push("## Input Data")
  parts.push("```json")
  parts.push(JSON.stringify(inputSnapshot, null, 2))
  parts.push("```")

  if (correctionErrors && correctionErrors.length > 0) {
    parts.push("")
    parts.push("## Previous Attempt Had Errors — FIX THESE")
    for (const err of correctionErrors) {
      parts.push(`- ${err}`)
    }
    parts.push("Generate a corrected DAG that resolves all errors above.")
  }

  return parts.join("\n")
}

/** Convert a GeneratedDAG to a WorkflowDef YAML-like structure. */
function dagToWorkflowDef(dag: GeneratedDAG, workflowName: string, parentModel?: string): WorkflowDef {
  return {
    apiVersion: "octopus/v1",
    kind: "Workflow",
    name: workflowName,
    execution_mode: "auto",
    model: parentModel,
    nodes: dag.nodes.map((n) => ({
      id: n.id,
      type: "agent" as const,
      prompt: n.prompt,
      skills: n.skills,
      depends_on: n.depends_on,
      model: n.model ?? parentModel,
    })),
  }
}

/** Serialize a WorkflowDef to YAML (simple serializer for generated files). */
function workflowDefToYaml(wf: WorkflowDef): string {
  const lines: string[] = []
  lines.push(`apiVersion: ${wf.apiVersion}`)
  lines.push(`kind: ${wf.kind}`)
  lines.push(`name: ${wf.name}`)
  if (wf.model) lines.push(`model: ${wf.model}`)
  if (wf.description) lines.push(`description: ${wf.description}`)
  lines.push("nodes:")
  for (const node of wf.nodes) {
    lines.push(`  - id: ${node.id}`)
    lines.push(`    type: ${node.type}`)
    if (node.prompt) {
      const promptLines = node.prompt.split("\n")
      if (promptLines.length > 1) {
        lines.push("    prompt: |")
        for (const pl of promptLines) {
          lines.push(`      ${pl}`)
        }
      } else {
        lines.push(`    prompt: "${node.prompt.replace(/"/g, '\\"')}"`)
      }
    }
    if (node.model) lines.push(`    model: ${node.model}`)
    if (node.skills && node.skills.length > 0) {
      lines.push(`    skills: [${node.skills.join(", ")}]`)
    }
    if (node.depends_on && node.depends_on.length > 0) {
      lines.push(`    depends_on: [${node.depends_on.join(", ")}]`)
    }
  }
  return lines.join("\n") + "\n"
}

// ─── Executor ────────────────────────────────────────────────────────────────

export class DynamicSubWorkflowExecutor implements NodeExecutor {
  private config: DynamicSubWorkflowConfig

  constructor(
    private node: NodeDef,
    private pool: VarPool,
    config: DynamicSubWorkflowConfig,
  ) {
    this.config = config
  }

  async execute(): Promise<NodeExecutionResult> {
    const start = Date.now()
    const logLines: string[] = []
    const onError = this.node.on_error ?? "fail"
    const maxCorrectionRounds = this.config.maxCorrectionRounds ?? 3

    // 1. Resolve file name
    const workflowName = this.resolveWorkflowName()
    const outputDir = this.config.outputDir ?? join(this.config.cwd, "workflows")
    const yamlPath = join(outputDir, `${workflowName}.yaml`)
    const metaPath = join(outputDir, `${workflowName}.meta.json`)

    logLines.push(`Dynamic sub-workflow: ${workflowName}`)
    logLines.push(`Output: ${yamlPath}`)

    // 2. Build input snapshot and compute hash
    const inputSnapshot = buildInputSnapshot(
      this.node,
      this.pool,
      this.config.engineNodeResults ?? {},
    )
    const inputHash = computeInputHash(inputSnapshot)
    logLines.push(`Input hash: ${inputHash.substring(0, 12)}...`)

    // 3. Check for existing meta.json (rerun detection)
    let dag: GeneratedDAG | undefined
    let validationRounds = 0

    if (existsSync(metaPath)) {
      try {
        const meta: MetaFile = JSON.parse(readFileSync(metaPath, "utf-8"))
        if (meta.input_hash === inputHash) {
          logLines.push("Context unchanged (hash match) — reusing existing DAG")
          // Load existing YAML
          if (existsSync(yamlPath)) {
            const yamlContent = readFileSync(yamlPath, "utf-8")
            dag = this.parseYamlToDag(yamlContent, logLines)
          }
        } else {
          logLines.push("Context changed (hash mismatch) — regenerating DAG")
        }
      } catch (err) {
        logLines.push(`Meta file read error: ${err} — regenerating`)
      }
    }

    // 4. Generate DAG if needed
    if (!dag) {
      const genResult = await this.generateAndValidateDAG(
        inputSnapshot,
        maxCorrectionRounds,
        logLines,
      )

      if (genResult.error) {
        return {
          outputs: { generated_workflow: workflowName },
          status: "failed",
          durationMs: Date.now() - start,
          logLines,
          error: genResult.error,
        }
      }

      dag = genResult.dag!
      validationRounds = genResult.rounds

      // 5. Persist YAML + meta.json
      this.persistDAG(dag, workflowName, yamlPath, metaPath, inputHash, inputSnapshot, validationRounds, logLines)
    }

    if (!dag || dag.nodes.length === 0) {
      return {
        outputs: { generated_workflow: workflowName },
        status: "failed",
        durationMs: Date.now() - start,
        logLines,
        error: "No DAG nodes generated",
      }
    }

    // 6. Execute the generated DAG
    const execResult = await this.executeDAG(dag, workflowName, logLines, onError)

    // 7. Update meta.json with execution status
    this.updateMetaExecutionStatus(metaPath, execResult.status === "completed" ? "completed" : "failed")

    const outputs: Record<string, any> = {
      generated_workflow: workflowName,
      node_count: dag.nodes.length,
      validation_rounds: validationRounds,
    }

    if (execResult.error) {
      outputs.error = execResult.error
    }

    return {
      outputs,
      status: execResult.status as NodeExecutionResult["status"],
      durationMs: Date.now() - start,
      logLines,
      error: execResult.error,
    }
  }

  // ─── Private Methods ─────────────────────────────────────────────────

  private resolveWorkflowName(): string {
    const baseName = this.node.workflow ?? `${this.config.workflow?.name ?? "workflow"}__${this.node.id}`
    const execSuffix = this.config.executionId ? `-${this.config.executionId}` : ""
    const iterSuffix = this.config.iterationIndex != null ? `-iter${this.config.iterationIndex}` : ""
    return `${baseName}${execSuffix}${iterSuffix}`
  }

  private async generateAndValidateDAG(
    inputSnapshot: Record<string, unknown>,
    maxCorrectionRounds: number,
    logLines: string[],
  ): Promise<{ dag?: GeneratedDAG; rounds: number; error?: string }> {
    let lastErrors: string[] = []

    for (let round = 0; round <= maxCorrectionRounds; round++) {
      const correctionErrors = round > 0 ? lastErrors : undefined
      logLines.push(`Generation round ${round + 1}${correctionErrors ? " (correction)" : ""}`)

      // Call agent
      const agentText = await this.callAgent(inputSnapshot, correctionErrors, logLines)
      if (!agentText) {
        return { rounds: round + 1, error: "Agent returned no response" }
      }

      // Parse JSON
      const json = extractJsonFromText(agentText)
      if (!json) {
        lastErrors = ["L1: Agent response could not be parsed as JSON"]
        logLines.push("  JSON parse failed — will retry with correction")
        continue
      }

      // Run validation pipeline
      const validation = runValidationPipeline(json)
      if (validation.result.valid) {
        logLines.push(`  Validation passed (L1+L2+L3)`)
        const dag = json as GeneratedDAG
        return { dag, rounds: round + 1 }
      }

      lastErrors = validation.errors
      logLines.push(`  Validation failed: ${validation.errors.length} errors`)
      for (const err of validation.errors) {
        logLines.push(`    - ${err}`)
      }

      if (round < maxCorrectionRounds) {
        logLines.push("  Attempting auto-correction...")
      }
    }

    // All rounds exhausted
    const errorSummary = lastErrors.join("; ")
    logLines.push(`FAILED after ${maxCorrectionRounds + 1} rounds: ${errorSummary}`)
    return {
      rounds: maxCorrectionRounds + 1,
      error: `DAG validation failed after ${maxCorrectionRounds + 1} rounds: ${errorSummary}`,
    }
  }

  private async callAgent(
    inputSnapshot: Record<string, unknown>,
    correctionErrors: string[] | undefined,
    logLines: string[],
  ): Promise<string | null> {
    const userPrompt = this.node.prompt
    if (!userPrompt) {
      logLines.push("Missing prompt for dynamic_sub_workflow node")
      return null
    }

    // Find provider
    const engineKey = this.node.engine ?? this.config.workflowEngine ?? "claude"
    const providerKey = engineKey === "claude-code" ? "claude" : engineKey
    const provider = this.config.providers?.[providerKey]
    if (!provider) {
      logLines.push(`Provider not found: ${providerKey}`)
      return null
    }

    // Resolve model
    let resolvedModel = this.node.model
    if (resolvedModel && this.config.modelAliasConfig) {
      const aliased = resolveModelAlias(resolvedModel, providerKey, this.config.modelAliasConfig)
      if (aliased) resolvedModel = aliased
    }

    const prompt = buildGenerationPrompt(userPrompt, inputSnapshot, correctionErrors)

    const runner = new AgentNodeRunner(provider as IAgentProvider, this.config.cwd, (event) => {
      this.config.logger?.log(this.node.id, "agent_event", { event_data: event })
      this.config.callbacks?.onAgentEvent?.(this.node.id, event)
    })

    try {
      const result = await runner.run({
        prompt,
        skills: this.node.skills,
        model: resolvedModel ?? undefined,
        context: "new",
        signal: this.config.signal,
      })

      logLines.push(`Agent responded (${result.finalText.length} chars, ${result.durationMs}ms)`)
      return result.finalText
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logLines.push(`Agent call failed: ${msg}`)
      return null
    }
  }

  private persistDAG(
    dag: GeneratedDAG,
    workflowName: string,
    yamlPath: string,
    metaPath: string,
    inputHash: string,
    inputSnapshot: Record<string, unknown>,
    validationRounds: number,
    logLines: string[],
  ): void {
    // Ensure output directory exists
    mkdirSync(join(yamlPath, ".."), { recursive: true })

    // Write YAML
    const wfDef = dagToWorkflowDef(dag, workflowName, this.node.model)
    const yamlContent = workflowDefToYaml(wfDef)
    writeFileSync(yamlPath, yamlContent, "utf-8")
    logLines.push(`Written: ${yamlPath}`)

    // Write meta.json
    const meta: MetaFile = {
      generated_at: new Date().toISOString(),
      input_hash: inputHash,
      input_snapshot: inputSnapshot,
      validation_rounds: validationRounds,
      execution_status: "pending",
      node_count: dag.nodes.length,
    }
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8")
    logLines.push(`Written: ${metaPath}`)

    // Write execution-scoped snapshot (prevents overwrites on repeated executions)
    // Use base workflow name (without executionId) so API can find it by ref
    if (this.config.executionId) {
      const snapshotDir = join(this.config.cwd, "state", "dynamic-workflows", this.config.executionId)
      mkdirSync(snapshotDir, { recursive: true })

      const baseName = this.node.workflow ?? `${this.config.workflow?.name ?? "workflow"}__${this.node.id}`
      const iterSuffix = this.config.iterationIndex != null ? `-iter${this.config.iterationIndex}` : ""
      const snapshotName = `${baseName}${iterSuffix}`

      const snapshotYamlPath = join(snapshotDir, `${snapshotName}.yaml`)
      const snapshotMetaPath = join(snapshotDir, `${snapshotName}.meta.json`)

      writeFileSync(snapshotYamlPath, yamlContent, "utf-8")
      writeFileSync(snapshotMetaPath, JSON.stringify(meta, null, 2), "utf-8")
      logLines.push(`Written execution snapshot: ${snapshotYamlPath}`)
    }
  }

  private parseYamlToDag(yamlContent: string, logLines: string[]): GeneratedDAG | undefined {
    // Simple YAML-to-DAG parser for generated files (we wrote them, so format is predictable)
    try {
      // Dynamic import to avoid hard dependency on yaml parser
      // Use regex-based parsing since we control the output format
      const nodes: GeneratedDAG["nodes"] = []
      const nodeBlocks = yamlContent.split(/\n  - /).slice(1) // skip header

      for (const block of nodeBlocks) {
        const id = block.match(/id:\s*(.+)/)?.[1]?.trim()
        const type = block.match(/type:\s*(.+)/)?.[1]?.trim()
        const promptMatch = block.match(/prompt:\s*(?:"([^"]+)"|([\s\S]+?)(?=\n\s+\w+:|$))/)
        const prompt = promptMatch?.[1] ?? promptMatch?.[2]?.trim()
        const skillsMatch = block.match(/skills:\s*\[([^\]]*)\]/)?.[1]
        const skills = skillsMatch ? skillsMatch.split(",").map((s) => s.trim()) : undefined
        const depsMatch = block.match(/depends_on:\s*\[([^\]]*)\]/)?.[1]
        const depends_on = depsMatch ? depsMatch.split(",").map((s) => s.trim()) : undefined
        const model = block.match(/model:\s*(.+)/)?.[1]?.trim()

        if (id && type === "agent") {
          nodes.push({
            id,
            type: "agent",
            prompt: prompt ?? "",
            skills,
            depends_on,
            model,
          })
        }
      }

      logLines.push(`Loaded existing DAG: ${nodes.length} nodes`)
      return { nodes }
    } catch (err) {
      logLines.push(`Failed to parse existing YAML: ${err}`)
      return undefined
    }
  }

  private async executeDAG(
    dag: GeneratedDAG,
    workflowName: string,
    logLines: string[],
    onError: "fail" | "continue",
  ): Promise<{ status: string; error?: string }> {
    const wfDef = dagToWorkflowDef(dag, workflowName, this.node.model)

    // Register child nodes with scoped IDs
    const iterSuffix = this.config.iterationIndex != null ? `-iter${this.config.iterationIndex}` : ""
    if (this.config.ensureNodeExecution) {
      for (const childNode of wfDef.nodes) {
        this.config.ensureNodeExecution(
          `${this.node.id}:${childNode.id}${iterSuffix}`,
          childNode.type,
          { parentNodeId: this.node.id, iterationIndex: this.config.iterationIndex },
        )
      }
    }

    // Create child VarPool
    const childPool = new VarPool()
    childPool.set("workflow_name", workflowName)
    childPool.set("parent_workflow_name", this.pool.get("workflow_name"))

    // Copy parent pool vars
    const parentSnapshot = this.pool.snapshot()
    for (const [key, value] of Object.entries(parentSnapshot)) {
      childPool.set(key, value)
    }

    // Execute via child WorkflowEngine
    try {
      const { WorkflowEngine } = await import("../engine")

      const childCallbacks = this.createChildCallbacks(logLines, workflowName)

      const childEngine = new WorkflowEngine(
        wfDef,
        this.config.providers,
        this.config.cwd,
        this.config.cwd,
        childCallbacks,
        this.config.signal,
        this.config.executionId ? `${this.config.executionId}-${workflowName}` : undefined,
        this.config.inputs,
      )

      childEngine.updateVarPool(childPool.snapshot())

      if (this.config.workflowResolver) {
        const childVisited = new Set(this.config.visitedWorkflows ?? [])
        childVisited.add(workflowName)
        childEngine.setWorkflowResolver(this.config.workflowResolver, childVisited)
      }

      const result = await childEngine.run()

      const childFailed = ["failed", "cancelled"].includes(result.status)
      if (childFailed && onError === "fail") {
        logLines.push(`Generated DAG "${workflowName}" ${result.status}`)
        return { status: "failed", error: `Generated DAG "${workflowName}" ${result.status}` }
      }

      const status = childFailed && onError === "continue" ? "completed" : result.status
      logLines.push(`Generated DAG "${workflowName}" completed in ${result.durationMs}ms`)

      // Copy child pool outputs back to parent
      for (const [key, value] of Object.entries(result.poolSnapshot)) {
        if (value !== undefined) {
          this.pool.set(key, value)
        }
      }

      return { status }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logLines.push(`DAG execution error: ${msg}`)
      if (onError === "continue") {
        return { status: "completed" }
      }
      return { status: "failed", error: msg }
    }
  }

  private createChildCallbacks(logLines: string[], workflowName: string) {
    const fmt = (event: string, detail: string) => `${workflowName}:${event} ${detail}`
    const iterSuffix = this.config.iterationIndex != null ? `-iter${this.config.iterationIndex}` : ""
    const scoped = (childNodeId: string) => `${this.node.id}:${childNodeId}${iterSuffix}`

    return {
      onNodeStart: (nodeId: string, nodeType: string) => {
        const msg = fmt("node_start", `${nodeId} (${nodeType})`)
        logLines.push(msg)
        this.config.callbacks?.onNodeStart?.(scoped(nodeId), nodeType)
        this.config.logger?.log(scoped(nodeId), "node_log", { line: msg })
        this.config.callbacks?.onNodeLog?.(this.node.id, msg)
      },
      onNodeEnd: (nodeId: string, status: string, durationMs: number, result?: NodeExecutionResult, nodeType?: string) => {
        const msg = fmt("node_end", `${nodeId} ${status} (${durationMs}ms)`)
        logLines.push(msg)
        this.config.callbacks?.onNodeEnd?.(scoped(nodeId), status, durationMs, result, nodeType)
        this.config.logger?.log(scoped(nodeId), "node_log", { line: msg })
        this.config.callbacks?.onNodeLog?.(this.node.id, msg)
      },
      onNodeLog: (nodeId: string, logLine: string) => {
        const scopedId = scoped(nodeId)
        this.config.callbacks?.onNodeLog?.(scopedId, logLine)
        this.config.logger?.log(scopedId, "node_log", { line: logLine })
      },
      onRuntimeNodeAdded: (nodeId: string, nodeType: string, meta?: { parentNodeId?: string; iterationIndex?: number }) => {
        this.config.callbacks?.onRuntimeNodeAdded?.(scoped(nodeId), nodeType, {
          ...meta,
          parentNodeId: meta?.parentNodeId ? `${this.node.id}:${meta.parentNodeId}${iterSuffix}` : this.node.id,
        })
      },
      onStatusChange: (status: string, progress: number) => {
        logLines.push(fmt("status", `${status} (${progress}%)`))
      },
      onError: (nodeId: string, error: string) => {
        const msg = fmt("error", `${nodeId}: ${error}`)
        logLines.push(msg)
        this.config.callbacks?.onError?.(scoped(nodeId), error)
        this.config.callbacks?.onNodeLog?.(this.node.id, msg)
      },
      onAgentEvent: (nodeId: string, event: any) => {
        this.config.callbacks?.onAgentEvent?.(scoped(nodeId), event)
      },
    }
  }

  private updateMetaExecutionStatus(metaPath: string, status: "completed" | "failed"): void {
    try {
      if (existsSync(metaPath)) {
        const meta: MetaFile = JSON.parse(readFileSync(metaPath, "utf-8"))
        meta.execution_status = status
        writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8")
      }
    } catch {
      // Non-critical — ignore meta update failures
    }
  }
}
