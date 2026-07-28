import os from 'os'
import path from 'path'
import fs from 'fs'

/**
 * Global agent directory utilities.
 * Agent data is stored at ~/.octopus/agent/ — shared across all orgs.
 */

/** Get Octopus home dir — function for test isolation (B7 fix) */
function getHome(): string {
  return process.env.OCTOPUS_HOME ?? path.join(os.homedir(), '.octopus')
}

/** Root agent directory: ~/.octopus/agent */
export function getAgentDir(): string {
  return path.join(getHome(), 'agent')
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
  return getHome()
}

/** Built-in clones directory: ~/.octopus/agent/built-in */
export function getBuiltInClonesDir(): string {
  return path.join(getAgentDir(), 'built-in')
}

/** Specific built-in clone directory: ~/.octopus/agent/built-in/{name} */
export function getBuiltInCloneDir(name: string): string {
  return path.join(getBuiltInClonesDir(), name)
}

/** Built-in clone memory directory: ~/.octopus/agent/built-in/{name}/memory */
export function getBuiltInCloneMemoryDir(name: string): string {
  return path.join(getBuiltInCloneDir(name), 'memory')
}

/** Clone-specific skills directory.
 *  built-in: ~/.octopus/agent/built-in/{name}/skills
 *  user:     ~/.octopus/agent/clones/{name}/skills
 */
export function getCloneSkillsDir(name: string, type: 'built-in' | 'user'): string {
  if (type === 'built-in') {
    return path.join(getBuiltInCloneDir(name), 'skills')
  }
  return path.join(getCloneDir(name), 'skills')
}

// ── File utilities ─────────────────────────────────────────────────

/**
 * Create a `.bak` backup of a file if it exists and no backup already exists.
 * Returns the backup path, or `null` if no backup was created.
 */
export function backupFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null
  const bakPath = filePath + '.bak'
  if (!fs.existsSync(bakPath)) {
    fs.copyFileSync(filePath, bakPath)
  }
  return bakPath
}
