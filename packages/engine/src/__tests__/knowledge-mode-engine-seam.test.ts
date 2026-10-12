// packages/engine/src/__tests__/knowledge-mode-engine-seam.test.ts
//
// LLM-WIKI P1 ticket 12 — S2 缝测试（引擎级三态矩阵）：真实 WorkflowEngine +
// 捕获型 provider + 假 HOME 分身目录（config.json 带 config.knowledge.mode，
// 即票 09 clone-init 落盘形态）。断言沿票 10 seam 测试的公开面走：
//   注入侧 = provider 收到的 prompt 是否带注入标记 + KnowledgeInjector 写池的
//            __injected_rule_ids 是否出现（注入调用发生的可观察代理）
//   查阅侧 = engine 结果 poolSnapshot 中 wiki_refs 是否落池（vars_update 信道）
// 注入链文件零改动（红线 #1）——闸只在 executor-factory 装配处加条件。

import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { parseWorkflow, VarPool } from "@octopus/shared"
import type { IAgentProvider } from "@octopus/providers"
import type { KnowledgeMode } from "@octopus/shared"
import { WorkflowEngine } from "../engine"
import { PromptInjector } from "../prompt-injector"
import { KnowledgeInjector } from "../knowledge-injector"
import { IdentityResolver } from "../executors/identity-resolver"
import { assembleAgentNodeIdentity } from "../executors/identity-assembly"
import type { NodeDef } from "@octopus/shared"

const PIPELINE_MARKER = "PIPELINE-INJECT-MARKER shadow-p1"
const PREF_MARK = "PREF-MARKER prefer tabs"

interface CapturedCall { prompt: string }

function makeCapturingProvider(calls: CapturedCall[], refsId: string): IAgentProvider {
  const finalText = `shadow run done\n{"vars_update":{"wiki_refs":["prj-octopus#${refsId}","stale:oct-009"],"shadow_summary":"refs-landed"}}`
  return {
    getType: () => "claude",
    sendQuery: async function* (prompt, _cwd, _resume, _options) {
      calls.push({ prompt })
      yield { type: "text_delta", content: finalText, messageId: "m1" }
      yield { type: "result", content: finalText, sessionId: "sess-shadow" }
    },
  }
}

const tmpDirs: string[] = []
function makeTmp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `knowledge-mode-seam-${label}-`))
  tmpDirs.push(dir)
  return dir
}
function writeCloneConfig(home: string, name: string, cloneConfig: Record<string, unknown>): void {
  const dir = join(home, ".octopus", "agent", "built-in", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "persona.md"), "shadow persona", "utf-8")
  // clone-init-service 落盘形态：config.json 顶层含 config 字段（票 09 双轨）
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name, config: cloneConfig }, null, 2), "utf-8")
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

const YAML = (asName: string) => `apiVersion: octopus/v1
kind: Workflow
name: shadow-seam
nodes:
  - id: shadow-step
    type: agent
    as: ${asName}
    prompt: SHADOW-MARKER run the shadow execution
`

async function runShadow(modeConfig: Record<string, unknown> | undefined, refsId: string) {
  const home = makeTmp("home")
  const workspace = makeTmp("ws")
  writeCloneConfig(home, "shadow-agent", modeConfig ?? { model: "sonnet" })

  const wf = parseWorkflow(YAML("shadow-agent"))
  const calls: CapturedCall[] = []
  const engine = new WorkflowEngine(
    wf,
    { claude: makeCapturingProvider(calls, refsId) },
    workspace,
    workspace,
    undefined, undefined, undefined, undefined, undefined, undefined,
    new PromptInjector({ global: [PIPELINE_MARKER] }),
    async (pool) => { pool.set("__user_preference_text", PREF_MARK) },
    (pool) => new KnowledgeInjector(pool),
  )
  engine.setIdentityResolver(new IdentityResolver({ homeDir: home }))

  const result = await engine.run()
  expect(result.status).toBe("completed")
  return { calls, poolSnapshot: result.poolSnapshot }
}

describe("knowledge.mode — identity assembly exposes snapshot config（票 12 装配面）", () => {
  it("assembleAgentNodeIdentity returns the resolved snapshot config for mode resolution", () => {
    const home = makeTmp("home")
    writeCloneConfig(home, "shadow-agent", { knowledge: { mode: "query" } })
    const resolver = new IdentityResolver({ homeDir: home })
    const node: NodeDef = { id: "n", type: "agent", as: "shadow-agent", prompt: "p" }

    const assembly = assembleAgentNodeIdentity(node, resolver)

    expect(assembly.snapshotConfig).toMatchObject({ name: "shadow-agent", config: { knowledge: { mode: "query" } } })
  })
})

describe("knowledge.mode — 引擎级三态矩阵（真实注入链组件，零改动被闸）", () => {
  it("both（缺省双轨）: 注入链原样跑（prompt 带标记 + __injected_rule_ids 写池）且 wiki_refs 落池", async () => {
    const { calls, poolSnapshot } = await runShadow({ knowledge: { mode: "both" } }, "oct-001")

    expect(calls[0].prompt).toContain(PIPELINE_MARKER)
    expect(calls[0].prompt).toContain("PREF-MARKER") // KnowledgeInjector 的 pref 段照常前置
    expect(poolSnapshot.__injected_rule_ids).toBeDefined()
    expect(poolSnapshot.wiki_refs).toEqual(["prj-octopus#oct-001", "stale:oct-009"])
    expect(poolSnapshot.shadow_summary).toBe("refs-landed")
  })

  it("分身无 knowledge 配置 = both（既有工作流零变化）", async () => {
    const { calls, poolSnapshot } = await runShadow(undefined, "oct-002")

    expect(calls[0].prompt).toContain(PIPELINE_MARKER)
    expect(poolSnapshot.wiki_refs).toEqual(["prj-octopus#oct-002", "stale:oct-009"])
  })

  it("inject（回滚开关）: 注入照常，wiki_refs 不落池，其余 vars_update 键不受影响", async () => {
    const { calls, poolSnapshot } = await runShadow({ knowledge: { mode: "inject" } }, "oct-003")

    expect(calls[0].prompt).toContain(PIPELINE_MARKER)
    expect(poolSnapshot.__injected_rule_ids).toBeDefined()
    expect(poolSnapshot.wiki_refs).toBeUndefined()
    expect(poolSnapshot.shadow_summary).toBe("refs-landed")
  })

  it("query（P2 预演）: 注入链不运行（prompt 无标记、__injected_rule_ids 不写池），wiki_refs 照常", async () => {
    const { calls, poolSnapshot } = await runShadow({ knowledge: { mode: "query" } }, "oct-004")

    expect(calls[0].prompt).not.toContain(PIPELINE_MARKER)
    expect(calls[0].prompt).not.toContain("PREF-MARKER")
    expect(poolSnapshot.__injected_rule_ids).toBeUndefined() // injector 从未被调用
    expect(calls[0].prompt).toContain("SHADOW-MARKER") // 任务本体照常
    expect(poolSnapshot.wiki_refs).toEqual(["prj-octopus#oct-004", "stale:oct-009"])
  })
})

// type-level smoke: KnowledgeMode 导出可用（shared 契约面）
const _modeCheck: KnowledgeMode = "both"
void _modeCheck
