import type { ExperienceDAO } from "../../db/dao/experience-dao"
import { writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export class KnowledgeFiles {
  constructor(private experienceDAO: ExperienceDAO) {}

  rebuild(project: string): void {
    const experiences = this.experienceDAO.findByScope({
      projects: [project],
      status: "active",
      limit: 200,
    })

    const byType: Record<string, typeof experiences> = {
      bug: [],
      pattern: [],
      cost: [],
      failure: [],
    }

    for (const exp of experiences) {
      if (byType[exp.type]) {
        byType[exp.type].push(exp)
      }
    }

    const knowledgeDir = join(homedir(), ".octopus", "knowledge", project)
    if (!existsSync(knowledgeDir)) {
      mkdirSync(knowledgeDir, { recursive: true })
    }

    for (const [type, items] of Object.entries(byType)) {
      if (items.length === 0) continue

      const sorted = items.slice(0, 50).sort((a, b) => b.relevance_score - a.relevance_score)
      const content = this.generateMarkdown(type, sorted)
      const filename = `${type}s.md`
      writeFileSync(join(knowledgeDir, filename), content, "utf-8")
    }
  }

  private generateMarkdown(type: string, items: any[]): string {
    const title = type.charAt(0).toUpperCase() + type.slice(1) + "s"
    const lines: string[] = [`# ${title}`, ""]

    for (const item of items) {
      lines.push(`## ${item.title}`)
      lines.push("")
      lines.push(item.content)
      lines.push("")
      if (item.keywords) {
        lines.push(`**Keywords:** ${item.keywords}`)
        lines.push("")
      }
    }

    return lines.join("\n")
  }
}
