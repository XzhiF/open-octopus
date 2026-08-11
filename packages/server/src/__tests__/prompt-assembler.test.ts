/**
 * Unified Prompt Assembler — Unit Tests
 *
 * Tests the Adapter pattern that wraps three prompt systems:
 *   1. ChatPromptAdapter — wraps SystemPromptAssembler
 *   2. ClonePromptAdapter — wraps CloneRuntime.assembleContext
 *   3. HarnessPromptAdapter — wraps buildDelegationPrompt + persona/memory
 *   4. UnifiedPromptAssembler — routes to correct adapter
 *
 * Snapshot tests verify each adapter produces the same output as the original.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { initDb, closeDb, getDb } from '../db/connection'
import { EvolutionDAO } from '../db/dao'
import type { ExperienceRowV2 } from '../db/types'
import type { CloneDef, DiagnosisReport } from '@octopus/shared'
import type { DelegationContext } from '../services/harness/agent-delegation'
import {
  ChatPromptAdapter,
  ClonePromptAdapter,
  HarnessPromptAdapter,
  UnifiedPromptAssembler,
  createPromptAssembler,
} from '../services/agent/prompt-assembler'
import { SystemPromptAssembler } from '../services/agent/system-prompt-assembler'
import { CloneRuntime } from '../services/agent/clone-runtime'
import { buildDelegationPrompt } from '../services/harness/agent-delegation'

// ── Test Fixtures ─────────────────────────────────────────────────

const TEST_ORG = 'test-prompt-assembler-org'

let tmpHome: string

/**
 * Create a temporary OCTOPUS_HOME with the expected directory structure.
 */
function createTmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-prompt-test-'))
  const agentDir = path.join(dir, 'agent')
  const builtInDir = path.join(agentDir, 'built-in')
  const clonesDir = path.join(agentDir, 'clones')
  const memoryDir = path.join(agentDir, 'memory')
  const dailyMemoryDir = path.join(memoryDir, 'daily')
  const skillsDir = path.join(agentDir, 'skills')

  // Create all directories
  fs.mkdirSync(agentDir, { recursive: true })
  fs.mkdirSync(builtInDir, { recursive: true })
  fs.mkdirSync(clonesDir, { recursive: true })
  fs.mkdirSync(memoryDir, { recursive: true })
  fs.mkdirSync(dailyMemoryDir, { recursive: true })
  fs.mkdirSync(skillsDir, { recursive: true })

  // Write main agent persona
  fs.writeFileSync(
    path.join(agentDir, 'persona.md'),
    '# 人格\n\n你是 Octopus Agent，一个智能编排助手。',
  )

  // Write main agent long-term memory
  fs.writeFileSync(
    path.join(memoryDir, 'long-term.md'),
    '# 长期记忆\n\n- 偏好：使用 TypeScript\n- 常用工作流：代码审查 → 测试 → 部署',
  )

  return dir
}

/**
 * Create harness-agent built-in clone with persona + memory.
 */
function createHarnessAgentClone(tmpHomePath: string): void {
  const harnessDir = path.join(tmpHomePath, 'agent', 'built-in', 'harness-agent')
  const memoryDir = path.join(harnessDir, 'memory')
  fs.mkdirSync(harnessDir, { recursive: true })
  fs.mkdirSync(memoryDir, { recursive: true })

  // Write harness-agent persona
  fs.writeFileSync(
    path.join(harnessDir, 'persona.md'),
    '# Harness Agent\n\n你是工作流安全守护 Agent。负责检测异常并做出干预决策。',
  )

  // Write harness-agent long-term memory
  fs.writeFileSync(
    path.join(memoryDir, 'long-term.md'),
    '# 分身长期记忆\n\n- 历史干预经验: syntax_error 常见于 bash 脚本\n- 最佳实践: 先检查变量池再修改脚本',
  )
}

/**
 * Create a test clone (user type) with persona + memory.
 */
