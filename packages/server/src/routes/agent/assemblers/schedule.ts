// packages/server/src/routes/agent/assemblers/schedule.ts
//
// Schedule 域装配 —— 定时作业路由（ScheduleConfigDAO 消费方）。
// P1 B5 批（schedule 簇 DAO 异步化）只碰本文件。
import type { Hono } from 'hono'
import { createScheduleRoutes } from '../schedule-routes'
import type { AgentRouteDeps } from './deps'

export function registerScheduleDomain(agent: Hono, deps: AgentRouteDeps): void {
  agent.route('/', createScheduleRoutes({ scheduleConfigDAO: deps.scheduleConfigDAO }))
}
