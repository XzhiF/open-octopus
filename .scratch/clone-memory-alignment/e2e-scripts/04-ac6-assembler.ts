// Quick E2E verification for AC6: SystemPromptAssembler.assembleForClone()
// Run with: npx tsx e2e-scripts/04-ac6-assembler.mjs

import { SystemPromptAssembler } from '../../../packages/server/src/services/agent/system-prompt-assembler'
import fs from 'fs'
import path from 'path'
import os from 'os'

const TEST_DIR = path.join(os.tmpdir(), `ac6-test-${Date.now()}`)
const CLONE_NAME = 'E2E_TEST_clone'

// Set up test environment
process.env.OCTOPUS_HOME = TEST_DIR

// Create clone directory with very long memory
const cloneDir = path.join(TEST_DIR, 'agent', 'clones', CLONE_NAME)
const memoryDir = path.join(cloneDir, 'memory')
const dailyDir = path.join(memoryDir, 'daily')

fs.mkdirSync(dailyDir, { recursive: true })

// Write persona
fs.writeFileSync(path.join(cloneDir, 'persona.md'), `# ${CLONE_NAME}\n\nTest clone persona for AC6 verification.`, 'utf-8')

// Write very long long-term memory (simulate > budget)
const longContent = Array(500).fill('- E2E_TEST_long_memory_entry: This is a very long memory entry that should be truncated when exceeding the token budget. '.repeat(5)).join('\n')
fs.writeFileSync(path.join(memoryDir, 'long-term.md'), `## 项目笔记\n\n${longContent}`, 'utf-8')

// Write today's daily memory
const today = new Date().toISOString().split('T')[0]
fs.writeFileSync(path.join(dailyDir, `${today}.md`), `### 10:00:00\nE2E_TEST_daily_entry: Today's work memory.`, 'utf-8')

// Test 1: assembleForClone returns content
console.log('=== AC6: SystemPromptAssembler.assembleForClone() Test ===\n')

try {
  const assembler = new SystemPromptAssembler('test-org')

  // Test with default budget
  const result = assembler.assembleForClone(CLONE_NAME)
  console.log(`[Test 1] assembleForClone() returned content: ${result.length > 0 ? 'PASS' : 'FAIL'}`)
  console.log(`  Output length: ${result.length} chars`)
  console.log(`  Contains clone persona: ${result.includes(CLONE_NAME) ? 'PASS' : 'FAIL'}`)
  console.log(`  Contains long-term memory: ${result.includes('E2E_TEST_long_memory_entry') ? 'PASS' : 'FAIL'}`)
  console.log(`  Contains daily memory: ${result.includes('E2E_TEST_daily_entry') ? 'PASS' : 'FAIL'}`)

  // Test with very small budget (truncation test)
  const smallBudgetResult = assembler.assembleForClone(CLONE_NAME, { max_tokens: 50 })
  console.log(`\n[Test 2] Truncation with max_tokens=50:`)
  console.log(`  Output length: ${smallBudgetResult.length} chars`)
  console.log(`  Shorter than full: ${smallBudgetResult.length < result.length ? 'PASS' : 'FAIL'}`)
  console.log(`  Still contains persona (priority 0): ${smallBudgetResult.includes(CLONE_NAME) ? 'PASS' : 'FAIL'}`)

  // Test with non-existent clone (fallback)
  const fallbackResult = assembler.assembleForClone('non_existent_clone')
  console.log(`\n[Test 3] Fallback for non-existent clone:`)
  console.log(`  Returns content: ${fallbackResult.length > 0 ? 'PASS' : 'FAIL'}`)
  console.log(`  Output length: ${fallbackResult.length} chars`)

  console.log('\n=== AC6 Test Complete ===')
} catch (err) {
  console.error('ERROR:', err instanceof Error ? err.message : String(err))
  console.error(err instanceof Error ? err.stack : '')
}

// Cleanup
delete process.env.OCTOPUS_HOME
try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
