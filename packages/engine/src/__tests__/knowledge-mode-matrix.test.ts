// packages/engine/src/__tests__/knowledge-mode-matrix.test.ts
//
// LLM-WIKI P1 ticket 12 — S2 缝测试：三态行为矩阵。
// 对 inject / query / both（+ 缺省未配置）逐一断言两件事：
//   ① 注入调用是否发生（promptInjector / knowledgeInjector 的 getInjectedPrompts）
//   ② wiki_refs 查阅记录是否落进 VarPool（经既有 vars_update → VarPool 通道）
// 期望矩阵直接来自票 12 文案（story 30），spy 观察走 runner 捕获的公开面，
// 不伸进注入链内部 —— 注入链本体（红线 #1）零改动，gate 只是装配处条件。

import { describe, it, expect, vi } from "vitest"
import { VarPool } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"
import type { AgentRunResult } from "../executors/agent-types"
import { AgentExecutor } from "../executors/agent"

const PIPELINE_MARKER = "PIPELINE-INJECT-MARKER global rule"
const KNOWLEDGE_MARKER = "## User Preferences\nKNOWLEDGE-INJECT-MARKER prefer tabs"

// 票 11 指针行约定的 vars_update 产出形态：wiki_refs 数组含 stale: 前缀条目
const WIKI_REFS_UPDATE =
  '{"vars_update":{"wiki_refs":["prj-octopus#oct-001","stale:oct-009"],"summary":"done-with-refs"}}'

interface SpyInjector {
  getInjectedPrompts: ReturnType<typeof vi.fn>
}

function makeInjectors(): { promptInjector: SpyInjector; knowledgeInjector: SpyInjector } {
  return {
    promptInjector: { getInjectedPrompts: vi.fn(() => [PIPELINE_MARKER]) },
    knowledgeInjector: { getInjectedPrompts: vi.fn(() => [KNOWLEDGE_MARKER]) },
  }
}

function makeRunner(captured: { prompt: string }[]) {
  return {
    run: vi.fn(async (opts: { prompt: string }) => {
      captured.push({ prompt: opts.prompt })
      const result: AgentRunResult = {
        finalText: WIKI_REFS_UPDATE,
        sessionId: "sess-mode",
        events: [],
        durationMs: 5,
      }
      return result
    }),
  } as any
}

function agentNode(): NodeDef {
  return { id: "mode-node", type: "agent", prompt: "TASK-BODY do the work" }
}

async function runWithMode(mode?: "inject" | "query" | "both") {
  const pool = new VarPool()
  const { promptInjector, knowledgeInjector } = makeInjectors()
  const captured: { prompt: string }[] = []
  const executor = new AgentExecutor(agentNode(), pool, {
    runner: makeRunner(captured),
    promptInjector: promptInjector as any,
    knowledgeInjector: knowledgeInjector as any,
    workflowName: "mode-wf",
    ...(mode ? { knowledgeMode: mode } : {}),
  })
  const result = await executor.execute()
  return { pool, promptInjector, knowledgeInjector, captured, result }
}

describe("knowledge.mode 三态行为矩阵（票 12 · AgentExecutor 装配闸）", () => {
  it("both（本期缺省）: 注入链原样运行 + wiki_refs 落 VarPool —— 两轨全开 = 现状字节一致", async () => {
    const { pool, promptInjector, knowledgeInjector, captured } = await runWithMode("both")

    expect(promptInjector.getInjectedPrompts).toHaveBeenCalledTimes(1)
    expect(knowledgeInjector.getInjectedPrompts).toHaveBeenCalledTimes(1)
    expect(captured[0].prompt).toContain(PIPELINE_MARKER)
    expect(captured[0].prompt).toContain("KNOWLEDGE-INJECT-MARKER")

    // wiki_refs 原样落池（数组，含 stale: 前缀条目 —— 池里保留原始 token 供导出侧筛）
    expect(pool.get("wiki_refs")).toEqual(["prj-octopus#oct-001", "stale:oct-009"])
    expect(pool.get("summary")).toBe("done-with-refs")
    expect(captured[0].prompt).toContain("TASK-BODY")
  })

  it("未配置 knowledgeMode 的既有调用面 = both（默认路径零变化）", async () => {
    const { pool, promptInjector, knowledgeInjector } = await runWithMode(undefined)

    expect(promptInjector.getInjectedPrompts).toHaveBeenCalledTimes(1)
    expect(knowledgeInjector.getInjectedPrompts).toHaveBeenCalledTimes(1)
    expect(pool.get("wiki_refs")).toEqual(["prj-octopus#oct-001", "stale:oct-009"])
  })

  it("inject（回滚开关 = 恢复现状）: 注入照常，不记录 wiki_refs —— 其余 vars 键不受影响", async () => {
    const { pool, promptInjector, knowledgeInjector, captured } = await runWithMode("inject")

    expect(promptInjector.getInjectedPrompts).toHaveBeenCalledTimes(1)
    expect(knowledgeInjector.getInjectedPrompts).toHaveBeenCalledTimes(1)
    expect(captured[0].prompt).toContain(PIPELINE_MARKER)

    expect(pool.get("wiki_refs")).toBeUndefined()
    expect(pool.get("summary")).toBe("done-with-refs") // 只摘 wiki_refs，vars_update 其余键原样
  })

  it("query（P2 预演）: 注入链不运行（injector 零调用），wiki_refs 照常记录", async () => {
    const { pool, promptInjector, knowledgeInjector, captured } = await runWithMode("query")

    expect(promptInjector.getInjectedPrompts).not.toHaveBeenCalled()
    expect(knowledgeInjector.getInjectedPrompts).not.toHaveBeenCalled()
    expect(captured[0].prompt).not.toContain(PIPELINE_MARKER)
    expect(captured[0].prompt).not.toContain("KNOWLEDGE-INJECT-MARKER")
    expect(captured[0].prompt).toContain("TASK-BODY") // 任务本体不受影响

    expect(pool.get("wiki_refs")).toEqual(["prj-octopus#oct-001", "stale:oct-009"])
  })

  it("inject 模式下 outputs.vars_update 与池一致（不谎报已记录）", async () => {
    const { result } = await runWithMode("inject")
    const outputs = result.outputs as Record<string, any>
    expect(outputs.vars_update).not.toHaveProperty("wiki_refs")
    expect(outputs.vars_update).toHaveProperty("summary", "done-with-refs")
  })
})
