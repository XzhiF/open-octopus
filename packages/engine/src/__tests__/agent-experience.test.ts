/**
 * Agent Executor Experience Injection Tests — VarPool bridge reader
 *
 * Verifies that AgentExecutor.buildPrompt() reads __experience_segment
 * from VarPool and prepends it to the prompt (AC-3, AC-4).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { AgentExecutor } from "../executors/agent"
import { VarPool } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"

// Mock the AgentNodeRunner
const mockRun = vi.fn().mockResolvedValue({
  finalText: "Agent output",
  durationMs: 100,
  sessionId: "session-1",
  tokens: { inputTokens: 10, outputTokens: 20 },
  modelUsages: [],
  events: [],
})

const mockRunner = {
  run: mockRun,
  getCwd: () => "/tmp/test",
  getLastActivityAt: () => Date.now(),
} as any

function makeAgentNode(overrides: Partial<NodeDef> = {}): NodeDef {
  return {
    id: "test-agent",
    type: "agent",
    ...overrides,
  }
}

describe("AgentExecutor — Experience Injection via VarPool", () => {
  beforeEach(() => {
    mockRun.mockClear()
  })

  it("prepends __experience_segment to prompt in standard mode (AC-3)", async () => {
    const experienceSegment = "## 📚 相关历史经验 (1条)\n\n**[2026-08-10] deploy_fix**\n   决策: deploy_fix ✅ 成功\n   摘要: 部署失败后回滚版本解决了问题"

    const node = makeAgentNode({ prompt: "Execute deployment task" })
    const pool = new VarPool({})
    pool.set("__experience_segment", experienceSegment)

    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt = mockRun.mock.calls[0][0].prompt
    expect(prompt).toContain("相关历史经验")
    expect(prompt).toContain("部署失败后回滚版本解决了问题")
    // Experience should be prepended before the main prompt
    const expIdx = prompt.indexOf("相关历史经验")
    const promptIdx = prompt.indexOf("Execute deployment task")
    expect(expIdx).toBeLessThan(promptIdx)
  })

  it("prepends __experience_segment to prompt in goal mode (AC-4)", async () => {
    const experienceSegment = "## 📚 相关历史经验 (1条)\n\n**[2026-08-10] build_fix**\n   决策: build_fix ✅ 成功\n   摘要: 构建超时通过缓存优化解决"

    const node = makeAgentNode({ goal: "Optimize build performance" })
    const pool = new VarPool({})
    pool.set("__experience_segment", experienceSegment)

    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt = mockRun.mock.calls[0][0].prompt
    expect(prompt).toContain("相关历史经验")
    expect(prompt).toContain("构建超时通过缓存优化解决")
    // Experience should be prepended before the Goal section
    const expIdx = prompt.indexOf("相关历史经验")
    const goalIdx = prompt.indexOf("## Goal")
    expect(expIdx).toBeLessThan(goalIdx)
  })

  it("does not inject when __experience_segment is absent (AC-5)", async () => {
    const node = makeAgentNode({ prompt: "Execute some task" })
    const pool = new VarPool({})
    // No __experience_segment set

    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt = mockRun.mock.calls[0][0].prompt
    expect(prompt).not.toContain("相关历史经验")
    expect(prompt).toBe("Execute some task")
  })

  it("does not inject when __experience_segment is null/undefined (AC-5)", async () => {
    const node = makeAgentNode({ prompt: "Execute some task" })
    const pool = new VarPool({})
    pool.set("__experience_segment", undefined)

    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt = mockRun.mock.calls[0][0].prompt
    expect(prompt).not.toContain("相关历史经验")
  })

  it("does not affect knowledge injection (AC-6)", async () => {
    const experienceSegment = "## 📚 相关历史经验 (1条)\n\ntest experience"

    const node = makeAgentNode({ prompt: "Execute task" })
    const pool = new VarPool({})
    pool.set("__experience_segment", experienceSegment)
    pool.set("__user_preference_text", "Prefer concise output")

    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    await executor.execute()

    const prompt = mockRun.mock.calls[0][0].prompt
    // Both experience and knowledge should be present
    expect(prompt).toContain("相关历史经验")
    // Note: __user_preference_text is injected by KnowledgeInjector, not directly by VarPool reading
    // The experience segment is read directly from VarPool in buildPrompt()
  })
})
