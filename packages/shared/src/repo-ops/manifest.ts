export interface ManifestEntry {
  name: string
  git_url: string
  branch: string
  manual_tags: string[]
  group: string
}

export function parseManifest(content: string): Record<string, ManifestEntry[]> {
  const entriesByGroup: Record<string, ManifestEntry[]> = {}

  let currentGroup = ""

  for (const line of content.split("\n")) {
    const stripped = line.trim()

    if (!stripped || stripped.startsWith(">")) {
      continue
    }

    if (stripped.startsWith("## ")) {
      let header = stripped.slice(3).trim()
      if (header.includes("(")) {
        header = header.split("(")[0].trim()
      }
      currentGroup = header
      continue
    }

    if (stripped.startsWith("#") && !stripped.startsWith("-")) {
      continue
    }

    if (!stripped.startsWith("-")) {
      continue
    }

    let contentPart = stripped.slice(1).trim()

    const manualTags: string[] = []
    if (contentPart.includes("{") && contentPart.includes("}")) {
      const tagStart = contentPart.indexOf("{")
      const tagEnd = contentPart.indexOf("}")
      const tagStr = contentPart.slice(tagStart + 1, tagEnd)
      manualTags.push(
        ...tagStr
          .replace("/", ",")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      )
      contentPart =
        contentPart.slice(0, tagStart).trim() +
        contentPart.slice(tagEnd + 1).trim()
    }

    let branch = "master"
    if (contentPart.includes("[") && contentPart.includes("]")) {
      const brStart = contentPart.indexOf("[")
      const brEnd = contentPart.indexOf("]")
      branch = contentPart.slice(brStart + 1, brEnd).trim()
      contentPart =
        contentPart.slice(0, brStart).trim() +
        contentPart.slice(brEnd + 1).trim()
    }

    let gitUrl = ""
    const urlMatch = contentPart.match(/(https?:\/\/\S+|git@\S+)/)
    if (urlMatch) {
      gitUrl = urlMatch[1]
      contentPart =
        contentPart.slice(0, urlMatch.index!).trim() +
        contentPart.slice(urlMatch.index! + urlMatch[0].length).trim()
    }

    const name = contentPart.trim()
    if (!name || !currentGroup) {
      continue
    }

    const entry: ManifestEntry = {
      name,
      git_url: gitUrl,
      branch,
      manual_tags: manualTags,
      group: currentGroup,
    }

    if (!entriesByGroup[currentGroup]) {
      entriesByGroup[currentGroup] = []
    }
    entriesByGroup[currentGroup].push(entry)
  }

  return entriesByGroup
}

export function findManifestEntry(
  manifest: Record<string, ManifestEntry[]>,
  projectName: string
): ManifestEntry | undefined {
  for (const entries of Object.values(manifest)) {
    for (const entry of entries) {
      if (entry.name === projectName) {
        return entry
      }
    }
  }
  return undefined
}

export function findManifestGroup(
  manifest: Record<string, ManifestEntry[]>,
  projectName: string
): string | undefined {
  for (const [group, entries] of Object.entries(manifest)) {
    for (const entry of entries) {
      if (entry.name === projectName) {
        return group
      }
    }
  }
  return undefined
}

export function writeManifest(
  entries: Record<string, ManifestEntry[]>,
  groupLabels?: Record<string, string>
): string {
  const lines: string[] = []

  for (const [groupName, groupEntries] of Object.entries(entries)) {
    const label = groupLabels?.[groupName] ?? groupName
    lines.push(`## ${groupName} (${label})`)
    lines.push("")
    for (const entry of groupEntries) {
      let line = `- ${entry.name}`
      if (entry.branch) {
        line += ` [${entry.branch}]`
      }
      if (entry.manual_tags.length > 0) {
        line += ` {${entry.manual_tags.join("/")}}`
      }
      if (entry.git_url) {
        line += ` ${entry.git_url}`
      }
      lines.push(line)
    }
    lines.push("")
  }

  return lines.join("\n")
}