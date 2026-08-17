export { ClaudeSDKProvider } from './claude/provider'
export type { IAgentProvider, SendQueryOptions, MessageChunk, TokenUsage, ModelUsageEntry, SystemPromptInput, SystemPromptPreset } from './types'
export { registerProvider, getProvider, getProviderAsync, isProviderRegistered, listProviders, resetProviderInstances } from './registry'
export { LLMCallTracker, computeCost, calibrateCosts } from './llm-call-tracker'
export type { LLMCallRecord } from './llm-call-tracker'

// Pi Provider
export { PiAgentProvider } from './pi/provider'
export { classifyProviderError, sanitizeErrorMessage } from './errors'
export { buildSessionEnv } from './pi/security'
export type { ProviderError } from './errors'
export type { OctopusAgentDef, ProviderPolicy } from './types'
export { EventEmitter } from './shared/event-emitter'
export { testConnectivity } from './connectivity'
export type { ConnectivityResult } from './connectivity'

// 07 (SG11): prompt-enhancer — resurrected from dead code. Used by
// TaskAuthorSessionAugmenter (server) to format authoring_resources[]
// SKILL.md content into the task-author session's systemPrompt.append.
export { enhancePromptWithSkills } from './pi/prompt-enhancer'
