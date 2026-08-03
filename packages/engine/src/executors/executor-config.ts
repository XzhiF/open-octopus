/**
 * Executor Config — structured config objects replacing positional parameter explosion.
 *
 * Hierarchy:
 *   ExecutorDeps (required) + EngineServices (optional) = CoreConfig
 *   CoreConfig + executor-specific fields = XxxConfig
 *
 * Each executor constructor takes: (node, pool, config: XxxConfig)
 */

import type { IAgentProvider } from "@octopus/providers"
import type { AutoAnswer, ModelAliasConfig, CrossExecResolver } from "@octopus/shared"
import { VarPool } from "@octopus/shared"
import type { EngineCallbacks, RuntimeNodeMeta } from "../engine"
import type { JsonlLogger } from "../logger"
import type { ICheckpointStore } from "../pipeline/checkpoint-types"
import type { PromptInjector } from "../prompt-injector"
import type { KnowledgeInjector } from "../knowledge-injector"
import type { AgentNodeRunner } from "./agent-runner"
import type { EngineContext } from "./agent"
import type { InnerNodeOverride, NodeExecutionResult, InteractionMetadata } from "./types"

// ============================================================
// Callback type aliases (inline function types used across executors)
// ============================================================

export type OnLogCallback = (line: string, stream?: "stdout" | "stderr") => void
export type HookExecutor = (event: string, context: Record<string, unknown>) => Promise<void>
export type AgentResolver = (
  topic: string,
  maxExperts: number,
) => Promise<Array<{ role: string; agent_file: string; description: string }>>

// ============================================================
// Required dependencies — every executor needs these
// ============================================================

export interface ExecutorDeps {
  providers: Record<string, IAgentProvider>
  cwd: string
}

// ============================================================
// Shared optional services — used by most executors
// ============================================================

export interface EngineServices {
  callbacks?: EngineCallbacks
  logger?: JsonlLogger
  signal?: AbortSignal
  checkpointStore?: ICheckpointStore
  executionId?: string
  modelAliasConfig?: ModelAliasConfig
  globalAutoAnswers?: AutoAnswer[]
  workflowEngine?: string
  agentResolver?: AgentResolver
  hookExecutor?: HookExecutor
}

// ============================================================
// CoreConfig = required deps + shared services
// ============================================================

export type CoreConfig = ExecutorDeps & EngineServices

// ============================================================
// Per-executor configs
// ============================================================

/** PythonExecutor — simple executor, few extras */
export interface PythonConfig {
  signal?: AbortSignal
  onLog?: OnLogCallback
  nodeOutputs?: Record<string, Record<string, any>>
}

/** ApprovalExecutor — user choice + variable resolution */
export interface ApprovalConfig {
  userChoice?: string
  userComment?: string
  signal?: AbortSignal
  loopContext?: Record<string, any>
  crossExecResolver?: CrossExecResolver
  executionId?: string
  nodeOutputs?: Record<string, Record<string, any>>
  cwd?: string
}

/** InteractionExecutor — chat-based multi-turn interaction */
export interface InteractionConfig {
  completionData?: { summary: string; vars_update?: Record<string, any> }
  signal?: AbortSignal
  loopContext?: Record<string, any>
  crossExecResolver?: CrossExecResolver
  executionId?: string
  nodeOutputs?: Record<string, Record<string, any>>
  cwd?: string
  sessionId?: string
  currentRound?: number
}

/** BashExecutor — logging + variable resolution */
export interface BashConfig {
  signal?: AbortSignal
  onLog?: OnLogCallback
  cwd?: string
  loopContext?: Record<string, any>
  crossExecResolver?: CrossExecResolver
  executionId?: string
  nodeOutputs?: Record<string, Record<string, any>>
}

/** AgentExecutor — the heaviest config, runner is required */
export interface AgentConfig {
  runner: AgentNodeRunner
  engineContext?: EngineContext
  loopContext?: Record<string, any>
  providerKey?: string
  previousSessionId?: string
  signal?: AbortSignal
  globalAutoAnswers?: AutoAnswer[]
  promptInjector?: PromptInjector
  knowledgeInjector?: KnowledgeInjector
  workflowName?: string
  crossExecResolver?: CrossExecResolver
  executionId?: string
  resolvedModel?: string
  modelAliasConfig?: ModelAliasConfig
}

/** SwarmExecutor — multi-agent orchestration */
export interface SwarmConfig {
  providers: Record<string, IAgentProvider>
  cwd: string
  callbacks?: EngineCallbacks
  logger?: JsonlLogger
  checkpointStore?: ICheckpointStore
  executionId?: string
  modelAliasConfig?: ModelAliasConfig
  workflowEngine?: string
  agentResolver?: AgentResolver
  engineHookFn?: HookExecutor
  /** Workflow's global session ID — host agent continues this session */
  globalSessionId?: string
  // Note: signal removed (was DEAD — 0 refs, accessed only as this.signal which doesn't exist)
}