function createTestClone(tmpHomePath: string, name: string = 'test-clone'): void {
  const cloneDir = path.join(tmpHomePath, 'agent', 'clones', name)
  const memoryDir = path.join(cloneDir, 'memory')
  const dailyDir = path.join(memoryDir, 'daily')
  fs.mkdirSync(cloneDir, { recursive: true })
  fs.mkdirSync(dailyDir, { recursive: true })

  // Write clone persona
  fs.writeFileSync(
    path.join(cloneDir, 'persona.md'),
    `# 分身: ${name}\n\n你是 ${name} 分身，一个测试用分身。`,
  )

  // Write clone long-term memory
  fs.writeFileSync(
    path.join(memoryDir, 'long-term.md'),
    `# 分身长期记忆\n\n- ${name} 的长期记忆内容`,
  )

  // Write config.json
  fs.writeFileSync(
    path.join(cloneDir, 'config.json'),
    JSON.stringify({
      name,
      display_name: name,
      type: 'user',
      skills: [],
      memoryScope: 'shared',
      config: {},
    }),
  )
}

/**
 * Build a minimal DiagnosisReport for testing.
 */
function makeReport(): DiagnosisReport {
  return {
    id: 'test-report-1',
    timestamp: 1700000000000, // Fixed timestamp for snapshot stability
    detector: 'deterministic_error',
    severity: 'critical',
    executionId: 'exec-1',
    nodeId: 'node-1',
    nodeType: 'bash',
    pattern: 'syntax_error',
    evidence: [
      {
        attempt: 1,
        errorCode: 'ERR_SYNTAX',
        errorMessage: 'syntax error near unexpected token',
        errorHash: 'abc123',
        errorPattern: 'syntax_error',
        determinism: 'deterministic',
      },
    ],
    context: {
      retryCount: 2,
      nodeDurationMs: 1500,
      workflowProgress: 0.5,
    },
  }
}

/**
 * Build a minimal DelegationContext for testing.
 */
function makeContext(): DelegationContext {
  return {
    recentEvents: [
      { type: 'node_start', nodeId: 'node-1', timestamp: 1700000000000 - 5000 },
      { type: 'node_error', nodeId: 'node-1', timestamp: 1700000000000 - 1000 },
    ],
    varpoolSnapshot: {
      project_path: '/tmp/test-project',
      build_cmd: 'npm run build',
    },
    nodeConfig: {
      id: 'node-1',
      type: 'bash',
      script: 'echo "hello"',
    },
    workflowContent: 'version: "1"\nnodes:\n  - id: node-1\n    type: bash\n    script: echo "hello"',
  }
}

/**
 * Build a test CloneDef.
 */
function makeCloneDef(name: string = 'test-clone', type: 'built-in' | 'user' = 'user'): CloneDef {
  return {
    name,
    displayName: name,
    type,
    persona: `你是 ${name} 分身。`,
    skills: [],
    memoryScope: 'shared',
    config: {},
  }
}

// ── Test Setup ────────────────────────────────────────────────────

beforeEach(() => {
  tmpHome = createTmpHome()
  process.env.OCTOPUS_HOME = tmpHome
  createHarnessAgentClone(tmpHome)
  createTestClone(tmpHome)
  // Initialize in-memory DB for experience segment tests (ticket 03).
  // Safe for all tests: empty DB means no experiences → segment is null → output unchanged.
  initDb(':memory:')
})

afterEach(() => {
  delete process.env.OCTOPUS_HOME
  closeDb()
  // Cleanup temp directory
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // Non-fatal cleanup failure
  }
})

// ── ChatPromptAdapter Tests ───────────────────────────────────────

