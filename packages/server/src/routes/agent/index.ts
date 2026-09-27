// packages/server/src/routes/agent/index.ts
//
// Pure aggregator — delegates to per-domain assemblers (B0.5 §5 方案2).
// ZERO inline route handlers; all business logic lives in sub-modules;
// each migration batch (P1 B1-B5) edits only its own assembler file here.
//
// 装配纪律：
//   - 各 assembler 内部相对次序 = 拆分前全局次序在自己域内的投影（注释里标了原位）。
//   - 路由集合等价性由 src/__tests__/route-snapshot.test.ts 逐位钉死（排序快照）。
//   - 跨域无同 method+pattern 冲突（misc 的 /memory/* 全是 POST 且带独立后缀，
//     memory 域只有 GET /memory/:layer 与它们共前缀 —— Hono 静态段优先，且
//     /memory/search vs /memory/:layer 这对真正敏感的组合同在 memory.ts 内部，次序未动）。
import { Hono } from 'hono'
import { agentErrorMiddleware, agentAuthMiddleware } from './middleware'
import type { AgentRouteDeps } from './assemblers/deps'
import { registerScheduleDomain } from './assemblers/schedule'
import { registerMemoryDomain } from './assemblers/memory'
import { registerSafetyDomain } from './assemblers/safety'
import { registerChatDomain } from './assemblers/chat'
import { registerExecutionDomain } from './assemblers/execution'
import fs from 'fs'
import path from 'path'
import os from 'os'

export type { AgentRouteDeps }

export function createAgentRoutes(deps: AgentRouteDeps): Hono {
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

  // ── Mount per-domain assemblers ─────────────────────────────────────
  // Literal routes before parameterized routes (Hono priority)
  registerScheduleDomain(agent, deps)
  registerMemoryDomain(agent, deps)
  registerSafetyDomain(agent, deps)
  registerChatDomain(agent, deps)
  registerExecutionDomain(agent, deps)

  return agent
}
