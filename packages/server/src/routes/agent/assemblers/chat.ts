// packages/server/src/routes/agent/assemblers/chat.ts
//
// Chat 域装配 —— 会话/聊天主链 + 无 DAO 的 agent 门面（skill/persona/config）。
// AgentSessionDAO 与 TokenUsageDAO 的消费方（B3/B4）在本文件收口。
import type { Hono } from 'hono'
import { createSkillRoutes } from '../skill-routes'
import { createPersonaRoutes } from '../persona'
import { createConfigRoutes } from '../config'
import { createSessionRoutes } from '../sessions'
import { createChatRoutes } from '../chat-routes'
import { createMainAgentRoute } from '../main-agent-route'
import type { AgentRouteDeps } from './deps'
import type { AgentHono } from '../middleware'

export function registerChatDomain(agent: AgentHono, deps: AgentRouteDeps): void {
  const { sessionDAO, safetyDAO, scheduleConfigDAO, tokenUsageDao } = deps
  // 相对次序沿用拆分前：skill(2) → persona(5) → config(6) → sessions(8) → chat(11) → main-agent(14)
  agent.route('/', createSkillRoutes())
  agent.route('/', createPersonaRoutes())
  agent.route('/', createConfigRoutes())
  agent.route('/', createSessionRoutes(sessionDAO))
  agent.route('/', createChatRoutes({ sessionDAO, safetyDAO, scheduleConfigDAO }))
  // Main Agent unified entry (LLM router with clone delegation)
  agent.route('/', createMainAgentRoute({ sessionDAO, tokenUsageDao }))
}
