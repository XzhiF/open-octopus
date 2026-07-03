import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
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

function loadSkillContent(name: string, orgDir?: string): string | null {
  if (orgDir) {
    const orgPath = join(orgDir, 'skills', name, 'SKILL.md')
    if (existsSync(orgPath)) return readFileSync(orgPath, 'utf-8')
  }

  const globalPath = join(homedir(), '.octopus', 'skills', name, 'SKILL.md')
  if (existsSync(globalPath)) return readFileSync(globalPath, 'utf-8')

  return null
}
