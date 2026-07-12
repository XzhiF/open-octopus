import * as fs from "fs"
import * as path from "path"
import * as os from "os"

/**
 * Shared utility for loading agent file content.
 * Extracted from AgentExecutor to be reusable by swarm strategies.
 */

/**
 * Parse YAML frontmatter from agent .md files.
 * Extracts flat key-value pairs (tools, model, maxTurns, etc.)
 * Returns empty object if no valid frontmatter found.
 */
export function parseFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {}
  const endIndex = content.indexOf("---", 3)
  if (endIndex === -1) return {}

  const fmBlock = content.slice(3, endIndex).trim()
  const result: Record<string, unknown> = {}

  for (const line of fmBlock.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const colonIdx = trimmed.indexOf(":")
    if (colonIdx === -1) continue

    const key = trimmed.slice(0, colonIdx).trim()
    const rawVal = trimmed.slice(colonIdx + 1).trim()

    // Remove surrounding quotes
    const val = (rawVal.startsWith('"') && rawVal.endsWith('"')) ||
                (rawVal.startsWith("'") && rawVal.endsWith("'"))
      ? rawVal.slice(1, -1)
      : rawVal

    // Type coercion for known fields
    if (key === "tools" || key === "disallowedTools" || key === "skills") {
      if (val.startsWith("[")) {
        try {
          const parsed = JSON.parse(val)
          if (Array.isArray(parsed)) {
            result[key] = parsed.map((s: unknown) => String(s).trim()).filter(Boolean)
          }
        } catch {
          result[key] = val.replace(/[\[\]"']/g, "").split(",").map((s: string) => s.trim()).filter(Boolean)
        }
      } else {
        result[key] = val.split(",").map((s: string) => s.trim()).filter(Boolean)
      }
    } else if (key === "maxTurns") {
      const n = parseInt(val, 10)
      if (!isNaN(n)) result[key] = n
    } else if (key === "background") {
      result[key] = val === "true"
    } else if (val) {
      result[key] = val
    }
  }

  return result
}

/**
 * Strip YAML frontmatter from markdown content.
 */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content
  const endIndex = content.indexOf("---", 3)
  if (endIndex === -1) return content
  return content.slice(endIndex + 3).trimStart()
}

/**
 * Load an agent file, resolve its path, parse frontmatter, and return body.
 *
 * @param agentFile - Path to agent .md file (supports ~ and relative paths)
 * @param cwd - Working directory for relative path resolution
 * @returns { body, metadata } or null if file not found
 */
export function loadAgentFile(
  agentFile: string,
  cwd: string,
): { body: string; metadata: Record<string, unknown> } | null {
  try {
    const expanded = agentFile.startsWith("~")
      ? path.join(os.homedir(), agentFile.slice(1))
      : agentFile
    const absolutePath = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(cwd, expanded)

    if (!fs.existsSync(absolutePath)) return null

    const rawContent = fs.readFileSync(absolutePath, "utf-8")
    const metadata = parseFrontmatter(rawContent)
    const body = stripFrontmatter(rawContent)

    return { body, metadata }
  } catch {
    return null
  }
}

/**
 * Combine agent file body with expert prompt.
 * If both exist: body + separator + prompt
 * If only body: body
 * If only prompt: prompt
 */
export function combineAgentPrompt(
  agentFile: string | undefined,
  prompt: string | undefined,
  cwd: string,
): string | undefined {
  if (!agentFile && !prompt) return undefined

  if (agentFile) {
    const loaded = loadAgentFile(agentFile, cwd)
    if (loaded) {
      return prompt
        ? `${loaded.body}\n\n---\n\n${prompt}`
        : loaded.body
    }
  }

  return prompt
}
