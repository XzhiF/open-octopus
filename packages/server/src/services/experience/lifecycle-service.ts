import type { ExperienceDAO } from "../../db/dao/experience-dao"
import type { KnowledgeFiles } from "../archive/knowledge-files"

export class ExperienceLifecycleService {
  constructor(
    private experienceDAO: ExperienceDAO,
    private knowledgeFiles: KnowledgeFiles,
  ) {}

  async markResolved(prUrl: string, prBody: string): Promise<number> {
    const bugRefs = this.extractBugRefs(prBody)
    if (bugRefs.length === 0) return 0

    let resolvedCount = 0
    const now = new Date().toISOString()

    for (const ref of bugRefs) {
      const experiences = this.experienceDAO.searchFTS(ref, {
        status: "active",
        type: "bug",
        limit: 10,
      })

      for (const exp of experiences) {
        this.experienceDAO.updateStatus(exp.id, "resolved", now, prUrl)
        resolvedCount++
      }
    }

    if (resolvedCount > 0) {
      const projects = new Set<string>()
      const allActive = this.experienceDAO.findByScope({
        status: "active",
        limit: 1000,
      })
      for (const exp of allActive) {
        if (exp.project) projects.add(exp.project)
      }
      for (const project of projects) {
        this.knowledgeFiles.rebuild(project)
      }
    }

    return resolvedCount
  }

  async decayStale(): Promise<number> {
    const count = this.experienceDAO.decayStale(90)
    if (count > 0) {
      const projects = new Set<string>()
      const allActive = this.experienceDAO.findByScope({
        status: "active",
        limit: 1000,
      })
      for (const exp of allActive) {
        if (exp.project) projects.add(exp.project)
      }
      for (const project of projects) {
        this.knowledgeFiles.rebuild(project)
      }
    }
    return count
  }

  async supersede(newItem: {
    id: string
    project?: string
    file_pattern?: string
    type: string
  }): Promise<void> {
    if (newItem.project && newItem.file_pattern) {
      this.experienceDAO.supersedeByDimension(
        newItem.project,
        newItem.file_pattern,
        newItem.type,
        newItem.id,
      )
    }
  }

  private extractBugRefs(body: string): string[] {
    const refs: string[] = []
    const bugPattern = /BUG-(\d+)/gi
    const fixesPattern = /fixes\s+#(\d+)/gi

    let match
    while ((match = bugPattern.exec(body)) !== null) {
      refs.push(`BUG-${match[1]}`)
    }
    while ((match = fixesPattern.exec(body)) !== null) {
      refs.push(`#${match[1]}`)
    }

    return refs
  }
}
