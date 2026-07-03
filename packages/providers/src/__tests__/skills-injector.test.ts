import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { injectSkills } from '../pi/extensions/skills-injector'

describe('SkillsInjector', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'skills-test-'))
    // Create skill directories
    const skillDir = join(tempDir, 'skills', 'test-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# Test Skill\n\nDo testing.')

    const anotherDir = join(tempDir, 'skills', 'another-skill')
    mkdirSync(anotherDir, { recursive: true })
    writeFileSync(join(anotherDir, 'SKILL.md'), '# Another Skill\n\nMore content.')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('injects skill content into prompt under Available Skills section', () => {
    const result = injectSkills('Base prompt', ['test-skill'], tempDir)
    expect(result).toContain('## Available Skills')
    expect(result).toContain('### test-skill')
    expect(result).toContain('# Test Skill')
    expect(result).toContain('Do testing.')
    expect(result).toContain('Base prompt')
  })

  it('injects multiple skills', () => {
    const result = injectSkills('Base', ['test-skill', 'another-skill'], tempDir)
    expect(result).toContain('### test-skill')
    expect(result).toContain('### another-skill')
    expect(result).toContain('# Test Skill')
    expect(result).toContain('# Another Skill')
  })

  it('returns original prompt when skill not found', () => {
    const result = injectSkills('Original prompt', ['nonexistent-skill'], tempDir)
    expect(result).toBe('Original prompt')
  })

  it('returns original prompt when skills array is empty', () => {
    const result = injectSkills('No skills', [], tempDir)
    expect(result).toBe('No skills')
  })

  it('blocks path traversal in skill names', () => {
    const result = injectSkills('Safe prompt', ['../../etc/passwd'], tempDir)
    expect(result).toBe('Safe prompt')
  })

  it('skips skills with absolute path names', () => {
    const result = injectSkills('Safe', ['/etc/passwd'], tempDir)
    expect(result).toBe('Safe')
  })
})