describe('ChatPromptAdapter', () => {
  it('produces the same output as SystemPromptAssembler.assemble()', () => {
    const adapter = new ChatPromptAdapter(TEST_ORG)
    const original = new SystemPromptAssembler(TEST_ORG)

    const adapterOutput = adapter.assemble()
    const originalOutput = original.assemble()

    expect(adapterOutput).toBe(originalOutput)
  })

  it('passes options through to SystemPromptAssembler', () => {
    const adapter = new ChatPromptAdapter(TEST_ORG)
    const original = new SystemPromptAssembler(TEST_ORG)

    const opts = {
      max_tokens: 4000,
      scheduled_task: true,
      include_skills: ['octo-scheduler'],
    }

    const adapterOutput = adapter.assemble(opts)
    const originalOutput = original.assemble(opts)

    expect(adapterOutput).toBe(originalOutput)
  })

  it('accepts userMessage option without affecting output (ticket 02)', () => {
    const adapter = new ChatPromptAdapter(TEST_ORG)
    const original = new SystemPromptAssembler(TEST_ORG)

    // userMessage is optional and accepted — ticket 03 will use it for experience injection
    // Inline object literals trigger TypeScript excess property checks — compilation
    // would fail here if userMessage were not declared in AssembleOptions.
    const withMsg = original.assemble({ userMessage: '之前遇到过这个 error，怎么解决的？' })
    const withoutMsg = original.assemble({})

    // Both calls must succeed without throwing
    expect(withMsg.length).toBeGreaterThan(0)
    expect(withoutMsg.length).toBeGreaterThan(0)

    // Ticket 02 is wiring-only; output should be identical until ticket 03 adds experience segment
    expect(withMsg).toBe(withoutMsg)

    // ChatPromptAdapter should pass userMessage through
    const adapterWithMsg = adapter.assemble({ userMessage: '之前遇到过这个 error，怎么解决的？' })
    expect(adapterWithMsg).toBe(withMsg)
  })

  it('assembleForClone produces the same output as SystemPromptAssembler.assembleForClone()', () => {
    const adapter = new ChatPromptAdapter(TEST_ORG)
    const original = new SystemPromptAssembler(TEST_ORG)

    const adapterOutput = adapter.assembleForClone('test-clone')
    const originalOutput = original.assembleForClone('test-clone')

    expect(adapterOutput).toBe(originalOutput)
  })

  it('preserves priority-based budget truncation', () => {
    const adapter = new ChatPromptAdapter(TEST_ORG)
    const original = new SystemPromptAssembler(TEST_ORG)

    // Use a very tight budget to force truncation
    const opts = { max_tokens: 100 }

    const adapterOutput = adapter.assemble(opts)
    const originalOutput = original.assemble(opts)

    expect(adapterOutput).toBe(originalOutput)
  })
})

// ── ClonePromptAdapter Tests ──────────────────────────────────────

describe('ClonePromptAdapter', () => {
  it('produces the same output as CloneRuntime.assembleContext()', () => {
    const cloneDef = makeCloneDef('test-clone')
    const adapter = new ClonePromptAdapter(cloneDef, TEST_ORG)
    const runtime = new CloneRuntime(cloneDef, TEST_ORG)

    const adapterOutput = adapter.assemble()
    const runtimeOutput = runtime.assembleContext()

    expect(adapterOutput).toBe(runtimeOutput)
  })

  it('includes persona from clone directory', () => {
    const cloneDef = makeCloneDef('test-clone')
    const adapter = new ClonePromptAdapter(cloneDef, TEST_ORG)

    const output = adapter.assemble()

    // The test-clone's persona.md was created in createTestClone()
    expect(output).toContain('分身: test-clone')
  })

  it('includes long-term memory from clone directory', () => {
    const cloneDef = makeCloneDef('test-clone')
    const adapter = new ClonePromptAdapter(cloneDef, TEST_ORG)

    const output = adapter.assemble()

    expect(output).toContain('分身长期记忆')
  })
})

// ── HarnessPromptAdapter Tests ────────────────────────────────────

