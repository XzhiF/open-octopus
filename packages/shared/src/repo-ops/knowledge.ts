import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"

export interface KnowledgeInfo {
  repowiki_exists: boolean
  repowiki_stale: boolean
  is_cloned: boolean

  formatLine(): string
}

export function createKnowledgeInfo(
  opts: Partial<KnowledgeInfo> = {}
): KnowledgeInfo {
  return {
    repowiki_exists: opts.repowiki_exists ?? false,
    repowiki_stale: opts.repowiki_stale ?? false,
    is_cloned: opts.is_cloned ?? false,

    formatLine(): string {
      if (!this.is_cloned) return "index-only"

      if (this.repowiki_exists && this.repowiki_stale) {
        return "repowiki:yes(stale)"
      }
      if (this.repowiki_exists) {
        return "repowiki:yes"
      }
      return "repowiki:no"
    },
  }
}

export function detectKnowledge(localPath: string): KnowledgeInfo {
  const info = createKnowledgeInfo()

  if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
    return info
  }

  info.is_cloned = true

  const contentDir = join(localPath, ".qoder", "repowiki", "zh", "content")
  if (existsSync(contentDir) && statSync(contentDir).isDirectory()) {
    try {
      const files = readdirSync(contentDir)
      const hasMd = files.some(
        (f: string) =>
          f.endsWith(".md") ||
          statSync(join(contentDir, f)).isDirectory()
      )
      if (hasMd) {
        info.repowiki_exists = true
        try {
          const wikiMtime = statSync(contentDir).mtimeMs
          const lastCommitTime = getLastCommitTime(localPath)
          if (
            lastCommitTime !== null &&
            lastCommitTime - wikiMtime > 7 * 86400 * 1000
          ) {
            info.repowiki_stale = true
          }
        } catch {
          // stale detection is informational, not critical
        }
      }
    } catch {
      // directory read failure — skip
    }
  }

  return info
}

export function getLastCommitTime(
  localPath: string
): number | null {
  // This function requires git subprocess, which belongs to the CLI package.
  // In the shared package, we return null — the CLI package can override this.
  return null
}

export function extractRepowikiDesc(localPath: string): string {
  const contentDir = join(localPath, ".qoder", "repowiki", "zh", "content")
  if (!existsSync(contentDir) || !statSync(contentDir).isDirectory()) {
    return ""
  }

  const overviewFiles: string[] = []

  const flatFile = join(contentDir, "项目概述.md")
  if (existsSync(flatFile)) {
    overviewFiles.push(flatFile)
  }

  const nestedDir = join(contentDir, "项目概述")
  if (existsSync(nestedDir) && statSync(nestedDir).isDirectory()) {
    for (const name of ["项目介绍.md", "项目概述.md"]) {
      const f = join(nestedDir, name)
      if (existsSync(f)) {
        overviewFiles.push(f)
      }
    }
  }

  for (const fpath of overviewFiles) {
    try {
      const text = readFileSync(fpath, "utf-8")
      const lines = text.split("\n")
      let inSection = false
      let sectionLines: string[] = []

      for (const line of lines) {
        if (/^## (简介|引言|项目简介)/.test(line)) {
          inSection = true
          sectionLines = []
          continue
        }
        if (inSection && /^## /.test(line)) {
          break
        }
        if (inSection) {
          sectionLines.push(line)
        }
      }

      if (!inSection) continue

      for (const line of sectionLines) {
        const stripped = line.trim()
        if (!stripped) continue
        if (stripped.startsWith("<cite") || stripped.startsWith("<")) continue
        if (
          stripped.startsWith("- ") ||
          stripped.startsWith("* ") ||
          stripped.startsWith("+ ")
        )
          continue
        if (stripped.startsWith("|") || stripped.startsWith("```")) continue
        if (
          stripped.startsWith("1.") ||
          stripped.startsWith("2.") ||
          stripped.startsWith("3.")
        )
          continue

        const desc = stripped.replace(/\*{2}/g, "").replace(/_{2}/g, "")
        if (desc.length >= 12) return desc
      }
    } catch {
      continue
    }
  }

  return ""
}

const AGENT_MD_DESC_KEYWORDS = [
  "项目简介",
  "项目概述",
  "项目介绍",
  "简介",
  "概述",
  "项目背景",
  "project overview",
  "project intro",
  "project description",
  "project summary",
  "architecture overview",
  "overview",
  "about",
]

export function extractAgentMdDesc(localPath: string): string {
  let mdPath: string | null = null
  for (const candidate of ["CLAUDE.md", "AGENT.md"]) {
    const full = join(localPath, candidate)
    if (existsSync(full)) {
      mdPath = full
      break
    }
  }

  if (!mdPath) return ""

  try {
    const text = readFileSync(mdPath, "utf-8")
    return extractDescFromMdContent(text)
  } catch {
    return ""
  }
}

export function extractDescFromMdContent(text: string): string {
  const headingRegex = /^## (.+?)\s*\n/gm
  let match: RegExpExecArray | null

  while ((match = headingRegex.exec(text)) !== null) {
    const heading = match[1].trim()
    const headingLower = heading.toLowerCase()

    const matchedKeyword = AGENT_MD_DESC_KEYWORDS.some(
      (kw) => headingLower.includes(kw.toLowerCase())
    )
    if (!matchedKeyword) continue

    const sectionStart = match.index + match[0].length
    const sectionText = text.slice(sectionStart)
    let inCodeBlock = false

    for (const line of sectionText.split("\n")) {
      const stripped = line.trim()
      if (stripped.startsWith("```")) {
        inCodeBlock = !inCodeBlock
        continue
      }
      if (inCodeBlock) continue
      if (!stripped) continue
      if (stripped.startsWith("#")) break
      if (stripped.startsWith("|")) continue
      if (
        stripped.startsWith("- ") ||
        stripped.startsWith("* ") ||
        stripped.startsWith("+ ")
      )
        continue
      if (stripped.startsWith(">")) continue

      const desc = stripped.replace(/\*{2}/g, "").replace(/_{2}/g, "")
      if (desc.length >= 12) return desc.slice(0, 200)
    }
  }

  return ""
}

export function findAgentMd(localPath: string): string | null {
  for (const candidate of ["CLAUDE.md", "AGENT.md"]) {
    const full = join(localPath, candidate)
    if (existsSync(full)) return full
  }
  return null
}