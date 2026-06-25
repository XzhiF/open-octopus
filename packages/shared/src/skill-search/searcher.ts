import { readFile } from "fs/promises"
import { readdir } from "fs/promises"
import { join } from "path"

export interface SkillSearchResult {
  name: string
  path: string
  category: string
  similarity: number
  description: string
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const frontmatter: Record<string, string> = {}
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim()
      frontmatter[key] = value
    }
  }
  return frontmatter
}

function calcSimilarity(query: string, name: string, description: string, category: string): number {
  const queryLower = query.toLowerCase()
  const queryWords = queryLower.split(/\s+/)

  const nameLower = name.toLowerCase()
  const descLower = description.toLowerCase()
  const catLower = category.toLowerCase()

  let score = 0

  if (nameLower === queryLower) return 100

  if (nameLower.includes(queryLower)) score += 90

  const nameWords = nameLower.split(/[-_\s]+/)
  let nameOverlap = 0
  for (const qw of queryWords) {
    if (nameWords.some(nw => nw.includes(qw) || qw.includes(nw))) nameOverlap++
  }
  score += (nameOverlap / queryWords.length) * 40

  if (catLower === queryLower) score += 50
  if (catLower.includes(queryLower)) score += 30

  const descWords = descLower.split(/\s+/)
  let descOverlap = 0
  for (const qw of queryWords) {
    if (descWords.some(dw => dw.includes(qw))) descOverlap++
  }
  if (descOverlap >= 2) score += 20

  return Math.min(score, 99)
}

export async function searchSkills(
  skillsDir: string,
  query: string,
  category?: string,
  limit?: number,
): Promise<SkillSearchResult[]> {
  const results: SkillSearchResult[] = []

  try {
    const dirs = await readdir(skillsDir, { withFileTypes: true })
    const skillDirs = dirs.filter(d => d.isDirectory())

    for (const dir of skillDirs) {
      const skillMdPath = join(skillsDir, dir.name, "SKILL.md")
      try {
        const content = await readFile(skillMdPath, "utf-8")
        const fm = parseFrontmatter(content)

        const name = fm.name || dir.name
        const description = fm.description || ""
        const cat = fm.category || "other"

        if (category && cat !== category) continue

        const similarity = calcSimilarity(query, name, description, cat)
        if (similarity > 0) {
          results.push({
            name,
            path: join(skillsDir, dir.name),
            category: cat,
            similarity,
            description: description.slice(0, 200),
          })
        }
      } catch {
        continue
      }
    }
  } catch {
    return []
  }

  results.sort((a, b) => b.similarity - a.similarity)
  return results.slice(0, limit ?? 5)
}