describe('HarnessPromptAdapter', () => {
  it('loads persona.md from harness-agent directory', () => {
    const adapter = new HarnessPromptAdapter(TEST_ORG)

    const persona = adapter.loadPersona()

    expect(persona).toContain('工作流安全守护 Agent')
    expect(persona).toContain('检测异常')
  })

  it('loads long-term memory from harness-agent directory', () => {
    const adapter = new HarnessPromptAdapter(TEST_ORG)

    const memory = adapter.loadLongTermMemory()

    expect(memory).toContain('分身长期记忆')
    expect(memory).toContain('历史干预经验')
  })

  it('assemble includes persona + memory + delegation prompt', () => {
    const adapter = new HarnessPromptAdapter(TEST_ORG)
    const report = makeReport()
    const context = makeContext()

    const output = adapter.assemble({
      diagnosisReport: report,
      delegationContext: context,
    })

    // Should contain persona
    expect(output).toContain('工作流安全守护 Agent')
    // Should contain memory
    expect(output).toContain('历史干预经验')
    // Should contain delegation prompt content
    expect(output).toContain('当前异常')
    expect(output).toContain('deterministic_error')
    expect(output).toContain('fix_and_retry')
  })

  it('assemble without report/context still includes persona + memory', () => {
    const adapter = new HarnessPromptAdapter(TEST_ORG)

    const output = adapter.assemble()

    // Should contain persona and memory but no delegation prompt
    expect(output).toContain('工作流安全守护 Agent')
    expect(output).toContain('历史干预经验')
    expect(output).not.toContain('当前异常')
  })

  it('assemble delegation prompt matches buildDelegationPrompt output', () => {
    const adapter = new HarnessPromptAdapter(TEST_ORG)
    const report = makeReport()
    const context = makeContext()

    const originalPrompt = buildDelegationPrompt(report, context)
    const adapterOutput = adapter.assemble({
      diagnosisReport: report,
      delegationContext: context,
    })

    // The adapter output should contain the full delegation prompt
    expect(adapterOutput).toContain(originalPrompt)
  })

  it('returns empty strings for missing persona/memory gracefully', () => {
    const adapter = new HarnessPromptAdapter(TEST_ORG, 'nonexistent-agent')

    const persona = adapter.loadPersona()
    const memory = adapter.loadLongTermMemory()

    expect(persona).toBe('')
    expect(memory).toBe('')
  })

  // ── Ticket 05: Daily Memory ────────────────────────────────────

  it('loadDailyMemory reads today\'s daily file from harness-agent memory dir', () => {
    // Write a daily memory file for today
    const today = new Date().toISOString().slice(0, 10)
    const harnessDir = path.join(tmpHome, 'agent', 'built-in', 'harness-agent')
    const dailyDir = path.join(harnessDir, 'memory', 'daily')
    fs.mkdirSync(dailyDir, { recursive: true })
    fs.writeFileSync(
      path.join(dailyDir, `${today}.md`),
      '- 10:00 fix_and_retry for syntax_error on node-1\n- 11:30 guide_and_retry for timeout on node-3',
    )

    const adapter = new HarnessPromptAdapter(TEST_ORG)
    const daily = adapter.loadDailyMemory()

    expect(daily).toContain('今日干预记录')
    expect(daily).toContain(today)
    expect(daily).toContain('fix_and_retry')
    expect(daily).toContain('syntax_error')
  })

  it('loadDailyMemory returns empty string when no daily file exists', () => {
    const adapter = new HarnessPromptAdapter(TEST_ORG)
    const daily = adapter.loadDailyMemory()

    expect(daily).toBe('')
  })

  it('loadDailyMemory truncates content to 500 token budget (~2000 chars)', () => {
    const today = new Date().toISOString().slice(0, 10)
    const harnessDir = path.join(tmpHome, 'agent', 'built-in', 'harness-agent')
    const dailyDir = path.join(harnessDir, 'memory', 'daily')
    fs.mkdirSync(dailyDir, { recursive: true })

    // Write a very large daily file (> 2000 chars)
    const largeContent = '- entry\n'.repeat(500) // ~3500 chars
    fs.writeFileSync(path.join(dailyDir, `${today}.md`), largeContent)

    const adapter = new HarnessPromptAdapter(TEST_ORG)
    const daily = adapter.loadDailyMemory()

    // Should be truncated
    expect(daily.length).toBeLessThan(largeContent.length + 100) // +100 for header
    expect(daily).toContain('...')
  })

  it('loadDailyMemory returns empty string for nonexistent clone', () => {
    const adapter = new HarnessPromptAdapter(TEST_ORG, 'nonexistent-clone')
    const daily = adapter.loadDailyMemory()

    expect(daily).toBe('')
  })

  // ── Ticket 05: Experience Context ──────────────────────────────

  it('loadExperienceContextAsync returns empty string without evolutionDao (graceful degradation)', async () => {
    const adapter = new HarnessPromptAdapter(TEST_ORG) // no evolutionDao
    const report = makeReport()

    const experience = await adapter.loadExperienceContextAsync(report)

    expect(experience).toBe('')
  })

  it('loadExperienceContextAsync calls ContextEnricher with scope=harness, forceSearch=true', async () => {
    // Create a mock EvolutionDAO that tracks calls
    const mockDao = {
      searchByScopes: vi.fn().mockReturnValue([]),
      getSuccessStats: vi.fn().mockReturnValue({ decisionStats: {}, patternStats: {} }),
    } as any

    const adapter = new HarnessPromptAdapter(TEST_ORG, 'harness-agent', mockDao)
    const report = makeReport()

    await adapter.loadExperienceContextAsync(report)

    expect(mockDao.searchByScopes).toHaveBeenCalledWith(
      report.pattern,
      ['harness', 'global'],
      expect.any(Number),
    )
  })

  it('loadExperienceContextAsync returns formatted segment when experiences exist', async () => {
    // Create a mock EvolutionDAO with a matching experience
    const mockDao = {
      searchByScopes: vi.fn().mockReturnValue([
        {
          id: 1,
          content: 'Fixed bash syntax error by adding missing quote',
          scope: 'harness',
          scope_ref: 'deterministic_error',
          pattern_tags: '["syntax_error"]',
          outcome: '{"label":"success"}',
          source_type: 'harness',
          org: TEST_ORG,
          created_at: '2026-08-10T12:00:00Z',
        },
      ]),
      getSuccessStats: vi.fn().mockReturnValue({ decisionStats: {}, patternStats: {} }),
    } as any

    const adapter = new HarnessPromptAdapter(TEST_ORG, 'harness-agent', mockDao)
    const report = makeReport()

    const experience = await adapter.loadExperienceContextAsync(report)

    expect(experience).toContain('相关历史经验')
    expect(experience).toContain('syntax_error')
    expect(experience).toContain('✅')
  })

  it('loadExperienceContextAsync gracefully handles DAO errors', async () => {
    const mockDao = {
      searchByScopes: vi.fn().mockImplementation(() => {
        throw new Error('DB error')
      }),
    } as any

    const adapter = new HarnessPromptAdapter(TEST_ORG, 'harness-agent', mockDao)
    const report = makeReport()

    const experience = await adapter.loadExperienceContextAsync(report)

    // Should not throw, return empty string
    expect(experience).toBe('')
  })

  // ── Ticket 05: assemble() with daily + experience ──────────────

  it('assemble includes daily memory when available', () => {
    const today = new Date().toISOString().slice(0, 10)
    const harnessDir = path.join(tmpHome, 'agent', 'built-in', 'harness-agent')
    const dailyDir = path.join(harnessDir, 'memory', 'daily')
    fs.mkdirSync(dailyDir, { recursive: true })
    fs.writeFileSync(
      path.join(dailyDir, `${today}.md`),
      '- 10:00 fix_and_retry for syntax_error',
    )

    const adapter = new HarnessPromptAdapter(TEST_ORG)
    const report = makeReport()
    const context = makeContext()

    const output = adapter.assemble({
      diagnosisReport: report,
      delegationContext: context,
    })

    // Should contain persona + long-term memory
    expect(output).toContain('工作流安全守护 Agent')
    expect(output).toContain('历史干预经验')
    // Should contain daily memory
    expect(output).toContain('今日干预记录')
    expect(output).toContain('fix_and_retry')
    // Should contain delegation prompt
    expect(output).toContain('当前异常')
    expect(output).toContain('syntax_error')
    // Note: experience context requires async loading via loadExperienceContextAsync()
    // and is wired in AgentDelegationService.buildPromptWithHistory(), not in sync assemble().
  })
})

