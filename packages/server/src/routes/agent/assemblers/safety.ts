// packages/server/src/routes/agent/assemblers/safety.ts
//
// Safety 域装配 —— 安全事件/确认/安全模式 + misc（memory 运维/safety/confirm 等）。
// P1 B2 批（SafetyDAO 异步化、reports_fts 首战）只碰本文件。
import type { Hono } from 'hono'
import { createSafeModeRoutes } from '../safe-mode'
import { createSafetyRoutes } from '../safety'
import { createMiscRoutes } from '../misc-routes'
import type { AgentRouteDeps } from './deps'
import type { AgentHono } from '../middleware'

export function registerSafetyDomain(agent: AgentHono, deps: AgentRouteDeps): void {
  const { sessionDAO, safetyDAO } = deps
  // 相对次序沿用拆分前：misc(4) → safe-mode(7) → safety(10)
  agent.route('/', createMiscRoutes({ safetyDAO }))
  agent.route('/', createSafeModeRoutes(sessionDAO, safetyDAO))
  agent.route('/', createSafetyRoutes(safetyDAO))
}
