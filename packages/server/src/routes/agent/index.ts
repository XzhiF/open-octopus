// packages/server/src/routes/agent/index.ts
//
// Pure aggregator — mounts all agent sub-route modules on a single Hono app.
// ZERO inline route handlers; all business logic lives in sub-modules.
//
import { Hono } from 'hono'
import { agentErrorMiddleware, agentAuthMiddleware } from './middleware'
import { createPersonaRoutes } from './persona'
import { createConfigRoutes } from './config'
import { createSafeModeRoutes } from './safe-mode'
import { createSessionRoutes } from './sessions'
import { createMemoryRoutes } from './memory'
import { createSafetyRoutes } from './safety'
import { createChatRoutes } from './chat-routes'
import { createTaskRoutes } from './task-routes'
import { createCloneRoutes } from './clone-routes'
import { createMainAgentRoute, type MainAgentCurationSurface } from './main-agent-route'
import { createEvolutionRoutes } from './evolution-routes'
import { createSkillRoutes } from './skill-routes'
import { createScheduleRoutes } from './schedule-routes'
import { createMiscRoutes } from './misc-routes'
import { createDebugRoutes } from './debug-routes'
import { createFsRoutes } from './fs-routes'
import { WorkspaceDAO, AgentSessionDAO, EvolutionDAO, SafetyDAO, ScheduleConfigDAO, ExecutionDAO, CloneDAO } from '../../db/dao'
import { SchedulerService } from '../../services/scheduler/scheduler-service'
import type { TokenUsageDAO } from '../../db/dao/token-usage-dao'
import { TaskThreadService } from '../../services/tasks/task-thread-service'
import { TaskHomeService } from '../../services/tasks/task-home-service'
import { WorkspaceService } from '../../services/workspace'
import fs from 'fs'
import path from 'path'
import os from 'os'

interface AgentRouteDeps {
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
  /** 票10 投喂泛化: 知识策展执行面（透传给 createMainAgentRoute 的 ingest_to_wiki 工具）。
   *  装配侧可用惰性闭包（挂载先于服务构造时，请求时才解析）。 */
  curation?: MainAgentCurationSurface
  /** 服务端唤醒通知（ChatEventBridge → 前端 session SSE）。 */
  sse?: import('../../services/sse').SSEService
}

export function createAgentRoutes(deps: AgentRouteDeps): Hono {
  const {
    sessionDAO, safetyDAO, scheduleConfigDAO, evolutionDAO, cloneDAO, tokenUsageDao, curation,
  } = deps

  const agent = new Hono()

  // ── Middleware ───────────────────────────────────────────────────────
  agent.use('*', agentErrorMiddleware)
  agent.use('*', agentAuthMiddleware)

  // ── Mount sub-route modules ─────────────────────────────────────────
  // Literal routes before parameterized routes (Hono priority)
  agent.route('/', createScheduleRoutes({ scheduleConfigDAO }))
  agent.route('/', createSkillRoutes())
  agent.route('/', createEvolutionRoutes({ evolutionDAO }))
  agent.route('/', createMiscRoutes({ safetyDAO }))
  agent.route('/', createDebugRoutes({ sessionDAO, tokenUsageDAO: tokenUsageDao }))
  agent.route('/', createFsRoutes())

  // Existing sub-modules
  agent.route('/', createPersonaRoutes())
  agent.route('/', createConfigRoutes())
  agent.route('/', createSafeModeRoutes(sessionDAO, safetyDAO))
  agent.route('/', createSessionRoutes(sessionDAO))
  agent.route('/', createMemoryRoutes())
  agent.route('/', createSafetyRoutes(safetyDAO))
  // 2026-10-28 task-thread: one main chat per task. Constructed here because
  // the chat route needs it before TasksService is created (async init block).
  const taskThread = new TaskThreadService({
    db: sessionDAO.getDb(),
    workspaceService: new WorkspaceService(deps.workspaceDAO),
    taskHomeService: new TaskHomeService(),
  })

  agent.route('/', createChatRoutes({ sessionDAO, safetyDAO, scheduleConfigDAO, tokenUsageDao, sse: deps.sse, taskThread }))

  // New extractions
  agent.route('/', createCloneRoutes({}))
  agent.route('/', createTaskRoutes(deps))

  // Main Agent unified entry (LLM router with clone delegation)
  agent.route('/', createMainAgentRoute({ sessionDAO, tokenUsageDao, curation: deps.curation }))

  return agent
}
