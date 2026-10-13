// packages/engine/src/__tests__/loop-knowledge-mode.test.ts
//
// Review fix #3 — loop-nested agent nodes must honor knowledge.mode.
// executor-factory.ts (top-level agent case) passes
// knowledgeMode: resolveKnowledgeMode(identity.snapshotConfig) into
// AgentExecutor (ticket 12 assembly gate), but loop.ts assembled the identity
// and dropped the mode ⇒ loop-nested nodes always behaved as `both`
// (e.g. mode=inject kept recording wiki_refs). Three-state matrix asserted
// here through the observable channel (vars_update → poolSnapshot):
//   inject = 注入照常（loop 路径本就不挂注入器）+ wiki_refs 不落池
//   both   = wiki_refs 落池（缺省 = 现状）
//   query  = wiki_refs 落池
// 注入链文件零改动（红线 #1）——只在 loop 装配处补传 knowledgeMode。

import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { parseWorkflow } from "@octopus/shared"
import type { IAgentProvider } from "@octopus/providers"
import { WorkflowEngine } from "../engine"
import { IdentityResolver } from "../executors/identity-resolver"

interface CapturedCall { prompt: string }

function makeCapturingProvider(calls: CapturedCall[]): IAgentProvider {
  const finalText = `loop step done
{"vars_update":{"wiki_refs":["prj-octopus#oct-007"],"loop_summary":"refs-landed"}}`
  return {
    getType: () => "claude",
    sendQuery: async function* (prompt, _cwd, _resume, _options) {
      calls.push({ prompt })
      yield { type: "text_delta", content: finalText, messageId: "m1" }
      yield { type: "result", content: finalText, sessionId: "sess-loop-mode" }
    },
  }
}

const tmpDirs: string[] = []
function makeTmp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `loop-knowledge-mode-${label}-`))
  tmpDirs.push(dir)
  return dir
}
/** clone-init-service 落盘形态：config.json 顶层含 config 字段（票 09 双轨） */
function writeCloneConfig(home: string, name: string, cloneConfig: Record<string, unknown> | undefined): void {
  const dir = join(home, ".octopus", "agent", "built-in", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "persona.md"), "loop persona", "utf-8")
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name, config: cloneConfig ?? { model: "sonnet" } }, null, 2), "utf-8")
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

const LOOP_YAML = `apiVersion: octopus/v1
kind: Workflow
name: loop-mode-matrix
nodes:
  - id: outer
    type: loop
    max_iterations: 1
    nodes:
      - id: inner-agent
        type: agent
        as: loop-shadow-agent
        prompt: LOOP-MARKER step
`

async function runLoop(modeConfig: Record<string, unknown> | undefined) {
  const home = makeTmp("home")
  const workspace = makeTmp("ws")
  writeCloneConfig(home, "loop-shadow-agent", modeConfig)

  const wf = parseWorkflow(LOOP_YAML)
  const calls: CapturedCall[] = []
  const engine = new WorkflowEngine(wf, { claude: makeCapturingProvider(calls) }, workspace, workspace)
  engine.setIdentityResolver(new IdentityResolver({ homeDir: home }))

  const result = await engine.run()
  expect(result.status).toBe("completed")
  expect(calls.length).toBe(1)
  return result.poolSnapshot as Record<string, unknown>
}

describe("knowledge.mode — loop-nested agent node 三态矩阵（review fix #3）", () => {
  it("inject: loop 嵌套节点关闭查阅记录 —— wiki_refs 不落池，其余 vars_update 键原样", async () => {
    const pool = await runLoop({ knowledge: { mode: "inject" } })

    expect(pool.wiki_refs).toBeUndefined()
    expect(pool.loop_summary).toBe("refs-landed")
  })

  it("both（缺省）: wiki_refs 照常落池（现状零变化）", async () => {
    const pool = await runLoop({ knowledge: { mode: "both" } })

    expect(pool.wiki_refs).toEqual(["prj-octopus#oct-007"])
    expect(pool.loop_summary).toBe("refs-landed")
  })

  it("分身无 knowledge 配置 = both（既有 loop 工作流零变化）", async () => {
    const pool = await runLoop(undefined)

    expect(pool.wiki_refs).toEqual(["prj-octopus#oct-007"])
  })

  it("query: 查阅照常记录（loop 路径不挂注入器，注入侧天然无声）", async () => {
    const pool = await runLoop({ knowledge: { mode: "query" } })

    expect(pool.wiki_refs).toEqual(["prj-octopus#oct-007"])
    expect(pool.loop_summary).toBe("refs-landed")
  })
})
