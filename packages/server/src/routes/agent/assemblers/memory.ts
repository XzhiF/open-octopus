// packages/server/src/routes/agent/assemblers/memory.ts
//
// Memory/Knowledge 域装配 —— 进化与记忆路由（EvolutionDAO / SessionMemory 消费方）。
// P1 B3 批（记忆/知识域 DAO 异步化 + FTS→pg_search）只碰本文件。
import type { Hono } from 'hono'
import { createEvolutionRoutes } from '../evolution-routes'
import { createMemoryRoutes } from '../memory'
import type { AgentRouteDeps } from './deps'

export function registerMemoryDomain(agent: Hono, deps: AgentRouteDeps): void {
  const { evolutionDAO } = deps
  // 相对次序沿用拆分前：evolution(3) → memory(9)
  agent.route('/', createEvolutionRoutes({ evolutionDAO }))
  agent.route('/', createMemoryRoutes())
}
