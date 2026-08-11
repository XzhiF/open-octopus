// packages/server/src/__tests__/harness-delegation-integration.test.ts
//
// Ticket 05 — Harness Agent Full Integration Tests.
//
// Tests that AgentDelegationService.buildPromptWithHistory() properly wires
// HarnessPromptAdapter for persona + long-term + daily + experience context,
// and preserves existing stats injection (ticket 04).
//
// AC-1: buildPromptWithHistory uses HarnessPromptAdapter
// AC-5: Final prompt = persona + long-term + daily + experience + stats + delegation
// AC-6: Existing delegation tests still pass (regression)
// AC-7: Graceful degradation when no experience data

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { DiagnosisReport } from '@octopus/shared'
import type { DelegationContext } from '../services/harness/agent-delegation'
import { AgentDelegationService } from '../services/harness/agent-delegation'
import type { HarnessDAO } from '../db/dao/harness-dao'
import type { EvolutionDAO } from '../db/dao/evolution-dao'
import type { SSEService } from '../services/sse'

// ── Test Fixtures ──────────────────────────────────────────────────

let tmpHome: string

function createTmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octopus-delegation-test-'))
  const agentDir = path.join(dir, 'agent')
  const builtInDir = path.join(agentDir, 'built-in')
  const harnessDir = path.join(builtInDir, 'harness-agent')
  const memoryDir = path.join(harnessDir, 'memory')
  const dailyDir = path.join(memoryDir, 'daily')

  fs.mkdirSync(dailyDir, { recursive: true })

  // Harness persona
  fs.writeFileSync(
    path.join(harnessDir, 'persona.md'),
    '# Harness Agent\n\n你是工作流安全守护 Agent。负责检测异常并做出干预决策。',
  )

  // Long-term memory
  fs.writeFileSync(
    path.join(memoryDir, 'long-term.md'),
    '# 分身长期记忆\n\n- 历史干预经验: syntax_error 常见于 bash 脚本',
  )

  return dir
}