// ── UnifiedPromptAssembler Routing Tests ──────────────────────────

describe('UnifiedPromptAssembler', () => {
  it('routes to ChatPromptAdapter when no cloneName provided', () => {
    const assembler = new UnifiedPromptAssembler(TEST_ORG)
    const original = new SystemPromptAssembler(TEST_ORG)

    const output = assembler.assembleForAgent()
    const expected = original.assemble()

    expect(output).toBe(expected)
  })

  it('routes to ChatPromptAdapter.assembleForClone when cloneName provided without type', () => {
    const assembler = new UnifiedPromptAssembler(TEST_ORG)
    const original = new SystemPromptAssembler(TEST_ORG)

    const output = assembler.assembleForAgent('test-clone')
    const expected = original.assembleForClone('test-clone')

    expect(output).toBe(expected)
  })

  it('routes to HarnessPromptAdapter when cloneName is harness-agent', () => {
    const assembler = new UnifiedPromptAssembler(TEST_ORG)
    const report = makeReport()
    const context = makeContext()

    const output = assembler.assembleForAgent('harness-agent', {
      diagnosisReport: report,
      delegationContext: context,
    })

    // Should contain harness persona
    expect(output).toContain('工作流安全守护 Agent')
    // Should contain delegation prompt
    expect(output).toContain('当前异常')
  })

  it('routes to ClonePromptAdapter when type is clone', () => {
    const assembler = new UnifiedPromptAssembler(TEST_ORG)

    // When type is 'clone', the assembler resolves CloneDef from filesystem.
    // The test-clone was created by createTestClone() with persona.md on disk.
    // We verify the output contains clone-specific content from the filesystem.
    const output = assembler.assembleForAgent('test-clone', { type: 'clone' })

    // Should contain clone persona from filesystem (persona.md)
    expect(output).toContain('分身: test-clone')
    // Should contain clone memory from filesystem
    expect(output).toContain('分身长期记忆')
    // Should contain memory guidance (CloneRuntime adds this)
    expect(output).toContain('记忆与人格管理')
  })

  it('routes to HarnessPromptAdapter when type is harness', () => {
    const assembler = new UnifiedPromptAssembler(TEST_ORG)
    const report = makeReport()
    const context = makeContext()

    const output = assembler.assembleForAgent('harness-agent', {
      type: 'harness',
      diagnosisReport: report,
      delegationContext: context,
    })

    expect(output).toContain('工作流安全守护 Agent')
    expect(output).toContain('当前异常')
  })

  it('falls back to chat with clone_name when clone not found', () => {
    const assembler = new UnifiedPromptAssembler(TEST_ORG)
    const original = new SystemPromptAssembler(TEST_ORG)

    // Explicitly request clone type for a non-existent clone
    const output = assembler.assembleForAgent('nonexistent-clone', { type: 'clone' })
    const expected = original.assemble({ clone_name: 'nonexistent-clone' })

    expect(output).toBe(expected)
  })
})

