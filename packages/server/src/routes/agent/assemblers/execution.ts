// packages/server/src/routes/agent/assemblers/execution.ts
//
// Execution/Task 域装配 —— 任务与分身路由（ExecutionDAO / CloneDAO 消费方）。
// P1 B1（Clone）与 B5（Execution 终批）各碰本文件对应行。
import type { Hono } from 'hono'
import { createCloneRoutes } from '../clone-routes'
import { createTaskRoutes } from '../task-routes'
import type { AgentRouteDeps } from './deps'

export function registerExecutionDomain(agent: Hono, deps: AgentRouteDeps): void {
  // 相对次序沿用拆分前：clone(12) → task(13)
  agent.route('/', createCloneRoutes({}))
  agent.route('/', createTaskRoutes(deps))
}
