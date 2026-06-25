import os from 'os'
import path from 'path'

/**
 * Global agent directory utilities.
 * Agent data is stored at ~/.octopus/agent/ — shared across all orgs.
 */

const OCTOPUS_HOME = process.env.OCTOPUS_HOME ?? path.join(os.homedir(), '.octopus')

/** Root agent directory: ~/.octopus/agent */
export function getAgentDir(): string {
  return path.join(OCTOPUS_HOME, 'agent')
}

/** Agent memory directory: ~/.octopus/agent/memory */
export function getAgentMemoryDir(): string {
  return path.join(getAgentDir(), 'memory')
}

/** Agent clones directory: ~/.octopus/agent/clones */
export function getClonesDir(): string {
  return path.join(getAgentDir(), 'clones')
}

/** Specific clone directory: ~/.octopus/agent/clones/{name} */
export function getCloneDir(name: string): string {
  return path.join(getClonesDir(), name)
}

/** Agent skills directory: ~/.octopus/agent/skills */
export function getAgentSkillsDir(): string {
  return path.join(getAgentDir(), 'skills')
}

/** Agent persona file: ~/.octopus/agent/persona.md */
export function getPersonaPath(): string {
  return path.join(getAgentDir(), 'persona.md')
}

/** Agent config file: ~/.octopus/agent/config.yaml */
export function getAgentConfigPath(): string {
  return path.join(getAgentDir(), 'config.yaml')
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

/** Agent daily memory directory: ~/.octopus/agent/memory/daily */
export function getDailyMemoryDir(): string {
  return path.join(getAgentMemoryDir(), 'daily')
}

/** Agent long-term memory file: ~/.octopus/agent/memory/long-term.md */
export function getLongTermMemoryPath(): string {
  return path.join(getAgentMemoryDir(), 'long-term.md')
}

/** Agent notification queue directory: ~/.octopus/agent/notification-queue */
export function getNotificationQueueDir(): string {
  return path.join(getAgentDir(), 'notification-queue')
}

/** Octopus home directory: ~/.octopus (or $OCTOPUS_HOME) */
export function getOctopusHome(): string {
  return OCTOPUS_HOME
}
