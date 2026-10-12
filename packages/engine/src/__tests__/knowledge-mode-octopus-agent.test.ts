// packages/engine/src/__tests__/knowledge-mode-octopus-agent.test.ts
//
// LLM-WIKI P1 ticket 12 — S2 矩阵在 octopus_agent 面的延伸：
// knowledge.mode 从身份快照 config（agent_versions / clone config.json 的
// config.knowledge.mode，票 09 双轨落盘形态）解析，经 OctopusAgentExecutor
// 透传内部 AgentExecutor，并闸住它自己的第二条 vars_update 落池路径
// （structured.vars_update → pool.update，octopus-agent.ts 既有信道，票 10
// handoff 指定的 wiki_refs 通道本身）。红线 #1：注入链文件零改动。

import { describe, it, expect, vi } from "vitest"
import { VarPool } from "@octopus/shared"
import type { NodeDef, ResolvedVersion } from "@octopus/shared"
import type { AgentRunResult } from "../executors/agent-types"
import { OctopusAgentExecutor } from "../executors/octopus-agent"

const PIPELINE_MARKER = "PIPELINE-INJECT-MARKER octopus-agent face"
const STRUCTURED_REFS_TEXT = [
  "work done",
  "```json",
  '{"status":"completed","summary":"refs reported","vars_update":{"wiki_refs":["prj-octopus#oct-007","stale:oct-009"],"task_result":"ok"}}',
  "```",
].join("\n")

function snapshotWithMode(modeJson?: string): ResolvedVersion {
  const config = modeJson
    ? { name: "shadow-agent", config: JSON.parse(modeJson) }
    : { name: "shadow-agent" }
  return {
    version: "1.0.0",
    stage: "stable",
    snapshot: { persona: "", config, skills: [] },
    fsPath: "/fake",
  }
}

async function runOctopusAgent(modeConfigJson?: string) {
  const pool = new VarPool()
  const promptInjector = { getInjectedPrompts: vi.fn(() => [PIPELINE_MARKER]) }
  const captured: { prompt: string }[] = []
  const runner = {
    run: vi.fn(async (opts: { prompt: string }) => {
      captured.push({ prompt: opts.prompt })
      const result: AgentRunResult = {
        finalText: STRUCTURED_REFS_TEXT,
        sessionId: "sess-oa",
        events: [],
        durationMs: 5,
      }
      return result
    }),
    onEvent: undefined,
  } as any

  const node: NodeDef = {
    id: "oa-1",
    type: "octopus_agent" as any,
    agent: "shadow-agent",
    task: { brief: "BRIEF-MARKER implement the shadow run" },
  } as any

  const versionResolver = {
    resolve: vi.fn(() => snapshotWithMode(modeConfigJson)),
  } as any

  const executor = new OctopusAgentExecutor(node, pool, {
    runner,
    versionResolver,
    promptInjector: promptInjector as any,
    knowledgeInjector: { getInjectedPrompts: vi.fn(() => []) } as any,
    workflowName: "octopus-mode-wf",
  } as any)

  const result = await executor.execute()
  return { pool, promptInjector, captured, result }
}

describe("knowledge.mode via identity snapshot — octopus_agent face（票 12）", () => {
  it("config.knowledge.mode=inject: 注入照常 + structured vars_update 的 wiki_refs 不落池", async () => {
    const { pool, promptInjector, captured, result } = await runOctopusAgent('{"knowledge":{"mode":"inject"}}')

    expect(result.status).toBe("completed")
    expect(captured[0].prompt).toContain(PIPELINE_MARKER)
    expect(promptInjector.getInjectedPrompts).toHaveBeenCalledTimes(1)

    expect(pool.get("wiki_refs")).toBeUndefined()
    expect(pool.get("task_result")).toBe("ok") // 其余 vars 键原样（通道不变）
    const outputs = result.outputs as Record<string, any>
    expect(outputs.vars_update).not.toHaveProperty("wiki_refs")
  })

  it("config.knowledge.mode=query: 注入链不运行，wiki_refs 照常落池", async () => {
    const { pool, promptInjector } = await runOctopusAgent('{"knowledge":{"mode":"query"}}')

    expect(promptInjector.getInjectedPrompts).not.toHaveBeenCalled()
    expect(pool.get("wiki_refs")).toEqual(["prj-octopus#oct-007", "stale:oct-009"])
  })

  it("无 knowledge 配置 = both（现状缺省：注入 + 记录双开）", async () => {
    const { pool, promptInjector } = await runOctopusAgent(undefined)

    expect(promptInjector.getInjectedPrompts).toHaveBeenCalledTimes(1)
    expect(pool.get("wiki_refs")).toEqual(["prj-octopus#oct-007", "stale:oct-009"])
  })
})
