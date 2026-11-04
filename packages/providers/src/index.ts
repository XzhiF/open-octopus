export { ClaudeSDKProvider } from './claude/provider'
export {
  guardIdle,
  withSoftTimeout,
  IdleTimeoutError,
  IDLE_TIMEOUT_CODE,
  DEFAULT_FIRST_EVENT_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from './idle-watchdog'
export type { GuardIdleOptions } from './idle-watchdog'
export { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
export type { IAgentProvider, SendQueryOptions, MessageChunk, SystemPromptInput, SystemPromptPreset, ContextUsageData, GoalTerminalReason, ActiveGoalChunk, BackgroundTaskInfo } from './types'
export { registerProvider, getProvider, getProviderAsync, listProviders, resetProviderInstances } from './registry'
export { LLMCallTracker } from './llm-call-tracker'
export type { LLMCallRecord } from './llm-call-tracker'
// 注意：TokenUsage / ModelUsage / TokenUsageDelta 一律从 @octopus/shared 导入（C1 口径统一），
// providers 包不再 re-export 任何 token 形状。

// Pi Provider
export { PiAgentProvider } from './pi/provider'
export { classifyProviderError, sanitizeErrorMessage } from './errors'
export { buildSessionEnv } from './pi/security'
export type { ProviderError } from './errors'
export type { OctopusAgentDef, ProviderPolicy } from './types'
export { testConnectivity } from './connectivity'
export type { ConnectivityResult } from './connectivity'

// 07 (SG11): prompt-enhancer — resurrected from dead code. Used by
// TaskAuthorSessionAugmenter (server) to format authoring_resources[]
// SKILL.md content into the task-author session's systemPrompt.append.
export { enhancePromptWithSkills } from './pi/prompt-enhancer'
