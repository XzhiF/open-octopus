import fs from "fs"
import path from "path"
import os from "os"
import crypto from "crypto"
import type { ParsedRule } from "@octopus/shared"

/**
 * Get the knowledge directory for a given org/scope.
 * global → ~/.octopus/knowledge/
 * org → ~/.octopus/{org}/knowledge/
 */
export function getKnowledgeDir(org?: string): string {
  const base = path.join(os.homedir(), ".octopus")
  const dir = org ? path.join(base, org, "knowledge") : path.join(base, "knowledge")
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
 * Read user_preference.md for a given scope.
 * global → ~/.octopus/knowledge/user_preference.md
 * org → ~/.octopus/{org}/knowledge/user_preference.md
 */
export function readUserPreference(org?: string): string {
  const dir = getKnowledgeDir(org)
  return readKnowledgeFile(path.join(dir, "user_preference.md"))
}

/**
 * Write user_preference.md for a given scope.
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
  const rand = crypto.randomBytes(3).toString("base64url").slice(0, 4)
  return `${target}-${date}-${rand}`
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
