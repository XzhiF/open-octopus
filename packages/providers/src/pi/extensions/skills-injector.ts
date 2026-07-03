import { readFileSync, existsSync } from 'fs'
import { join, resolve, normalize } from 'path'
import { homedir } from 'os'

/**
 * Inject skill content into prompt.
 * Reads from org-level or global skill directories.
 */
export function injectSkills(prompt: string, skills: string[], orgDir?: string): string {
  const contents: string[] = []

  for (const name of skills) {
    const content = loadSkillContent(name, orgDir)
    if (content) {
      contents.push(`### ${name}\n\n${content}`)
    }
  }

  if (contents.length === 0) return prompt
  return `${prompt}\n\n## Available Skills\n\n${contents.join('\n\n')}`
}

function isPathTraversal(name: string): boolean {
  const normalized = normalize(name)
  return normalized.includes('..') || normalized.startsWith('/') || normalized.startsWith('\\')
}

function loadSkillContent(name: string, orgDir?: string): string | null {
  if (isPathTraversal(name)) return null

  if (orgDir) {
    const orgBase = resolve(orgDir, 'skills')
    const orgPath = join(orgBase, name, 'SKILL.md')
    if (!resolve(orgPath).startsWith(orgBase)) return null
    if (existsSync(orgPath)) return readFileSync(orgPath, 'utf-8')
  }

  const globalBase = join(homedir(), '.octopus', 'skills')
  const globalPath = join(globalBase, name, 'SKILL.md')
  if (!resolve(globalPath).startsWith(globalBase)) return null
  if (existsSync(globalPath)) return readFileSync(globalPath, 'utf-8')

  return null
}