/** LoopExecutor — iteration management + session tracking */
export interface LoopConfig extends CoreConfig {
  globalSessionId?: string
  branchSessionIds?: Map<string, string>
  inputs?: Record<string, any>
  /** Pre-loop node results from engine — enables $nodeId.output resolution for outer nodes */
  engineNodeResults?: Record<string, NodeExecutionResult>
  /** Resolves a workflow by name → parsed definition + raw content (passed to inner sub-workflow executors) */
  workflowResolver?: (name: string) => { parsed: import("@octopus/shared").WorkflowDef; content: string } | undefined
  /** Visited workflow names for recursion detection (passed to inner sub-workflow executors) */
  visitedWorkflows?: Set<string>
  /** Pre-creates a node_execution DB record for dynamically discovered nodes (e.g., sub-workflow children).
   *  Carries optional meta for nested execution hierarchy tracking (parent_node_id, iteration_index). */
  ensureNodeExecution?: (scopedNodeId: string, nodeType: string, meta?: RuntimeNodeMeta) => void
}

/** SubWorkflowExecutor — child workflow execution with scoped VarPool */
export interface SubWorkflowConfig extends CoreConfig {
  globalSessionId?: string
  branchSessionIds?: Map<string, string>
  inputs?: Record<string, any>
  engineNodeResults?: Record<string, NodeExecutionResult>
  /** Resolves a workflow by name → parsed definition + raw content */
  workflowResolver?: (name: string) => { parsed: import("@octopus/shared").WorkflowDef; content: string } | undefined
  /** Visited workflow names for recursion detection */
  visitedWorkflows?: Set<string>
  /** Creates a separate execution record for linked-mode child workflows.
   *  Returns the new execution ID. If not provided, linked mode falls back to inline with a warning. */
  createChildExecution?: (workflowName: string, parentExecutionId: string) => Promise<{ executionId: string }>
  /** Pre-creates a node_execution DB record for a child node (scoped ID).
   *  Called before child engine runs so onNodeStart/onNodeEnd updates find existing rows.
   *  Optional meta carries parent_node_id and iteration_index for nested hierarchy tracking. */
  ensureNodeExecution?: (scopedNodeId: string, nodeType: string, meta?: RuntimeNodeMeta) => void
  /** Current loop iteration index (0-based) — set by LoopExecutor when this sub-workflow is inside a loop.
   *  Used to scope child node IDs per iteration, preventing DB record collisions across iterations. */
  iterationIndex?: number
}

/** DynamicSubWorkflowExecutor — agent-generated DAG with validation harness */
export interface DynamicSubWorkflowConfig extends CoreConfig {
  globalSessionId?: string
  branchSessionIds?: Map<string, string>
  inputs?: Record<string, any>
  engineNodeResults?: Record<string, NodeExecutionResult>
  /** Resolves a workflow by name → parsed definition + raw content */
  workflowResolver?: (name: string) => { parsed: import("@octopus/shared").WorkflowDef; content: string } | undefined
  /** Visited workflow names for recursion detection */
  visitedWorkflows?: Set<string>
  /** Pre-creates a node_execution DB record for a child node (scoped ID). */
  ensureNodeExecution?: (scopedNodeId: string, nodeType: string, meta?: RuntimeNodeMeta) => void
  /** Current loop iteration index (0-based) */
  iterationIndex?: number
  /** Directory for generated YAML files (defaults to {cwd}/workflows/) */
  outputDir?: string
  /** Maximum validation correction rounds (defaults to 3) */
  maxCorrectionRounds?: number
  /** Parent workflow metadata (used for default file naming) */
  workflow?: { name: string; engine?: string; model?: string }
}

/** ResumeConfig — used alongside LoopConfig for resume-from-approval flows */
export interface ResumeConfig {
  innerNodeOverrides?: Map<string, InnerNodeOverride>
  resumeFromNodeId?: string
  resumeIteration?: number
  engineNodeResults?: Record<string, NodeExecutionResult>
  /** Inner node results from the iteration that paused — preserves $nodeId.output across resume */
  prevIterationResults?: Record<string, NodeExecutionResult>
}

// ============================================================
// WorkflowEngine config (Phase 4)
// ============================================================

export interface EngineConfig extends CoreConfig {
  orgDir?: string
  executionId?: string
  initialInputs?: Record<string, string>
  executionName?: string
  crossExecResolver?: CrossExecResolver
  promptInjector?: PromptInjector
  precomputeHook?: (pool: VarPool, workflowName: string, inputs: Record<string, string>) => Promise<void>
  knowledgeInjectorFactory?: (pool: VarPool) => KnowledgeInjector
  agentResolver?: AgentResolver
}
