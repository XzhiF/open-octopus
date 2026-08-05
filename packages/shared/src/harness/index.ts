// Harness module — barrel exports
//
// Note: HarnessDirective is exported from types/octopus-agent.ts
// (extended with "inject" type there).

export type {
  DiagnosisReport,
  InterventionAction,
  HarnessNodeStatus,
  HarnessSSEEvent,
  HarnessSystemConfig,
  DetectorConfig,
  StrategyConfig,
  StrategyAction,
  IsolationConfig,
  HarnessEvent,
} from "./types"

export {
  HarnessSystemConfigSchema,
  DetectorConfigSchema,
  StrategyConfigSchema,
  StrategyActionSchema,
  IsolationConfigSchema,
} from "./config-schema"
export type { HarnessSystemConfigParsed } from "./config-schema"

export { computeErrorHash, simpleHash } from "./utils"
export type { ErrorResultLike } from "./utils"
