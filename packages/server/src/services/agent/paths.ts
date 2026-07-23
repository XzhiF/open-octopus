import os from 'os'
import path from 'path'

/**
 * Global agent directory utilities.
 * Agent data is stored at ~/.octopus/agent/ — shared across all orgs.
 * Supports per-agent isolation via agentId parameter.
 */

/** Get Octopus home dir — function for test isolation (B7 fix) */
function getHome(): string {
  return process.env.OCTOPUS_HOME ?? path.join(os.homedir(), '.octopus')
}

/**
 * Root agent directory: ~/.octopus/agent or ~/.octopus/agent/{agentId}
 * @param agentId - Optional agent identifier for per-agent isolation
 */
export function getAgentDir(agentId?: string): string {
  const base = path.join(getHome(), 'agent')
  return agentId ? path.join(base, agentId) : base
}

/**
 * Agent memory directory: ~/.octopus/agent/memory or ~/.octopus/agent/{agentId}/memory
 * @param agentId - Optional agent identifier for per-agent isolation
 */
export function getAgentMemoryDir(agentId?: string): string {
  return path.join(getAgentDir(agentId), 'memory')
}

/** Agent clones directory: ~/.octopus/agent/clones */
export function getClonesDir(): string {
  return path.join(getAgentDir(), 'clones')
}

/** Specific clone directory: ~/.octopus/agent/clones/{name} */
export function getCloneDir(name: string): string {
  return path.join(getClonesDir(), name)
}

/**
 * Agent skills directory: ~/.octopus/agent/skills or ~/.octopus/agent/{agentId}/skills
 * @param agentId - Optional agent identifier for per-agent isolation
 */
export function getAgentSkillsDir(agentId?: string): string {
  return path.join(getAgentDir(agentId), 'skills')
}

/**
 * Agent persona file: ~/.octopus/agent/persona.md or ~/.octopus/agent/{agentId}/persona.md
 * @param agentId - Optional agent identifier for per-agent isolation
 */
export function getPersonaPath(agentId?: string): string {
  return path.join(getAgentDir(agentId), 'persona.md')
}

/**
 * Agent config file: ~/.octopus/agent/config.yaml or ~/.octopus/agent/{agentId}/config.yaml
 * @param agentId - Optional agent identifier for per-agent isolation
 */
export function getAgentConfigPath(agentId?: string): string {
  return path.join(getAgentDir(agentId), 'config.yaml')
}

/** Agent reports directory: ~/.octopus/agent/reports */
export function getReportsDir(): string {
  return path.join(getAgentDir(), 'reports')
}

/** Agent debug traces directory: ~/.octopus/agent/debug/traces */
export function getDebugTracesDir(): string {
  return path.join(getAgentDir(), 'debug', 'traces')
}

/** Agent evolution experiences directory: ~/.octopus/agent/evolution/experiences */
export function getExperiencesDir(): string {
  return path.join(getAgentDir(), 'evolution', 'experiences')
}

/**
 * Agent daily memory directory: ~/.octopus/agent/memory/daily or ~/.octopus/agent/{agentId}/memory/daily
 * @param agentId - Optional agent identifier for per-agent isolation
 */
export function getDailyMemoryDir(agentId?: string): string {
  return path.join(getAgentMemoryDir(agentId), 'daily')
}

/**
 * Agent long-term memory file: ~/.octopus/agent/memory/long-term.md or ~/.octopus/agent/{agentId}/memory/long-term.md
 * @param agentId - Optional agent identifier for per-agent isolation
 */
export function getLongTermMemoryPath(agentId?: string): string {
  return path.join(getAgentMemoryDir(agentId), 'long-term.md')
}

/** Agent notification queue directory: ~/.octopus/agent/notification-queue */
export function getNotificationQueueDir(): string {
  return path.join(getAgentDir(), 'notification-queue')
}

/** Octopus home directory: ~/.octopus (or $OCTOPUS_HOME) */
export function getOctopusHome(): string {
  return getHome()
}
