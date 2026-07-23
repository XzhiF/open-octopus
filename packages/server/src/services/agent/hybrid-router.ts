import { getProvider } from '@octopus/providers'
import { getAgentRegistry, type AvatarConfig } from './agent-registry'

export type RouterLayer = 'regex' | 'llm'

export interface RouterDecision {
  intent: string
  confidence: number
  layer: RouterLayer
  agent: AvatarConfig | null
  reasoning: string
}

interface RegexRule {
  pattern: RegExp
  intent: string
  confidence: number
}

const REGEX_RULES: RegexRule[] = [
  { pattern: /每天|每日|定时|cron|定期|每周|每月|凌晨|schedule|periodic|recurring|interval/i, intent: 'scheduled_task', confidence: 0.9 },
  { pattern: /分身|clone|创建分身|委派|delegate|merge.*分身|合并分身|前端分身|后端分身/i, intent: 'clone_management', confidence: 0.85 },
  { pattern: /归档|archive|整理.*文档|总结.*项目|项目.*回顾|workspace.*analysis/i, intent: 'archive_analysis', confidence: 0.85 },
  { pattern: /昨天做了什么|上次|历史|查看.*记录|搜索|回忆|之前|最近.*做了|what did|history|recall|previously/i, intent: 'info_query', confidence: 0.85 },
  { pattern: /给.*加|添加|创建|实现|开发|修复|重构|部署|配置|add|create|implement|develop|fix|refactor|deploy|build/i, intent: 'single_task', confidence: 0.8 },
]

const LLM_TIMEOUT_MS = 5000

export class HybridIntentRouter {
  async route(message: string): Promise<RouterDecision> {
    const regexResult = this.routeByRegex(message)
    if (regexResult) return regexResult

    return this.routeByLLM(message)
  }

  routeByRegex(message: string): RouterDecision | null {
    for (const rule of REGEX_RULES) {
      if (rule.pattern.test(message)) {
        const registry = getAgentRegistry()
        const agents = registry.findByIntent(rule.intent)
        const agent = agents[0] ?? null

        return {
          intent: rule.intent,
          confidence: rule.confidence,
          layer: 'regex',
          agent,
          reasoning: `Regex match: ${rule.pattern.source}`,
        }
      }
    }
    return null
  }

  async routeByLLM(message: string): Promise<RouterDecision> {
    const registry = getAgentRegistry()
    const agents = registry.list()

    const intentList = agents.map(a => `- ${a.id}: ${a.description} (intents: ${a.handlesIntents.join(', ')})`).join('\n')

    const prompt = `Classify the user message into one of the available agent intents.

Available agents:
${intentList}

User message: "${message}"

Respond with ONLY a JSON object: {"intent": "<agent_id>", "confidence": <0-1>, "reasoning": "<brief reason>"}`

    try {
      const provider = getProvider('claude')
      const chunks: string[] = []

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('LLM routing timeout')), LLM_TIMEOUT_MS)
      )

      const streamPromise = (async () => {
        const stream = provider.sendQuery(prompt, process.cwd(), undefined, {
          systemPrompt: 'You are an intent classifier. Respond with only a JSON object.',
        })
        for await (const chunk of stream) {
          if (chunk.type === 'text_delta') chunks.push(chunk.content)
        }
      })()

      await Promise.race([streamPromise, timeoutPromise])

      const response = chunks.join('').trim()
      const cleaned = response.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
      const parsed = JSON.parse(cleaned)

      const intent = String(parsed.intent || 'general_chat')
      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.6
      const reasoning = String(parsed.reasoning || 'LLM classification')

      const agent = registry.get(intent) ?? registry.findByIntent(intent)[0] ?? null

      return {
        intent,
        confidence,
        layer: 'llm',
        agent,
        reasoning,
      }
    } catch {
      const fallbackAgent = registry.get('workspace-agent') ?? registry.list()[0] ?? null
      return {
        intent: 'general_chat',
        confidence: 0.5,
        layer: 'llm',
        agent: fallbackAgent,
        reasoning: 'LLM routing failed, falling back to workspace-agent',
      }
    }
  }
}

let routerInstance: HybridIntentRouter | null = null

export function getHybridRouter(): HybridIntentRouter {
  if (!routerInstance) {
    routerInstance = new HybridIntentRouter()
  }
  return routerInstance
}
