import { existsSync } from "fs"
import { join } from "path"
import type { ManifestEntry } from "./manifest"
import { inferAutoTags } from "./tags"
import { detectKnowledge, extractRepowikiDesc, extractAgentMdDesc, createKnowledgeInfo, type KnowledgeInfo } from "./knowledge"
import { findLocalRepo } from "./scan"

export interface ProjectInfoFull {
  name: string
  group: string
  branch: string
  git_url: string
  tags: string[]
  tag_source: string
  description: string
  desc_source: string
  local_path: string | null
  knowledge: KnowledgeInfo
}

export function buildProjectInfos(
  manifestEntries: Record<string, ManifestEntry[]>,
  cloneBase: string,
  externalPaths?: Record<string, string>,
  includeLocalScan?: boolean,
  existingPaths?: Record<string, string>
): Record<string, ProjectInfoFull[]> {
  const ep: Record<string, string> = externalPaths ?? {}
  const doLocalScan = includeLocalScan ?? true
  const xp: Record<string, string> = existingPaths ?? {}

  const result: Record<string, ProjectInfoFull[]> = {}

  for (const [group, entries] of Object.entries(manifestEntries)) {
    const groupProjects: ProjectInfoFull[] = []

    for (const entry of entries) {
      let tags: string[]
      let tagSource: string
      if (entry.manual_tags.length > 0) {
        tags = entry.manual_tags
        tagSource = "manual"
      } else {
        tags = inferAutoTags(entry.name)
        tagSource = "auto"
      }

      const gitUrl = entry.git_url
      const branch = entry.branch

      let localPath: string | null = null
      let knowledge = createKnowledgeInfo()

      if (doLocalScan) {
        if (entry.name in ep) {
          localPath = ep[entry.name]
        } else {
          localPath = findLocalRepo(group, entry.name, cloneBase)
        }

        // Fallback: preserve existing valid local path from previous index
        if (!localPath && xp[entry.name]) {
          const existingPath = xp[entry.name]
          if (existsSync(existingPath) && existsSync(join(existingPath, ".git"))) {
            localPath = existingPath
          }
        }

        if (localPath) {
          knowledge = detectKnowledge(localPath)
        }
      }

      let descSource = "none"
      let description = ""

      if (localPath) {
        const wikiDesc = extractRepowikiDesc(localPath)
        if (wikiDesc) {
          description = wikiDesc
          descSource = "repowiki"
        }
      }

      if (!description && localPath) {
        const agentDesc = extractAgentMdDesc(localPath)
        if (agentDesc) {
          description = agentDesc
          descSource = "agent-md"
        }
      }

      groupProjects.push({
        name: entry.name,
        group,
        branch,
        git_url: gitUrl,
        tags,
        tag_source: tagSource,
        description,
        desc_source: descSource,
        local_path: localPath,
        knowledge,
      })
    }

    result[group] = groupProjects
  }

  return result
}

export function applyAiDesc(
  projectInfos: Record<string, ProjectInfoFull[]>,
  cliName: string
): void {
  console.warn(`AI desc generation for CLI '${cliName}' is not yet implemented in TypeScript — skipping`)
}