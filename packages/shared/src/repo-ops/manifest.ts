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

export interface ManifestJsonData {
  groups: Record<string, ManifestEntry[]>
}

export function parseManifestJson(content: string): Record<string, ManifestEntry[]> {
  if (!content || !content.trim()) {
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid manifest JSON: ${msg}`)
  }

  if (parsed === null || typeof parsed !== "object") {
    return {}
  }

  // Support both { groups: {...} } and bare {...} format
  const data = parsed as Record<string, unknown>
  const groups = data.groups ?? data

  if (groups === null || typeof groups !== "object" || Array.isArray(groups)) {
    return {}
  }

  const result: Record<string, ManifestEntry[]> = {}

  for (const [groupName, entries] of Object.entries(groups as Record<string, unknown>)) {
    if (!Array.isArray(entries)) {
      continue
    }

    const validEntries: ManifestEntry[] = []
    for (const raw of entries) {
      if (typeof raw !== "object" || raw === null) {
        continue
      }
      const obj = raw as Record<string, unknown>
      const name = typeof obj.name === "string" ? obj.name : ""
      if (!name) {
        throw new Error(`Manifest entry missing required field 'name' in group '${groupName}'`)
      }

      validEntries.push({
        name,
        git_url: typeof obj.git_url === "string" ? obj.git_url : "",
        branch: typeof obj.branch === "string" ? obj.branch : "master",
        manual_tags: Array.isArray(obj.manual_tags)
          ? obj.manual_tags.filter((t): t is string => typeof t === "string")
          : [],
        group: typeof obj.group === "string" ? obj.group : groupName,
      })
    }

    result[groupName] = validEntries
  }

  return result
}

export function writeManifestJson(entries: Record<string, ManifestEntry[]>): string {
  return JSON.stringify({ groups: entries }, null, 2) + "\n"
}