// ── Factory Function Tests ────────────────────────────────────────

describe('createPromptAssembler', () => {
  it('returns a PromptAssembler instance', () => {
    const assembler = createPromptAssembler(TEST_ORG)

    expect(assembler).toBeDefined()
    expect(typeof assembler.assembleForAgent).toBe('function')
  })

  it('assembles main agent prompt correctly', () => {
    const assembler = createPromptAssembler(TEST_ORG)
    const original = new SystemPromptAssembler(TEST_ORG)

    const output = assembler.assembleForAgent()
    const expected = original.assemble()

    expect(output).toBe(expected)
  })

  it('assembles harness prompt with persona + memory', () => {
    const assembler = createPromptAssembler(TEST_ORG)
    const report = makeReport()
    const context = makeContext()

    const output = assembler.assembleForAgent('harness-agent', {
      diagnosisReport: report,
      delegationContext: context,
    })

    expect(output).toContain('工作流安全守护 Agent')
    expect(output).toContain('历史干预经验')
    expect(output).toContain('当前异常')
  })
})

// ── Priority-based Budget Truncation Tests ────────────────────────

describe('Budget truncation preservation', () => {
  it('ChatPromptAdapter preserves truncation behavior for memory segments', () => {
    // Write a very large long-term memory to trigger truncation
    const memoryPath = path.join(tmpHome, 'agent', 'memory', 'long-term.md')
    const largeContent = '# 长期记忆\n\n' + 'x'.repeat(10000)
    fs.writeFileSync(memoryPath, largeContent)

    const adapter = new ChatPromptAdapter(TEST_ORG)
    const original = new SystemPromptAssembler(TEST_ORG)

    const adapterOutput = adapter.assemble({ max_tokens: 2000 })
    const originalOutput = original.assemble({ max_tokens: 2000 })

    expect(adapterOutput).toBe(originalOutput)
    // Both should be truncated to fit budget
    expect(adapterOutput.length).toBeLessThan(largeContent.length)
  })

  it('ChatPromptAdapter preserves truncation for skills segments', () => {
    const adapter = new ChatPromptAdapter(TEST_ORG)
    const original = new SystemPromptAssembler(TEST_ORG)

    // Very tight budget forces skill truncation
    const adapterOutput = adapter.assemble({ max_tokens: 500 })
    const originalOutput = original.assemble({ max_tokens: 500 })

    expect(adapterOutput).toBe(originalOutput)
  })
})

// ── Snapshot Tests ────────────────────────────────────────────────

