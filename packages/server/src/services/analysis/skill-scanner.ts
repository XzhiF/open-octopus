import fs from 'fs'
import path from 'path'

// ── Types ──────────────────────────────────────────────────────────

export interface OutdatedRef {
  /** The original markdown link text, e.g. `[docs](./missing.md)` */
  raw: string
  /** The link target path that could not be resolved */
  linkPath: string
  /** Resolved absolute path that was checked */
  resolvedPath: string
  /** Why it is considered outdated */
  reason: 'file_not_found' | 'path_traversal_blocked'
}

export interface FixSuggestion {
  /** Which outdated ref this suggestion targets */
  raw: string
  /** Human-readable suggestion */
  suggestion: string
}

export interface ScanResult {
  outdatedRefs: OutdatedRef[]
  fixSuggestions: FixSuggestion[]
}

// ── SkillScanner ───────────────────────────────────────────────────

/**
 * Scans skill `.md` files for broken links and outdated references.
 * Extracts `[text](path)` links and verifies that the target file exists.
 */
export class SkillScanner {
  private projectRoot: string

  /** @param projectRoot Absolute path to the project root — links outside this boundary are rejected. */
  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot)
  }

  /**
   * Scan a single skill markdown file for broken references.
   * @param content  The markdown source text
   * @param skillMdPath  Absolute path to the `.md` file being scanned
   */
  scanSkillMd(content: string, skillMdPath: string): ScanResult {
    const outdatedRefs: OutdatedRef[] = []
    const fixSuggestions: FixSuggestion[] = []
    const skillDir = path.dirname(path.resolve(skillMdPath))

    // Match markdown links: [text](path) — skip URLs (http/https/mailto/#anchor-only)
    const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g
    let m: RegExpExecArray | null
    while ((m = linkRe.exec(content)) !== null) {
      const linkText = m[1]
      const linkPath = m[2].split('#')[0].split('?')[0] // strip anchors / query
      if (!linkPath) continue
      if (/^(https?|mailto|ftp):/i.test(linkPath)) continue

      const raw = m[0]

      // Resolve: relative paths are relative to the skill .md directory
      const resolved = path.isAbsolute(linkPath)
        ? path.resolve(linkPath)
        : path.resolve(skillDir, linkPath)

      // Path traversal protection
      if (!resolved.startsWith(this.projectRoot)) {
        outdatedRefs.push({
          raw,
          linkPath,
          resolvedPath: resolved,
          reason: 'path_traversal_blocked',
        })
        fixSuggestions.push({
          raw,
          suggestion: `Remove or rewrite link "${linkText}" — path "${linkPath}" escapes project root.`,
        })
        continue
      }

      if (!fs.existsSync(resolved)) {
        outdatedRefs.push({
          raw,
          linkPath,
          resolvedPath: resolved,
          reason: 'file_not_found',
        })
        fixSuggestions.push({
          raw,
          suggestion: `Update link "${linkText}" — file "${linkPath}" does not exist. Consider removing or pointing to the correct path.`,
        })
      }
    }

    return { outdatedRefs, fixSuggestions }
  }
}
