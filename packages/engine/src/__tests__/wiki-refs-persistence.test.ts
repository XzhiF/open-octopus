// packages/engine/src/__tests__/wiki-refs-persistence.test.ts
//
// LLM-WIKI P1 ticket 12 — wiki_refs 持久化环级（S2 缝约定：真实 VarPool →
// JSONL → DB 写源）。环级拆两段证明：
//   本测试（engine）：真实 WorkflowEngine + 捕获型 provider 产出票 11 约定的
//     vars_update wiki_refs（含 stale: 条目）→
//       ① VarPool：结果 poolSnapshot.wiki_refs 原样在池（ExecutionLifecycle
//          正是把它 JSON.stringify 后写 executions.var_pool —— DB 写源）；
//       ② JSONL：{orgDir}/logs/{executionId}/{nodeId}.jsonl 落盘且含 wiki_refs
//          token（执行者可追溯）。
//     全程走票 10 handoff 指定的既有 vars_update → VarPool 信道，无新信道。
//     （P4 票05 清理注：本写源的历史 server 侧读面已物理删除——查阅信道恒开，
//     落池行为本体即本测试的独立契约，不随读面消亡。）

import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { parseWorkflow } from "@octopus/shared"
import type { IAgentProvider } from "@octopus/providers"
import { WorkflowEngine } from "../engine"

const tmpDirs: string[] = []
function makeTmp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wiki-refs-persist-${label}-`))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

const REFS_LINE = '{"vars_update":{"wiki_refs":["prj-octopus#oct-001","wf-prd-impl#sop-002","stale:oct-009"]}}'

function wikiReportingProvider(): IAgentProvider {
  return {
    getType: () => "claude",
    sendQuery: async function* () {
      yield { type: "text_delta", content: `did the work\n${REFS_LINE}`, messageId: "m1" }
      yield { type: "result", content: `did the work\n${REFS_LINE}`, sessionId: "sess-persist" }
    },
  }
}

describe("wiki_refs 落 VarPool → JSONL → DB 写源（票 12 环级）", () => {
  it("默认（未配置 mode = both）执行后：poolSnapshot 携 wiki_refs（stale 条目原样保留）且 JSONL 可追溯", async () => {
    const workspace = makeTmp("ws")
    const wf = parseWorkflow(`apiVersion: octopus/v1
kind: Workflow
name: wiki-refs-persist
nodes:
  - id: doer-step
    type: agent
    prompt: PERSIST-MARKER work and report refs
`)

    const engine = new WorkflowEngine(
      wf,
      { claude: wikiReportingProvider() },
      workspace,
      workspace, // orgDir → JsonlLogger 激活：{workspace}/logs/{executionId}/
      undefined,
      undefined,
      "exec-wiki-loop",
    )

    const result = await engine.run()
    expect(result.status).toBe("completed")

    // ① VarPool → DB 写源：ExecutionLifecycle 持久化的就是这个对象
    expect(result.poolSnapshot.wiki_refs).toEqual([
      "prj-octopus#oct-001",
      "wf-prd-impl#sop-002",
      "stale:oct-009",
    ])

    // stale: 前缀条目在池中单独可筛（消费侧过滤契约，票 12 第 2 项）
    const stale = (result.poolSnapshot.wiki_refs as string[]).filter((r) => r.startsWith("stale:"))
    expect(stale).toEqual(["stale:oct-009"])

    // ② JSONL 落盘可追溯（nodeId.jsonl 含 wiki_refs token）
    const jsonlPath = join(workspace, "logs", "exec-wiki-loop", "doer-step.jsonl")
    expect(existsSync(jsonlPath)).toBe(true)
    const jsonl = readFileSync(jsonlPath, "utf-8")
    expect(jsonl).toContain("wiki_refs")
    expect(jsonl).toContain("prj-octopus#oct-001")
  })

  it("poolSnapshot 序列化-反序列化往返后 wiki_refs 完好（executions.var_pool 文本形态）", async () => {
    const workspace = makeTmp("ws")
    const wf = parseWorkflow(`apiVersion: octopus/v1
kind: Workflow
name: wiki-refs-roundtrip
nodes:
  - id: roundtrip-step
    type: agent
    prompt: ROUNDTRIP-MARKER work
`)
    const engine = new WorkflowEngine(
      wf, { claude: wikiReportingProvider() }, workspace, workspace,
      undefined, undefined, "exec-wiki-roundtrip",
    )
    const result = await engine.run()

    // ExecutionLifecycle: updateExecution(id, { var_pool: JSON.stringify(result.poolSnapshot) })
    const rowText = JSON.stringify(result.poolSnapshot)
    const revived = JSON.parse(rowText)
    expect(revived.wiki_refs).toEqual(result.poolSnapshot.wiki_refs)
    expect(revived.wiki_refs.some((r: string) => r.startsWith("stale:"))).toBe(true)
  })
})
