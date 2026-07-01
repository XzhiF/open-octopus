import fs from "fs"
import path from "path"
import os from "os"
import crypto from "crypto"
import type { ParsedRule } from "@octopus/shared"

/**
 * Get the knowledge directory for a given org/scope.
 *
 * Path layout (matches the rest of the ~/.octopus hierarchy, where all
 * per-org data lives under `orgs/<org>/...`):
 *
 *   global  →  ~/.octopus/knowledge/
 *   org     →  ~/.octopus/orgs/<org>/knowledge/
 *
 * Historical note: the original PR wrote org-level data to
 * `~/.octopus/<org>/knowledge/` (missing the `orgs/` segment). That path
 * is still consulted by {@link readUserPreference} for backward
 * compatibility, but all new writes go to the canonical location.
 */
export function getKnowledgeDir(org?: string): string {
  // Test hook — bypass the filesystem layout entirely.
  if (process.env.OCTOPUS_KNOWLEDGE_DIR) return process.env.OCTOPUS_KNOWLEDGE_DIR
  const base = path.join(os.homedir(), ".octopus")
  const dir = org
    ? path.join(base, "orgs", org, "knowledge")
    : path.join(base, "knowledge")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Get the project knowledge subdirectory: <knowledgeDir>/projects/
 */
export function getProjectKnowledgeDir(org: string): string {
  const dir = path.join(getKnowledgeDir(org), "projects")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Get the workflow knowledge subdirectory: <knowledgeDir>/workflows/
 */
export function getWorkflowKnowledgeDir(org: string): string {
  const dir = path.join(getKnowledgeDir(org), "workflows")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Read a knowledge file. Returns empty string if not found.
 */
export function readKnowledgeFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8")
  } catch {
    return ""
  }
}

/**
 * Write content to a knowledge file (full overwrite).
 */
export function writeKnowledgeFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, content, "utf-8")
}

/**
 * Append a rule to a knowledge file in standard format.
 */
export function appendToKnowledgeFile(filePath: string, ruleText: string, ruleId: string, source: string): void {
  const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const entry = `- ${ruleText}\n<!-- id:${ruleId} | ${date} | ${source} -->\n`
  const existing = readKnowledgeFile(filePath)
  writeKnowledgeFile(filePath, existing + (existing && !existing.endsWith("\n") ? "\n" : "") + entry)
}

/**
 * List all .md knowledge files in a directory (excluding index.md and user_preference.md).
 */
export function listKnowledgeFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(".md") && f !== "index.md" && f !== "user_preference.md")
  } catch {
    return []
  }
}

/**
 * Read user_preference.md for a given scope (single file, no merge).
 * Used by API routes to read/edit preferences per scope in the Dashboard.
 *
 * Path resolution:
 *   - org provided  → ~/.octopus/orgs/<org>/knowledge/user_preference.md
 *   - no org        → ~/.octopus/knowledge/user_preference.md
 */
export function readUserPreference(org?: string): string {
  // Test hook — use the override dir verbatim.
  if (process.env.OCTOPUS_KNOWLEDGE_DIR) {
    return readKnowledgeFile(path.join(process.env.OCTOPUS_KNOWLEDGE_DIR, "user_preference.md"))
  }

  const dir = getKnowledgeDir(org)
  return readKnowledgeFile(path.join(dir, "user_preference.md"))
}

/**
 * Get effective user preference by merging global + org preferences.
 *
 * Merge strategy:
 *   - Both global and org are always included (not first-match-wins)
 *   - Org preference takes priority on conflicts (clearly marked in output)
 *   - Format uses markdown headers so LLM understands the priority
 *
 * Used by precompute hook to populate __user_preference_text for agent injection.
 */
export function getEffectiveUserPreference(org: string): string {
  // Test hook — single file, no merge.
  if (process.env.OCTOPUS_KNOWLEDGE_DIR) {
    return readKnowledgeFile(path.join(process.env.OCTOPUS_KNOWLEDGE_DIR, "user_preference.md"))
  }

  const globalDir = getKnowledgeDir()      // ~/.octopus/knowledge/
  const orgDir = getKnowledgeDir(org)      // ~/.octopus/orgs/<org>/knowledge/

  const globalPref = readKnowledgeFile(path.join(globalDir, "user_preference.md"))
  const orgPref = readKnowledgeFile(path.join(orgDir, "user_preference.md"))

  // Merge: global first, then org appended with explicit priority marker.
  // The "overrides global on conflicts" instruction tells the LLM how to handle conflicts.
  const parts: string[] = []

  if (globalPref.trim()) {
    parts.push("### Global Preferences\n" + globalPref.trim())
  }

  if (orgPref.trim()) {
    parts.push("### Org Preferences (overrides global on conflicts)\n" + orgPref.trim())
  }

  return parts.join("\n\n")
}

/**
 * Write user_preference.md for a given scope. Always writes to the
 * canonical location returned by {@link getKnowledgeDir} — legacy
 * locations are read-only for backward compatibility.
 */
export function writeUserPreference(org: string | undefined, content: string): void {
  const dir = getKnowledgeDir(org)
  writeKnowledgeFile(path.join(dir, "user_preference.md"), content)
}

