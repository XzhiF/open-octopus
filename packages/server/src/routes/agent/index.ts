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
import { createEvolutionRoutes } from './evolution-routes'
import { createSkillRoutes } from './skill-routes'
import { createScheduleRoutes } from './schedule-routes'
import { createMiscRoutes } from './misc-routes'
import { WorkspaceDAO, AgentSessionDAO, EvolutionDAO, SafetyDAO, ScheduleConfigDAO, ExecutionDAO } from '../../db/dao'
import { SchedulerService } from '../../services/scheduler/scheduler-service'
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
  schedulerService: SchedulerService
}

export function createAgentRoutes(deps: AgentRouteDeps): Hono {
  const {
    sessionDAO, safetyDAO, scheduleConfigDAO, evolutionDAO,
  } = deps

  const agent = new Hono()

  // ── Middleware ───────────────────────────────────────────────────────
  agent.use('*', agentErrorMiddleware)
  agent.use('*', agentAuthMiddleware)

  // ── Org resolution middleware — fallback to default_org from config ──
  agent.use('*', async (c, next) => {
    if (!c.req.header('X-Octopus-Org') && !c.get('org')) {
      try {
        const configPath = path.join(os.homedir(), '.octopus', 'config.yaml')
        if (fs.existsSync(configPath)) {
          const yaml = require('js-yaml')
          const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as { default_org?: string }
          if (raw?.default_org) {
            c.set('org', raw.default_org)
          }
        }
      } catch {
        if (process.env.OCTOPUS_ORG) {
          c.set('org', process.env.OCTOPUS_ORG)
        }
      }
    }
    await next()
  })

  // ── Mount sub-route modules ─────────────────────────────────────────
  // Literal routes before parameterized routes (Hono priority)
  agent.route('/', createScheduleRoutes({ scheduleConfigDAO }))
  agent.route('/', createSkillRoutes())
  agent.route('/', createEvolutionRoutes({ evolutionDAO }))
  agent.route('/', createMiscRoutes({ safetyDAO }))

  // Existing sub-modules
  agent.route('/', createPersonaRoutes())
  agent.route('/', createConfigRoutes())
  agent.route('/', createSafeModeRoutes(sessionDAO))
  agent.route('/', createSessionRoutes(sessionDAO))
  agent.route('/', createMemoryRoutes())
  agent.route('/', createSafetyRoutes(safetyDAO))
  agent.route('/', createChatRoutes({ sessionDAO, safetyDAO, scheduleConfigDAO }))

  // New extractions
  agent.route('/', createCloneRoutes({ safetyDAO }))
  agent.route('/', createTaskRoutes(deps))

  return agent
}
