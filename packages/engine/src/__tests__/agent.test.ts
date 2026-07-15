import { describe, it, expect, vi } from "vitest"
import { AgentExecutor } from "../executors/agent"
import { VarPool } from "@octopus/shared"
import type { NodeDef, AutoAnswer } from "@octopus/shared"
import type { AgentRunResult } from "../executors/agent-types"

function makeSuccessResult(finalText: string, sessionId?: string): AgentRunResult {
  return {
    finalText,
    sessionId,
    events: [],
    durationMs: 100,
  }
}

describe("AgentExecutor", () => {
  it("calls runner with correct opts", async () => {
    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("task completed", "sess1")),
    } as any

    const node: NodeDef = {
      id: "agent1",
      type: "agent",
      agent: "skill-searcher",
      prompt: "Search for skills about $vars.topic",
      skills: ["octo-skill-creator"],
      model: "claude-3-opus",
      context: "new",
    }
    const pool = new VarPool({ topic: "MCP" })
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })

    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.lastOutput).toBe("task completed")
    expect(result.sessionId).toBe("sess1")
    expect(mockRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "skill-searcher",
        prompt: expect.stringContaining("MCP"),
        model: "claude-3-opus",
        context: "new",
      }),
    )
  })

  it("injects auto_answers into prompt", async () => {
    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("done")),
    } as any

    const globalAnswers: AutoAnswer[] = [{ pattern: "是否继续?", answer: "yes" }]
    const node: NodeDef = {
      id: "agent2",
      type: "agent",
      prompt: "Do the task",
      auto_answers: [{ pattern: "请确认?", answer: "confirmed" }],
    }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, { runner: mockRunner, globalAutoAnswers: globalAnswers })

    await executor.execute()

    const builtOpts = mockRunner.run.mock.calls[0][0]
    expect(builtOpts.prompt).toContain("自动应答规则")
    expect(builtOpts.prompt).toContain("是否继续?")
    expect(builtOpts.prompt).toContain("请确认?")
  })

  it("defaults context to continue when not specified", async () => {
    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("done")),
    } as any

    const node: NodeDef = {
      id: "agent3",
      type: "agent",
      prompt: "test",
    }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })

    await executor.execute()

    expect(mockRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({ context: "continue" }),
    )
  })

  it("context: new uses no previousSessionId", async () => {
    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("done")),
    } as any

    const node: NodeDef = {
      id: "agent4",
      type: "agent",
      prompt: "test",
      context: "new",
    }
    const pool = new VarPool()
    // Engine resolves previousSessionId=undefined for context: "new"
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })

    await executor.execute()

    expect(mockRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({ context: "new", previousSessionId: undefined }),
    )
  })

  it("returns cancelled when aborted before start", async () => {
    const mockRunner = { run: vi.fn() } as any
    const controller = new AbortController()
    controller.abort()

    const node: NodeDef = { id: "agent5", type: "agent", prompt: "test" }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, { runner: mockRunner, signal: controller.signal })

    const result = await executor.execute()
    expect(result.status).toBe("cancelled")
    expect(mockRunner.run).not.toHaveBeenCalled()
  })

  it("returns failed on runner error", async () => {
    const mockRunner = {
      run: vi.fn().mockRejectedValue(new Error("runner exploded")),
    } as any

    const node: NodeDef = { id: "agent6", type: "agent", prompt: "test" }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })

    const result = await executor.execute()
    expect(result.status).toBe("failed")
    expect(result.logLines[0]).toContain("runner exploded")
  })

  it("exposes getLastActivityAt on runner", async () => {
    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult("done")),
      getLastActivityAt: vi.fn().mockReturnValue(Date.now()),
    } as any

    const node: NodeDef = { id: "hb1", type: "agent", prompt: "test" }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })

    await executor.execute()
    expect(typeof mockRunner.getLastActivityAt).toBe("function")
  })

  it("records heartbeat warning when runner is idle beyond threshold", async () => {
    const origSetInterval = globalThis.setInterval
    const origClearInterval = globalThis.clearInterval
    const capturedCallbacks: (() => void)[] = []

    globalThis.setInterval = ((fn: () => void, _ms?: number) => {
      capturedCallbacks.push(fn)
      return 999 as any
    }) as any
    globalThis.clearInterval = (() => {}) as any

    try {
      const mockRunner = {
        run: vi.fn().mockImplementation(() => new Promise(resolve => {
          setTimeout(() => resolve(makeSuccessResult("done")), 50)
        })),
        getLastActivityAt: vi.fn().mockReturnValue(Date.now() - 360_000),
      } as any

      const node: NodeDef = { id: "hb2", type: "agent", prompt: "test" }
      const pool = new VarPool()
      const executor = new AgentExecutor(node, pool, { runner: mockRunner })

      const execPromise = executor.execute()
      await new Promise(r => setTimeout(r, 10))

      for (const cb of capturedCallbacks) cb()

      const result = await execPromise
      expect(result.logLines.join("\n")).toContain("no activity")
    } finally {
      globalThis.setInterval = origSetInterval
      globalThis.clearInterval = origClearInterval
    }
  })

  it("vars_update __status=failed marks node as failed", async () => {
    const text = `Some analysis output\n{"vars_update":{"__status":"failed","e2e_summary":"3 assertions failed"}}`
    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult(text, "sess-fail")),
    } as any

    const node: NodeDef = { id: "agent7", type: "agent", prompt: "run e2e tests" }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    const result = await executor.execute()

    expect(result.status).toBe("failed")
    expect(pool.get("__status")).toBeUndefined()
    expect(pool.get("e2e_summary")).toBe("3 assertions failed")
  })

  it("vars_update without __status completes normally", async () => {
    const text = `Analysis done\n{"vars_update":{"conclusion":"all good"}}`
    const mockRunner = {
      run: vi.fn().mockResolvedValue(makeSuccessResult(text, "sess-ok")),
    } as any

    const node: NodeDef = { id: "agent8", type: "agent", prompt: "test" }
    const pool = new VarPool()
    const executor = new AgentExecutor(node, pool, { runner: mockRunner })
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(pool.get("conclusion")).toBe("all good")
  })
})