/**
 * Generate a unique rule ID: {target}-{YYYYMMDD}-{random4}
 * Uses crypto.randomBytes (stdlib, no new dependency).
 */
export function generateRuleId(target: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const rand = crypto.randomBytes(2).toString("hex").slice(0, 4)
  // Strip subdirectory prefix: "projects/octopus" → "octopus"
  const baseName = target.replace(/^(projects|workflows)\//, "")
  return `${baseName}-${date}-${rand}`
}

/**
 * Parse a knowledge file into structured rules.
 * Matches: `- rule text\n<!-- id:xxx | YYYY-MM-DD | source -->`
 */
export function parseKnowledgeFile(filePath: string): ParsedRule[] {
  const content = readKnowledgeFile(filePath)
  if (!content) return []

  const rules: ParsedRule[] = []
  const lines = content.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const metaMatch = lines[i].match(/<!-- id:(\S+) \| (\S+) \| (\S+) -->/)
    if (metaMatch) {
      // The rule text is on the preceding line (should start with "- ")
      const textLine = i > 0 ? lines[i - 1] : ""
      const text = textLine.replace(/^-\s*/, "").trim()
      if (text) {
        rules.push({
          id: metaMatch[1],
          date: metaMatch[2],
          source: metaMatch[3],
          text,
        })
      } else {
        console.warn(`[knowledge] Skipping rule with empty text near line ${i + 1} in ${filePath}`)
      }
    }
  }

  return rules
}

/**
 * Mark a rule as retired in the knowledge file by adding <!-- retired --> annotation.
 */
export function markRuleRetired(filePath: string, ruleId: string): void {
  const content = readKnowledgeFile(filePath)
  if (!content) return
  const marker = `<!-- id:${ruleId} |`
  const retiredMarker = `<!-- retired -->`
  // Add retired marker after the rule's metadata comment
  const updated = content.replace(
    new RegExp(`(${escapeRegex(marker)}[^\\n]*-->)(?!\\s*${escapeRegex(retiredMarker)})`),
    `$1\n${retiredMarker}`,
  )
  if (updated !== content) writeKnowledgeFile(filePath, updated)
}

/**
 * Remove retired annotation from a rule in the knowledge file.
 */
export function unmarkRuleRetired(filePath: string, ruleId: string): void {
  const content = readKnowledgeFile(filePath)
  if (!content) return
  const marker = `<!-- id:${ruleId} |`
  // Find the retired marker after the rule's metadata and remove it
  const lines = content.split("\n")
  const result: string[] = []
  let skipNext = false
  for (let i = 0; i < lines.length; i++) {
    if (skipNext && lines[i].trim() === "<!-- retired -->") {
      skipNext = false
      continue
    }
    skipNext = lines[i].includes(marker)
    result.push(lines[i])
  }
  writeKnowledgeFile(filePath, result.join("\n"))
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Rebuild the index.md file for an org's knowledge directory.
 *
 * Scans all knowledge files, parses rules, and writes a summary index.md
 * with statistics and a table of all rules.
 */
export function rebuildIndex(
  org: string,
  knowledgeRuleDAO: { listActive: () => Array<{ rule_id: string; file_name: string; text: string; scope: string; source: string; status: string }> },
): { ruleCount: number; fileCount: number } {
  const knowledgeDir = getKnowledgeDir(org)
  const files = listKnowledgeFiles(knowledgeDir)

  const allRules: Array<{ id: string; file: string; text: string; source: string; date: string; status: string }> = []

  for (const file of files) {
    const filePath = path.join(knowledgeDir, file)
    const rules = parseKnowledgeFile(filePath)
    for (const rule of rules) {
      allRules.push({
        id: rule.id,
        file,
        text: rule.text,
        source: rule.source,
        date: rule.date,
        status: "active",
      })
    }
  }

  // Build index content
  const lines: string[] = [
    `# Knowledge Index — ${org}`,
    "",
    `## Statistics`,
    `- Total rules: ${allRules.length}`,
    `- Total files: ${files.length}`,
    `- Last updated: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "## Rules",
    "",
  ]

  for (const rule of allRules) {
    lines.push(`| ${rule.id} | ${rule.file} | ${rule.text.slice(0, 60)} | ${rule.source} | ${rule.date} | ${rule.status} |`)
  }

  if (allRules.length > 0) {
    lines.splice(10, 0, "| ID | File | Summary | Source | Date | Status |", "|---|---|---|---|---|---|")
  }

  const indexPath = path.join(knowledgeDir, "index.md")
  writeKnowledgeFile(indexPath, lines.join("\n") + "\n")

  return { ruleCount: allRules.length, fileCount: files.length }
}

/**
 * Get file info with rule counts for listing.
 */
export function getKnowledgeFileInfo(filePath: string): {
  name: string
  ruleCount: number
  retiredCount: number
  lineCount: number
} {
  const content = readKnowledgeFile(filePath)
  const rules = parseKnowledgeFile(filePath)
  const retiredCount = (content.match(/<!-- retired -->/g) || []).length
  const lineCount = content ? content.split("\n").length : 0

  return {
    name: path.basename(filePath),
    ruleCount: rules.length,
    retiredCount,
    lineCount,
  }
}
