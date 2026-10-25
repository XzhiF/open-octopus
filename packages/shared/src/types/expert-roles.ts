/**
 * Fixed expert catalog shared by the web consult UI and the server-side
 * session roster. Ids match the agency-agents-zh role files; the server
 * resolves the same ids into SDK subagent definitions at chat time.
 *
 * Two surfaces use this catalog:
 *   - chat UI "expert identity" selection → session-level role switch
 *     (a role card appended to the conversation; system prompt unchanged)
 *   - `@专家名` mention → one-turn subagent dispatch (identity unchanged)
 */
export const EXPERT_ROLES = [
  { id: 'product-manager', name: '产品经理', label: '📦 产品经理', desc: '需求完整性、用户价值、优先级' },
  { id: 'engineering-software-architect', name: '软件架构师', label: '🏛️ 软件架构师', desc: '系统设计、DDD、技术决策' },
  { id: 'engineering-code-reviewer', name: '代码审查员', label: '👀 代码审查员', desc: '正确性、可维护性、性能' },
  { id: 'engineering-security-engineer', name: '安全工程师', label: '🔒 安全工程师', desc: '威胁建模、漏洞评估' },
  { id: 'engineering-sre', name: 'SRE', label: '🛠️ SRE', desc: '可靠性、SLO、可观测性' },
  { id: 'engineering-rapid-prototyper', name: '快速原型师', label: '⚡ 快速原型师', desc: '快速验证想法、MVP 创建' },
  { id: 'engineering-frontend-developer', name: '前端开发者', label: '💻 前端开发者', desc: 'UI 实现、性能优化' },
  { id: 'engineering-codebase-onboarding-engineer', name: '代码库引导工程师', label: '🧭 代码库引导工程师', desc: '快速上手陌生代码库' },
  { id: 'prompt-engineer', name: '提示词工程师', label: '🧠 提示词工程师', desc: '提示词设计、输出质量优化' },
  { id: 'agents-orchestrator', name: '智能体编排者', label: '🎭 智能体编排者', desc: '编排多智能体工作流' },
] as const

export type ExpertRole = (typeof EXPERT_ROLES)[number]

export const EXPERT_ROLE_IDS: readonly string[] = EXPERT_ROLES.map((role) => role.id)

export function expertLabel(id: string): string {
  return EXPERT_ROLES.find((role) => role.id === id)?.label ?? id
}

export function expertName(id: string): string {
  return EXPERT_ROLES.find((role) => role.id === id)?.name ?? id
}

/** Resolve a `@` token (id or Chinese name) to a catalog role. */
export function expertByMention(token: string): ExpertRole | undefined {
  const key = token.trim().replace(/^@+/, '').trim()
  if (!key) return undefined
  return EXPERT_ROLES.find(
    (role) => role.id === key || role.name === key || role.label === key,
  )
}

/**
 * Extract one-turn expert mentions from user text. `@@clone` remains the
 * clone-delegation syntax and is deliberately ignored here.
 */
export function parseExpertMentions(text: string): ExpertRole[] {
  const out: ExpertRole[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(/(^|\s)@([^\s@]+)/g)) {
    const role = expertByMention(match[2])
    if (!role || seen.has(role.id)) continue
    seen.add(role.id)
    out.push(role)
  }
  return out
}
