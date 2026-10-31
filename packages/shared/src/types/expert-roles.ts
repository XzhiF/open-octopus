/**
 * Expert catalog — the AGENCY roster (agency-agents-zh role files).
 *
 * Since v59 identities and @ delegation moved to CLONES, so this catalog no
 * longer drives the chat surfaces. Remaining consumers are the task-domain
 * views that still label agency-role ids:
 *   - MoA / 变更专家窗口 (expert-label rendering, 任务域)
 *   - legacy role-card interpretation (存量 kind='expert' 会话)
 * The mention parser / id list that used to live here had zero callers after
 * the move and were removed.
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

export function expertLabel(id: string): string {
  return EXPERT_ROLES.find((role) => role.id === id)?.label ?? id
}

export function expertName(id: string): string {
  return EXPERT_ROLES.find((role) => role.id === id)?.name ?? id
}
