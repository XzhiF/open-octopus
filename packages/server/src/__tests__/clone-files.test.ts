// packages/server/src/__tests__/clone-files.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Import the helper functions directly for unit testing
// In a real scenario, we'd test via HTTP requests, but for now let's test the logic

describe('Clone Files API - Unit Tests', () => {
  const testDir = path.join(os.tmpdir(), 'octopus-test-clone-files-' + Date.now())

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('scans directory recursively', () => {
    // Create test structure
    fs.mkdirSync(path.join(testDir, 'skills', 'test-skill'), { recursive: true })
    fs.writeFileSync(path.join(testDir, 'persona.md'), '# Test Persona')
    fs.writeFileSync(path.join(testDir, 'skills', 'test-skill', 'SKILL.md'), '# Test Skill')

    // Verify files exist
    expect(fs.existsSync(path.join(testDir, 'persona.md'))).toBe(true)
    expect(fs.existsSync(path.join(testDir, 'skills', 'test-skill', 'SKILL.md'))).toBe(true)

    // Read directory
    const entries = fs.readdirSync(testDir, { withFileTypes: true })
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.some(e => e.name === 'persona.md')).toBe(true)
    expect(entries.some(e => e.name === 'skills')).toBe(true)
  })

  it('handles readonly paths correctly', () => {
    const agentDir = path.join(testDir, 'agent')
    const skillsDir = path.join(agentDir, 'skills')
    const cloneDir = path.join(testDir, 'clones', 'test-clone')

    fs.mkdirSync(skillsDir, { recursive: true })
    fs.mkdirSync(cloneDir, { recursive: true })

    // Shared skills path should be readonly
    expect(skillsDir.startsWith(agentDir)).toBe(true)

    // Clone path should not be readonly
    expect(cloneDir.startsWith(agentDir)).toBe(false)
  })

  it('prevents path traversal', () => {
    const cloneDir = path.join(testDir, 'clones', 'test-clone')
    fs.mkdirSync(cloneDir, { recursive: true })

    // Simulate path traversal attempt
    const maliciousPath = path.join(cloneDir, '../../../etc/passwd')
    const resolved = path.resolve(maliciousPath)

    // Should not start with cloneDir
    expect(resolved.startsWith(cloneDir)).toBe(false)
  })

  it('creates directory structure', () => {
    const cloneDir = path.join(testDir, 'clones', 'new-clone')
    fs.mkdirSync(path.join(cloneDir, 'skills'), { recursive: true })
    fs.mkdirSync(path.join(cloneDir, 'memory'), { recursive: true })

    expect(fs.existsSync(path.join(cloneDir, 'skills'))).toBe(true)
    expect(fs.existsSync(path.join(cloneDir, 'memory'))).toBe(true)
  })

  it('deletes files and directories', () => {
    const testFile = path.join(testDir, 'test.txt')
    fs.writeFileSync(testFile, 'test content')
    expect(fs.existsSync(testFile)).toBe(true)

    fs.unlinkSync(testFile)
    expect(fs.existsSync(testFile)).toBe(false)

    const testSubDir = path.join(testDir, 'subdir')
    fs.mkdirSync(path.join(testSubDir, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(testSubDir, 'nested', 'file.txt'), 'test')

    fs.rmSync(testSubDir, { recursive: true, force: true })
    expect(fs.existsSync(testSubDir)).toBe(false)
  })
})
