import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { SkillScanner } from '../services/analysis/skill-scanner'

describe('SkillScanner', () => {
  let tmpDir: string
  let scanner: SkillScanner

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-scanner-test-'))
    scanner = new SkillScanner(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Link extraction ──────────────────────────────────────────────

  it('detects no issues when all links are valid', () => {
    const targetFile = path.join(tmpDir, 'target.md')
    fs.writeFileSync(targetFile, 'hello')
    const skillFile = path.join(tmpDir, 'SKILL.md')

    const result = scanner.scanSkillMd(
      `See [target](target.md) for details.`,
      skillFile,
    )
    expect(result.outdatedRefs).toHaveLength(0)
    expect(result.fixSuggestions).toHaveLength(0)
  })

  it('detects broken links to non-existent files', () => {
    const skillFile = path.join(tmpDir, 'SKILL.md')
    const result = scanner.scanSkillMd(
      `See [missing](./does-not-exist.md) for details.`,
      skillFile,
    )
    expect(result.outdatedRefs).toHaveLength(1)
    expect(result.outdatedRefs[0].reason).toBe('file_not_found')
    expect(result.outdatedRefs[0].linkPath).toBe('./does-not-exist.md')
    expect(result.fixSuggestions).toHaveLength(1)
  })

  it('skips HTTP/HTTPS/mailto URLs', () => {
    const skillFile = path.join(tmpDir, 'SKILL.md')
    const result = scanner.scanSkillMd(
      `[Google](https://google.com) [Email](mailto:a@b.com)`,
      skillFile,
    )
    expect(result.outdatedRefs).toHaveLength(0)
  })

  it('skips anchor-only links', () => {
    const skillFile = path.join(tmpDir, 'SKILL.md')
    const result = scanner.scanSkillMd(
      `[Section](#section-1)`,
      skillFile,
    )
    expect(result.outdatedRefs).toHaveLength(0)
  })

  // ── Path traversal protection ────────────────────────────────────

  it('blocks path traversal outside project root', () => {
    const skillFile = path.join(tmpDir, 'sub', 'SKILL.md')
    fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true })

    const result = scanner.scanSkillMd(
      `[escape](../../../../etc/passwd)`,
      skillFile,
    )
    expect(result.outdatedRefs).toHaveLength(1)
    expect(result.outdatedRefs[0].reason).toBe('path_traversal_blocked')
  })

  it('allows paths within project root', () => {
    const subDir = path.join(tmpDir, 'skills')
    fs.mkdirSync(subDir, { recursive: true })
    const targetFile = path.join(tmpDir, 'docs', 'guide.md')
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true })
    fs.writeFileSync(targetFile, 'guide content')

    const skillFile = path.join(subDir, 'SKILL.md')
    const result = scanner.scanSkillMd(
      `[guide](../docs/guide.md)`,
      skillFile,
    )
    expect(result.outdatedRefs).toHaveLength(0)
  })

  // ── Multiple links ───────────────────────────────────────────────

  it('handles multiple links in one file', () => {
    const skillFile = path.join(tmpDir, 'SKILL.md')
    fs.writeFileSync(path.join(tmpDir, 'exists.md'), 'x')

    const result = scanner.scanSkillMd(
      `[a](exists.md) [b](missing1.md) [c](missing2.md) [d](https://ok.com)`,
      skillFile,
    )
    expect(result.outdatedRefs).toHaveLength(2)
    expect(result.fixSuggestions).toHaveLength(2)
  })

  // ── Absolute paths ───────────────────────────────────────────────

  it('handles absolute paths within project root', () => {
    const targetFile = path.join(tmpDir, 'abs-target.md')
    fs.writeFileSync(targetFile, 'content')
    const skillFile = path.join(tmpDir, 'SKILL.md')

    const result = scanner.scanSkillMd(
      `[abs](${targetFile})`,
      skillFile,
    )
    expect(result.outdatedRefs).toHaveLength(0)
  })

  it('blocks absolute paths outside project root', () => {
    const skillFile = path.join(tmpDir, 'SKILL.md')
    const result = scanner.scanSkillMd(
      `[etc](/etc/passwd)`,
      skillFile,
    )
    expect(result.outdatedRefs).toHaveLength(1)
    expect(result.outdatedRefs[0].reason).toBe('path_traversal_blocked')
  })
})