describe('Snapshot tests — output equivalence', () => {
  it('ChatPromptAdapter snapshot matches SystemPromptAssembler', () => {
    const adapter = new ChatPromptAdapter(TEST_ORG)
    const original = new SystemPromptAssembler(TEST_ORG)

    // Both must produce identical output
    expect(adapter.assemble()).toBe(original.assemble())

    // Snapshot with normalized temp paths
    const normalizedOutput = adapter.assemble().replace(/octopus-prompt-test-\w+/g, 'octopus-prompt-test-FIXED')
    expect(normalizedOutput).toMatchSnapshot('chat-adapter-main')
  })

  it('ClonePromptAdapter snapshot matches CloneRuntime', () => {
    const cloneDef = makeCloneDef('test-clone')
    const adapter = new ClonePromptAdapter(cloneDef, TEST_ORG)
    const runtime = new CloneRuntime(cloneDef, TEST_ORG)

    // Both must produce identical output (the real assertion)
    expect(adapter.assemble()).toBe(runtime.assembleContext())

    // Snapshot with normalized temp paths (paths contain random temp dir suffixes)
    const normalizedOutput = adapter.assemble().replace(/octopus-prompt-test-\w+/g, 'octopus-prompt-test-FIXED')
    expect(normalizedOutput).toMatchSnapshot('clone-adapter')
  })

  it('HarnessPromptAdapter snapshot with full context', () => {
    const adapter = new HarnessPromptAdapter(TEST_ORG)
    const report = makeReport()
    const context = makeContext()

    const output = adapter.assemble({
      diagnosisReport: report,
      delegationContext: context,
    })

    expect(output).toMatchSnapshot('harness-adapter-full')
  })
})

// ── Experience Segment Tests (Ticket 03) ──────────────────────────

/** Helper: insert a V2 experience row into the DAO for testing. */
function insertTestExperience(
  dao: EvolutionDAO,
  overrides: Partial<ExperienceRowV2> = {},
): void {
  dao.insertExperienceV2({
    skill_name: 'test-skill',
    content: 'test experience content',
    source_session_id: null,
    org: TEST_ORG,
    created_at: '2026-08-10T00:00:00.000Z',
    scope: 'agent',
    scope_ref: null,
    pattern_tags: '["fix_and_retry"]',
    outcome: JSON.stringify({ label: 'success' }),
    source_type: 'session',
    execution_id: null,
    node_id: null,
    ...overrides,
  })
}

describe('Experience segment integration (ticket 03)', () => {
  it('includes experience segment when userMessage contains trigger keyword and matching experiences exist', () => {
    const dao = new EvolutionDAO(getDb())
    insertTestExperience(dao, {
      content: '之前部署失败是怎么解决的问题，修复了 nginx.conf 中的端口冲突',
      scope: 'agent',
      pattern_tags: '["deployment_fix"]',
    })

    const assembler = new SystemPromptAssembler(TEST_ORG)
    const output = assembler.assemble({
      userMessage: '之前部署失败是怎么解决的',
    })

    // Should contain the experience segment header
    expect(output).toContain('相关历史经验')
    // Should contain the experience content
    expect(output).toContain('端口冲突')
  })

  it('does not include experience segment when userMessage has no trigger keywords', () => {
    const dao = new EvolutionDAO(getDb())
    insertTestExperience(dao, {
      content: '之前部署失败是配置文件问题',
      scope: 'agent',
    })

    const assembler = new SystemPromptAssembler(TEST_ORG)
    const output = assembler.assemble({
      userMessage: '帮我创建一个新文件',
    })

    // Should NOT contain the experience segment
    expect(output).not.toContain('相关历史经验')
  })

  it('does not include experience segment when no userMessage is provided', () => {
    const dao = new EvolutionDAO(getDb())
    insertTestExperience(dao, {
      content: '之前部署失败是配置文件问题',
      scope: 'agent',
    })

    const assembler = new SystemPromptAssembler(TEST_ORG)
    const output = assembler.assemble({})

    expect(output).not.toContain('相关历史经验')
  })

  it('experience segment has priority 3.5 (between memory at 3 and context at 4)', () => {
    const dao = new EvolutionDAO(getDb())
    insertTestExperience(dao, {
      content: '上次遇到 error 的解决方案，增加了重试机制和超时处理',
      scope: 'agent',
    })

    const assembler = new SystemPromptAssembler(TEST_ORG)
    const segments = assembler.getSegments({
      userMessage: '上次遇到 error 的解决方案',
    })

    const expSegment = segments.find((s) => s.source === 'experience')
    expect(expSegment).toBeDefined()
    expect(expSegment?.priority).toBe(3.5)
  })

  it('snapshot: no-keyword message produces unchanged output (no experience segment)', () => {
    const assembler = new SystemPromptAssembler(TEST_ORG)
    const output = assembler.assemble({
      userMessage: '帮我创建一个新文件',
    })

    // Normalize temp paths for snapshot stability
    const normalized = output.replace(/octopus-prompt-test-\w+/g, 'octopus-prompt-test-FIXED')
    expect(normalized).toMatchSnapshot('no-keyword-unchanged-output')
  })
})
