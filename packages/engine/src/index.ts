export * from "./executors/types"
export type {
  ExecutorDeps, EngineServices, CoreConfig,
  PythonConfig, ApprovalConfig, BashConfig,
  AgentConfig, SwarmConfig, LoopConfig, ResumeConfig,
  EngineConfig, OnLogCallback, HookExecutor, AgentResolver,
} from "./executors/executor-config"
export { BashExecutor } from "./executors/bash"
export { PythonExecutor } from "./executors/python"
export { ConditionExecutor } from "./executors/condition"
export { ApprovalExecutor } from "./executors/approval"
export { LoopExecutor } from "./executors/loop"
export { AgentExecutor } from "./executors/agent"
export { AgentNodeRunner } from "./executors/agent-runner"
export { SwarmExecutor } from "./executors/swarm"
export { RoleRegistry } from "./executors/swarm/role-registry"
export type { RoleDef } from "./executors/swarm/role-registry"
export type { SwarmSSEEvent } from "./executors/swarm/swarm-types"
export type { AgentEvent, AgentRunResult } from "./executors/agent-types"

export { WorkflowEngine } from "./engine"
export type { ExecutionResult, EngineCallbacks } from "./engine"

export { EngineInitPhase } from "./engine-init"
export type {
  EngineInitOptions, EngineInitResult, GitSyncResult,
  GitOpsLike, ResourcePreFlightLike, ResourceProvisionerLike,
  ResourceManifestLike, ResourceCheckResultLike, ResourceProvisionResultLike,
} from "./engine-init"

export { KnowledgeInjector } from "./knowledge-injector"

export { JsonlLogger, sanitizeId, parseLogFilename, isMergedEvent, MERGED_EVENT_TYPES, mergeAgentEvents } from "./logger"
export type { MergedEventType, ParsedLogFilename } from "./logger"
// Pipeline modules
export * from "./pipeline"

// Notify modules
export { registerBuiltinProviders, ProviderRegistry, HermesProvider, WebhookProvider, NotifyDispatcher } from "./notify/index"
export type { DispatchContext } from "./notify/index"
