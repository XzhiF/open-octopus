import fs from "fs"
import path from "path"
import { logError, logInfo } from "../../file-logger"

// ── Types ────────────────────────────────────────────────────────────

export interface DiscoveredSkill {
  name: string
  description: string
  content: string
  path: string
  reason: string
  content_outline: string[]
  estimated_reuse: "high" | "medium" | "low"
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_CONTENT_LENGTH = 10000
const MAX_DESCRIPTION_LENGTH = 500

// ── Main ─────────────────────────────────────────────────────────────

/**
 * Auto-discover skills from workspace's .claude/skills/ directory.
 * Reads SKILL.md files and extracts metadata.
 */
export function discoverSkillsFromWorkspace(workspacePath: string): DiscoveredSkill[] {
  const skillsDir = path.join(workspacePath, ".claude", "skills")
  const discovered: DiscoveredSkill[] = []

  if (!fs.existsSync(skillsDir)) {
    logInfo("No .claude/skills directory found", { workspacePath })
    return discovered
  }

  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const skillDir = path.join(skillsDir, entry.name)
      const skillFile = path.join(skillDir, "SKILL.md")

      if (!fs.existsSync(skillFile)) {
        logInfo("No SKILL.md found in skill directory", { skillDir })
        continue
      }

      try {
        const content = fs.readFileSync(skillFile, "utf-8")
        const parsed = parseSkillFile(content, entry.name)

        discovered.push({
          name: entry.name,
          description: parsed.description,
          content: truncate(content, MAX_CONTENT_LENGTH),
          path: skillFile,
          reason: "Auto-discovered from workspace .claude/skills/",
          content_outline: parsed.outline,
          estimated_reuse: estimateReuse(parsed),
        })
      } catch (err) {
        logError("Failed to read skill file", err, { skillFile })
      }
    }
  } catch (err) {
    logError("Failed to read skills directory", err, { skillsDir })
  }

  logInfo(`Discovered ${discovered.length} skills from workspace`, { workspacePath })
  return discovered
}

// ── Helpers ──────────────────────────────────────────────────────────

interface ParsedSkill {
  description: string
  outline: string[]
  hasTriggerWords: boolean
  hasExamples: boolean
}

function parseSkillFile(content: string, name: string): ParsedSkill {
  const lines = content.split("\n")

  // Extract description from first paragraph or first heading
  let description = ""
  let inDescription = false
  const descriptionLines: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()

    // Skip empty lines at start
    if (!description && !trimmed) continue

    // First heading or first non-empty line starts description
    if (trimmed.startsWith("#")) {
      // Use heading as description start
      descriptionLines.push(trimmed.replace(/^#+\s*/, ""))
      inDescription = true
      continue
    }

    if (inDescription) {
      // Stop at next heading or after enough content
      if (trimmed.startsWith("#") || descriptionLines.join(" ").length > MAX_DESCRIPTION_LENGTH) {
        break
      }
      if (trimmed) {
        descriptionLines.push(trimmed)
      } else if (descriptionLines.length > 0) {
        // Empty line ends first paragraph
        break
      }
    } else if (trimmed) {
      descriptionLines.push(trimmed)
      inDescription = true
    }
  }

  description = descriptionLines.join(" ").trim() || `Skill: ${name}`
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    description = description.slice(0, MAX_DESCRIPTION_LENGTH - 3) + "..."
  }

  // Extract outline from headings
  const outline: string[] = []
  for (const line of lines) {
    const match = line.match(/^(#{2,4})\s+(.+)$/)
    if (match) {
      const level = match[1].length
      const text = match[2].trim()
      const indent = "  ".repeat(level - 2)
      outline.push(`${indent}${text}`)
      if (outline.length >= 10) break
    }
  }

  // Check for trigger words and examples
  const hasTriggerWords = /trigger|when to use|use when/i.test(content)
  const hasExamples = /example|e\.g\.|```/i.test(content)

  return { description, outline, hasTriggerWords, hasExamples }
}

function estimateReuse(parsed: ParsedSkill): "high" | "medium" | "low" {
  // Skills with trigger words and examples are more reusable
  if (parsed.hasTriggerWords && parsed.hasExamples) return "high"
  if (parsed.hasTriggerWords || parsed.hasExamples) return "medium"
  return "low"
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen - 3) + "\n... [truncated]"
}

// ── Workflow Discovery ──────────────────────────────────────────────

export interface DiscoveredWorkflow {
  name: string
  description: string
  content: string
  path: string
}

/**
 * Auto-discover workflows from workspace's workflows/ directory.
 * Reads .yaml/.yml files and extracts name + description from YAML frontmatter.
 */
export function discoverWorkflowsFromWorkspace(workspacePath: string): DiscoveredWorkflow[] {
  const workflowsDir = path.join(workspacePath, "workflows")
  const discovered: DiscoveredWorkflow[] = []

  if (!fs.existsSync(workflowsDir)) return discovered

  try {
    const files = fs.readdirSync(workflowsDir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"))

    for (const file of files) {
      try {
        const filePath = path.join(workflowsDir, file)
        const content = fs.readFileSync(filePath, "utf-8")
        const name = file.replace(/\.(yaml|yml)$/, "")

        // Extract name and description from YAML content
        const nameMatch = content.match(/^name:\s*(.+)$/m)
        const descMatch = content.match(/^description:\s*(.+)$/m)

        discovered.push({
          name: nameMatch?.[1]?.trim() || name,
          description: descMatch?.[1]?.trim() || `Workflow: ${name}`,
          content,
          path: filePath,
        })
      } catch {
        // Skip unreadable files
      }
    }
  } catch (err) {
    logError("discoverWorkflowsFromWorkspace failed", err, { workspacePath })
  }

  return discovered
}

// ── Agent Discovery ────────────────────────────────────────────────

export interface DiscoveredAgent {
  name: string
  description: string
  content: string
  path: string
}

/**
 * Auto-discover agents from workspace's .claude/agents/ directory.
 * Reads .md files and extracts name + description from frontmatter.
 */
export function discoverAgentsFromWorkspace(workspacePath: string): DiscoveredAgent[] {
  const agentsDir = path.join(workspacePath, ".claude", "agents")
  const discovered: DiscoveredAgent[] = []

  if (!fs.existsSync(agentsDir)) return discovered

  try {
    const files = fs.readdirSync(agentsDir).filter(f => f.endsWith(".md"))

    for (const file of files) {
      try {
        const filePath = path.join(agentsDir, file)
        const content = fs.readFileSync(filePath, "utf-8")
        const name = file.replace(/\.md$/, "")

        const nameMatch = content.match(/^name:\s*(.+)$/m)
        const descMatch = content.match(/^description:\s*(.+)$/m)

        discovered.push({
          name: nameMatch?.[1]?.trim() || name,
          description: descMatch?.[1]?.trim() || `Agent: ${name}`,
          content,
          path: filePath,
        })
      } catch {
        // Skip unreadable files
      }
    }
  } catch (err) {
    logError("discoverAgentsFromWorkspace failed", err, { workspacePath })
  }

  return discovered
}
