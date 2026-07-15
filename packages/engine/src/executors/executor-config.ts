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
import type { AutoAnswer, ModelAliasConfig, CrossExecResolver, NodeDef } from "@octopus/shared"
import type { EngineCallbacks } from "../engine"
import type { JsonlLogger } from "../logger"
import type { ICheckpointStore } from "../pipeline/checkpoint-types"
import type { PromptInjector } from "../prompt-injector"
import type { KnowledgeInjector } from "../knowledge-injector"
import type { AgentNodeRunner } from "./agent-runner"
import type { EngineContext } from "./agent"
import type { InnerNodeOverride, NodeExecutionResult } from "./types"

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
}

/** ApprovalExecutor — user choice + variable resolution */
export interface ApprovalConfig {
  userChoice?: string
  userComment?: string
  signal?: AbortSignal
  loopContext?: Record<string, any>
  crossExecResolver?: CrossExecResolver
  executionId?: string
}

/** BashExecutor — logging + variable resolution */
export interface BashConfig {
  signal?: AbortSignal
  onLog?: OnLogCallback
  cwd?: string
  loopContext?: Record<string, any>
  crossExecResolver?: CrossExecResolver
  executionId?: string
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
  // Note: signal removed (was DEAD — 0 refs, accessed only as this.signal which doesn't exist)
}

/** LoopExecutor — iteration management + session tracking */
export interface LoopConfig extends CoreConfig {
  globalSessionId?: string
  branchSessionIds?: Map<string, string>
  inputs?: Record<string, any>
}

/** ResumeConfig — used alongside LoopConfig for resume-from-approval flows */
export interface ResumeConfig {
  innerNodeOverrides?: Map<string, InnerNodeOverride>
  resumeFromNodeId?: string
  resumeIteration?: number
  engineNodeResults?: Record<string, NodeExecutionResult>
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
  precomputeHook?: (pool: any, workflowName: string, inputs: Record<string, string>) => Promise<void>
  knowledgeInjectorFactory?: (pool: any) => KnowledgeInjector
  agentResolver?: AgentResolver
}
