import fs from "fs"
import path from "path"
import crypto from "crypto"
import type { ParsedRule } from "@octopus/shared"
import { resolveKnowledgeDir } from "./global-paths"

/**
 * Get the knowledge directory for a given org/scope.
 *
 * **解析单源 = global-paths.resolveKnowledgeDir**（code-review S3；本函数纯委托，
 * 布局公式/env 钩子不再在此重复出现）。口径：
 *
 *   env `OCTOPUS_KNOWLEDGE_DIR` 拍平（无视 org——测试钩子本意）
 *   org     →  ~/.octopus/orgs/<org>/knowledge/   （$OCTOPUS_HOME 窗生效）
 *   global  →  ~/.octopus/knowledge/
 *
 * 票09 起纯解析**零 mkdir**——旧知识目录已归档删除（_archive/org-knowledge-*），
 * 任何只读调用都不得重建已删目录（归档先于删除纪律的运行时护栏）。
 * 写路径自保：writeKnowledgeFile/appendToKnowledgeFile 落盘前自建目录。
 */
export function getKnowledgeDir(org?: string): string {
  return resolveKnowledgeDir(org)
}

/**
 * Resolve the project knowledge subdirectory: <knowledgeDir>/projects/
 * 票09：纯解析零 mkdir（写路径的目录创建在 writeKnowledgeFile 内自保）。
 */
export function getProjectKnowledgeDir(org: string): string {
  return path.join(getKnowledgeDir(org), "projects")
}

/**
 * Resolve the workflow knowledge subdirectory: <knowledgeDir>/workflows/
 * 票09：纯解析零 mkdir，同上。
 */
export function getWorkflowKnowledgeDir(org: string): string {
  return path.join(getKnowledgeDir(org), "workflows")
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
 * Generate a unique rule ID: {target}-{YYYYMMDD}-{random4}
 * Uses crypto.randomBytes (stdlib, no new dependency).
 */
export function generateRuleId(target: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const rand = crypto.randomBytes(3).toString("base64url").slice(0, 4)
  // Strip subdirectory prefix: "projects/octopus" → "octopus"
  const baseName = target.replace(/^(projects|workflows)\//, "")
  return `${baseName}-${date}-${rand}`
}

/**
 * Parse a knowledge file into structured rules.
 * Supports two formats:
 *   1. Inline:  `- rule text <!-- id:xxx | date | source -->`
 *   2. Two-line: `- rule text\n<!-- id:xxx | date | source -->`
 */
export function parseKnowledgeFile(filePath: string): ParsedRule[] {
  const content = readKnowledgeFile(filePath)
  if (!content) return []

  const rules: ParsedRule[] = []
  const lines = content.split("\n")
  const metaRegex = /<!-- id:(\S+) \| (\S+) \| (\S+) -->/

  for (let i = 0; i < lines.length; i++) {
    const metaMatch = lines[i].match(metaRegex)
    if (!metaMatch) continue

    // Case 1: inline — rule text and metadata on the same line
    const inlineText = lines[i].replace(metaRegex, "").replace(/^-\s*/, "").trim()
    if (inlineText) {
      rules.push({
        id: metaMatch[1],
        date: metaMatch[2],
        source: metaMatch[3],
        text: inlineText,
      })
      continue
    }

    // Case 2: two-line — rule text on the preceding line
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

  return rules
}

/**
 * Rebuild the index.md file for an org's knowledge directory.
 *
 * Scans all knowledge files in projects/ and workflows/ subdirectories,
 * parses rules, and writes a summary index.md with statistics and a
 * table of all rules.
 */
export function rebuildIndex(org: string): { ruleCount: number; fileCount: number } {
  const knowledgeDir = getKnowledgeDir(org)

  // Scan projects/ and workflows/ subdirectories
  const readSubDir = (subDir: string) => {
    const dir = path.join(knowledgeDir, subDir)
    try {
      return fs.readdirSync(dir)
        .filter(f => f.endsWith(".md"))
        .map(f => ({ file: `${subDir}/${f}`, fullPath: path.join(dir, f) }))
    } catch {
      return []
    }
  }

  const files = [
    ...readSubDir("projects"),
    ...readSubDir("workflows"),
  ]

  const allRules: Array<{ id: string; file: string; text: string; source: string; date: string; status: string }> = []

  for (const { file, fullPath } of files) {
    const rules = parseKnowledgeFile(fullPath)
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

// ---------------------------------------------------------------------------
// File-based rule index — replaces KnowledgeRuleDAO
// ---------------------------------------------------------------------------

export interface FileRule {
  rule_id: string
  file_name: string
  text: string
  scope: string
  source: string
  date: string
  retired: boolean
}

/**
 * Scan all knowledge files (projects/ + workflows/) and return all rules
 * (both active and retired). Replaces knowledgeRuleDAO.listActive() + getById().
 */
export function listAllRules(org: string): FileRule[] {
  const knowledgeDir = getKnowledgeDir(org)
  const rules: FileRule[] = []

  const scanSubDir = (subDir: string, scope: string) => {
    const dir = path.join(knowledgeDir, subDir)
    let files: string[]
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith(".md"))
    } catch {
      return
    }
    for (const file of files) {
      const fullPath = path.join(dir, file)
      const content = readKnowledgeFile(fullPath)
      const parsed = parseKnowledgeFile(fullPath)
      const fileName = `${subDir}/${file}`

      // Detect retired rules from <!-- retired --> markers
      const lines = content.split("\n")
      const retiredIds = new Set<string>()
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === "<!-- retired -->") {
          // Find the nearest preceding rule ID
          for (let j = i - 1; j >= 0; j--) {
            const idMatch = lines[j].match(/<!-- id:(\S+) \|/)
            if (idMatch) {
              retiredIds.add(idMatch[1]!)
              break
            }
          }
        }
      }

      for (const rule of parsed) {
        rules.push({
          rule_id: rule.id,
          file_name: fileName,
          text: rule.text,
          scope,
          source: rule.source,
          date: rule.date,
          retired: retiredIds.has(rule.id),
        })
      }
    }
  }

  scanSubDir("projects", "project")
  scanSubDir("workflows", "workflow")

  return rules
}

/**
 * List only active (non-retired) rules. Replaces knowledgeRuleDAO.listActive().
 */
export function listAllActiveRules(org: string): FileRule[] {
  return listAllRules(org).filter(r => !r.retired)
}