function makeReport(): DiagnosisReport {
  return {
    id: 'test-report-1',
    timestamp: 1700000000000,
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

function makeContext(): DelegationContext {
  return {
    recentEvents: [],
    varpoolSnapshot: { project_path: '/tmp/test-project' },
    nodeConfig: { id: 'node-1', type: 'bash', script: 'echo "hello"' },
    workflowContent: 'version: "1"\nnodes:\n  - id: node-1\n    type: bash',
  }
}

/**
 * Create a mock AgentDelegationService that exposes buildPromptWithHistory.
 * We use a subclass to access the private method for testing.
 */
function createTestableService(overrides: {
  evolutionDao?: EvolutionDAO
  session?: any
}): AgentDelegationService & { _testBuildPrompt: (r: DiagnosisReport, c: DelegationContext) => Promise<string> } {
  const mockDao = {
    insertHarnessTokenUsage: vi.fn(),
    insertEvent: vi.fn(),
  } as unknown as HarnessDAO

  const mockSse = {
    emit: vi.fn(),
  } as unknown as SSEService

  // Mock LLM call that returns a simple JSON decision
  const mockLlmCall = vi.fn().mockResolvedValue({
    text: '```json\n{"decision":"fix_and_retry","reasoning":"test"}\n```',
    tokenUsage: { input: 100, output: 50, model: 'test' },
  })

  const service = new AgentDelegationService({
    dao: mockDao,
    sse: mockSse,
    workspaceId: 'test-workspace',
    evolutionDao: overrides.evolutionDao,
    session: overrides.session,
    llmCall: mockLlmCall,
  })

  // Expose the private method for testing via a test-only wrapper
  const testable = service as any
  return Object.assign(service, {
    _testBuildPrompt: (r: DiagnosisReport, c: DelegationContext) =>
      testable.buildPromptWithHistory(r, c),
  })
}

// ── Test Setup ──────────────────────────────────────────────────────

beforeEach(() => {
  tmpHome = createTmpHome()
  process.env.OCTOPUS_HOME = tmpHome
})

afterEach(() => {
  delete process.env.OCTOPUS_HOME
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // Non-fatal
  }
})

// ── Tests ───────────────────────────────────────────────────────────

describe('Ticket 05: AgentDelegationService.buildPromptWithHistory', () => {
  it('includes harness-agent persona from HarnessPromptAdapter', async () => {
    const service = createTestableService({})
    const report = makeReport()
    const context = makeContext()

    const prompt = await service._testBuildPrompt(report, context)

    expect(prompt).toContain('工作流安全守护 Agent')
    expect(prompt).toContain('检测异常')
  })

  it('includes long-term memory from HarnessPromptAdapter', async () => {
    const service = createTestableService({})
    const report = makeReport()
    const context = makeContext()

    const prompt = await service._testBuildPrompt(report, context)

    expect(prompt).toContain('分身长期记忆')
    expect(prompt).toContain('历史干预经验')
  })

  it('includes daily memory when today\'s file exists', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const dailyDir = path.join(tmpHome, 'agent', 'built-in', 'harness-agent', 'memory', 'daily')
    fs.writeFileSync(
      path.join(dailyDir, `${today}.md`),
      '- 10:00 fix_and_retry for syntax_error on node-1',
    )

    const service = createTestableService({})
    const report = makeReport()
    const context = makeContext()

    const prompt = await service._testBuildPrompt(report, context)

    expect(prompt).toContain('今日干预记录')
    expect(prompt).toContain(today)
    expect(prompt).toContain('fix_and_retry')
  })

  it('includes experience context from ContextEnricher when evolutionDao is configured', async () => {
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
          org: 'default',
          created_at: '2026-08-10T12:00:00Z',
        },
      ]),
      getSuccessStats: vi.fn().mockReturnValue({ decisionStats: {}, patternStats: {} }),
    } as unknown as EvolutionDAO

    const service = createTestableService({ evolutionDao: mockDao })
    const report = makeReport()
    const context = makeContext()

    const prompt = await service._testBuildPrompt(report, context)

    expect(prompt).toContain('相关历史经验')
    expect(prompt).toContain('syntax_error')
    expect(prompt).toContain('✅')
  })

  it('gracefully degrades when no evolutionDao is configured (AC-7)', async () => {
    const service = createTestableService({}) // no evolutionDao
    const report = makeReport()
    const context = makeContext()

    const prompt = await service._testBuildPrompt(report, context)

    // Should still have persona + memory + delegation, just no experience
    expect(prompt).toContain('工作流安全守护 Agent')
    expect(prompt).toContain('分身长期记忆')
    expect(prompt).toContain('当前异常')
    // Should NOT have experience segment
    expect(prompt).not.toContain('相关历史经验')
  })

  it('gracefully degrades when ContextEnricher returns no results (AC-7)', async () => {
    const mockDao = {
      searchByScopes: vi.fn().mockReturnValue([]),
      getSuccessStats: vi.fn().mockReturnValue({ decisionStats: {}, patternStats: {} }),
    } as unknown as EvolutionDAO

    const service = createTestableService({ evolutionDao: mockDao })
    const report = makeReport()
    const context = makeContext()

    const prompt = await service._testBuildPrompt(report, context)

    // Should still have the rest of the prompt
    expect(prompt).toContain('工作流安全守护 Agent')
    expect(prompt).toContain('当前异常')
    // No experience section
    expect(prompt).not.toContain('相关历史经验')
  })

  it('includes delegation prompt content', async () => {
    const service = createTestableService({})
    const report = makeReport()
    const context = makeContext()

    const prompt = await service._testBuildPrompt(report, context)

    expect(prompt).toContain('当前异常')
    expect(prompt).toContain('deterministic_error')
    expect(prompt).toContain('syntax_error')
    expect(prompt).toContain('fix_and_retry')
    expect(prompt).toContain('你的任务')
  })

  it('preserves stats injection when evolutionDao has stats (ticket 04 regression)', async () => {
    const mockDao = {
      searchByScopes: vi.fn().mockReturnValue([]),
      getSuccessStats: vi.fn().mockReturnValue({
        decisionStats: {
          fix_and_retry: { success: 8, failed: 2, pending: 0, total: 10, rate: 0.8 },
          guide_and_retry: { success: 3, failed: 3, pending: 0, total: 6, rate: 0.5 },
        },
        patternStats: {},
      }),
    } as unknown as EvolutionDAO

    const service = createTestableService({ evolutionDao: mockDao })
    const report = makeReport()
    const context = makeContext()

    const prompt = await service._testBuildPrompt(report, context)

    // Stats section should be present
    expect(prompt).toContain('历史经验统计')
    expect(prompt).toContain('fix_and_retry')
    expect(prompt).toContain('成功率')
  })

  it('assembles in correct order: persona → long-term → daily → experience → delegation (with stats inside)', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const dailyDir = path.join(tmpHome, 'agent', 'built-in', 'harness-agent', 'memory', 'daily')
    fs.writeFileSync(
      path.join(dailyDir, `${today}.md`),
      '- 10:00 fix_and_retry for syntax_error',
    )

    const mockDao = {
      searchByScopes: vi.fn().mockReturnValue([
        {
          id: 1,
          content: 'Past case: fixed bash syntax error',
          scope: 'harness',
          scope_ref: 'deterministic_error',
          pattern_tags: '["syntax_error"]',
          outcome: '{"label":"success"}',
          source_type: 'harness',
          org: 'default',
          created_at: '2026-08-10T12:00:00Z',
        },
      ]),
      getSuccessStats: vi.fn().mockReturnValue({
        decisionStats: {
          fix_and_retry: { success: 8, failed: 2, pending: 0, total: 10, rate: 0.8 },
        },
        patternStats: {},
      }),
    } as unknown as EvolutionDAO

    const service = createTestableService({ evolutionDao: mockDao })
    const report = makeReport()
    const context = makeContext()

    const prompt = await service._testBuildPrompt(report, context)

    // Verify ordering: persona → long-term → daily → experience → delegation prompt start
    // Stats are injected INSIDE the delegation prompt (before "你的任务"), not before it.
    const personaIdx = prompt.indexOf('工作流安全守护 Agent')
    const longTermIdx = prompt.indexOf('分身长期记忆')
    const dailyIdx = prompt.indexOf('今日干预记录')
    const experienceIdx = prompt.indexOf('相关历史经验')
    const delegationStartIdx = prompt.indexOf('当前异常')
    const statsIdx = prompt.indexOf('历史经验统计')
    const taskIdx = prompt.indexOf('你的任务')

    expect(personaIdx).toBeGreaterThanOrEqual(0)
    expect(longTermIdx).toBeGreaterThan(personaIdx)
    expect(dailyIdx).toBeGreaterThan(longTermIdx)
    expect(experienceIdx).toBeGreaterThan(dailyIdx)
    // Delegation prompt content comes after the prefix
    expect(delegationStartIdx).toBeGreaterThan(experienceIdx)
    // Stats are injected inside the delegation prompt, before the task instructions
    expect(statsIdx).toBeGreaterThan(delegationStartIdx)
    expect(taskIdx).toBeGreaterThan(statsIdx)
  })
})
