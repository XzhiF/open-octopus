export interface IndexEntry {
  name: string
  git_url: string
  branch: string
  tags: string[]
  tag_source: string
  description: string
  desc_source: string
  local_path: string | null
  knowledge_line: string
}

const GROUP_LABELS: Record<string, string> = {
  xzf: "xzf",
}

export function parseIndex(content: string): IndexEntry[] {
  const entries: IndexEntry[] = []
  let currentName = ""
  let currentGitUrl = ""
  let currentBranch = ""
  let currentTags: string[] = []
  let currentTagSource = ""
  let currentDesc = ""
  let currentDescSource = ""
  let currentLocalPath: string | null = null
  let currentKnowledgeLine = ""

  for (const line of content.split("\n")) {
    const stripped = line.trim()

    if (stripped.startsWith("### ")) {
      currentName = stripped.slice(4).trim()
      currentGitUrl = ""
      currentBranch = ""
      currentTags = []
      currentTagSource = ""
      currentDesc = ""
      currentDescSource = ""
      currentLocalPath = null
      currentKnowledgeLine = ""
    } else if (stripped.startsWith("- git:") && currentName) {
      currentGitUrl = stripped.slice(6).trim()
    } else if (stripped.startsWith("- branch:") && currentName) {
      currentBranch = stripped.slice(9).trim()
    } else if (stripped.startsWith("- keywords:") && currentName) {
      const kwPart = stripped.slice(11).trim()
      const bracketMatch = kwPart.match(/\[([^\]]+)\]/)
      if (bracketMatch) {
        currentTags = bracketMatch[1].split(",").map((t) => t.trim())
      }
      const tagSourceMatch = kwPart.match(/← tags:(\w+)/)
      if (tagSourceMatch) {
        currentTagSource = tagSourceMatch[1]
      }
    } else if (stripped.startsWith("- desc:") && currentName) {
      let descPart = stripped.slice(7).trim()
      if (descPart === "—") {
        currentDesc = ""
        currentDescSource = "none"
      } else {
        const fromMatch = descPart.match(/\(from (\w+)\)/)
        if (fromMatch) {
          currentDescSource = fromMatch[1]
          descPart = descPart.slice(0, descPart.lastIndexOf("(from")).trim()
        }
        currentDesc = descPart
      }
    } else if (stripped.startsWith("- local:") && currentName) {
      if (stripped.includes("✓ cloned")) {
        currentLocalPath = stripped
          .slice(8)
          .replace("✓ cloned", "")
          .trim()
      }
    } else if (stripped.startsWith("- knowledge:") && currentName) {
      currentKnowledgeLine = stripped.slice(12).trim()
    } else if (stripped === "" && currentName && currentGitUrl) {
      entries.push({
        name: currentName,
        git_url: currentGitUrl,
        branch: currentBranch,
        tags: currentTags,
        tag_source: currentTagSource,
        description: currentDesc,
        desc_source: currentDescSource,
        local_path: currentLocalPath,
        knowledge_line: currentKnowledgeLine,
      })
      currentName = ""
    }
  }

  if (currentName && currentGitUrl) {
    entries.push({
      name: currentName,
      git_url: currentGitUrl,
      branch: currentBranch,
      tags: currentTags,
      tag_source: currentTagSource,
      description: currentDesc,
      desc_source: currentDescSource,
      local_path: currentLocalPath,
      knowledge_line: currentKnowledgeLine,
    })
  }

  return entries
}

export interface ProjectInfo {
  name: string
  group: string
  branch: string
  git_url: string
  tags: string[]
  tag_source: string
  description: string
  desc_source: string
  local_path: string | null
  knowledge: KnowledgeInfoForIndex
}

export interface KnowledgeInfoForIndex {
  is_cloned: boolean
  repowiki_exists: boolean
  repowiki_stale: boolean
  formatLine(): string
}

export function generateIndex(
  projectInfos: Record<string, ProjectInfo[]>
): string {
  const lines: string[] = [
    "# GitRepo Index",
    "",
    "> Auto-generated from manifest + local scan.",
    "",
  ]

  let totalProjects = 0
  let totalGroups = 0

  const sortedGroups = Object.keys(projectInfos).sort()

  for (const groupName of sortedGroups) {
    const projects = projectInfos[groupName]
    if (!projects || projects.length === 0) continue

    totalGroups++
    const label = GROUP_LABELS[groupName] ?? groupName
    lines.push(`## ${groupName} (${label})`)
    lines.push("")

    const sorted = [...projects].sort((a, b) =>
      a.name.localeCompare(b.name)
    )

    for (const p of sorted) {
      totalProjects++

      lines.push(`### ${p.name}`)
      lines.push(`- git: ${p.git_url}`)
      lines.push(`- branch: ${p.branch}`)

      if (p.tags.length > 0) {
        const tagStr = p.tags.join(", ")
        lines.push(`- keywords: [${tagStr}] ← tags:${p.tag_source}`)
      }

      if (p.description) {
        if (p.desc_source && p.desc_source !== "none") {
          lines.push(`- desc: ${p.description} (from ${p.desc_source})`)
        } else {
          lines.push(`- desc: ${p.description}`)
        }
      } else {
        lines.push("- desc: —")
      }

      if (p.knowledge.is_cloned && p.local_path) {
        lines.push(`- local: ${p.local_path} ✓ cloned`)
      } else {
        lines.push("- local: — not cloned")
      }

      lines.push(`- knowledge: ${p.knowledge.formatLine()}`)
      lines.push("")
    }
  }

  lines.push("---")
  lines.push(
    `*Generated by octopus repos — ${totalProjects} projects from ${totalGroups} groups*`
  )

  return lines.join("\n")
}

export function parseIndexLocalPaths(
  content: string
): Record<string, string> {
  const result: Record<string, string> = {}
  let currentName = ""

  for (const line of content.split("\n")) {
    const stripped = line.trim()

    if (stripped.startsWith("### ")) {
      currentName = stripped.slice(4).trim()
    } else if (stripped.startsWith("- local:") && currentName) {
      if (stripped.includes("✓ cloned")) {
        const path = stripped
          .slice(8)
          .replace("✓ cloned", "")
          .trim()
        result[currentName] = path
      }
      currentName = ""
    }
  }

  return result
}

export function parseIndexBranches(
  content: string
): Record<string, string> {
  const result: Record<string, string> = {}
  let currentName = ""

  for (const line of content.split("\n")) {
    const stripped = line.trim()

    if (stripped.startsWith("### ")) {
      currentName = stripped.slice(4).trim()
    } else if (stripped.startsWith("- branch:") && currentName) {
      const branch = stripped.slice(9).trim()
      result[currentName] = branch
    }
  }

  return result
}