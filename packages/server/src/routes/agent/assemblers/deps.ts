// packages/server/src/routes/agent/assemblers/deps.ts
//
// Agent 路由域共享依赖契约（B0.5 §5 方案2 拆分时从 index.ts 原样平移）。
// 单独成文件是为避免 index ↔ assembler 的 import 环。

import type {
  WorkspaceDAO, AgentSessionDAO, EvolutionDAO, SafetyDAO,
  ScheduleConfigDAO, ExecutionDAO, CloneDAO,
} from '../../../db/dao'
import type { SchedulerService } from '../../../services/scheduler/scheduler-service'
import type { TokenUsageDAO } from '../../../db/dao/token-usage-dao'

export interface AgentRouteDeps {
  workspaceDAO: WorkspaceDAO
  sessionDAO: AgentSessionDAO
  evolutionDAO: EvolutionDAO
  safetyDAO: SafetyDAO
  scheduleConfigDAO: ScheduleConfigDAO
  executionDAO: ExecutionDAO
  cloneDAO: CloneDAO
  schedulerService: SchedulerService
  /** billing-coverage-2 票03: Main Agent 统一入口/委托链入账（透传给 createMainAgentRoute）。 */
  tokenUsageDao?: TokenUsageDAO
}
