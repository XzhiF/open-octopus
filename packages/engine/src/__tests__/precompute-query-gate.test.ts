// packages/engine/src/__tests__/precompute-query-gate.test.ts
//
// Review fix #4 — precompute query-gate（spec 故事 30）：
// engine.run() 过去无条件跑 precomputeHook（注入链预计算段），mode=query 时
// 整条注入链（含 precompute）都不该运行。修复在 engine.ts 调用点加条件闸；
// precompute 本体与注入链源码/测试一字不动（红线 #1）。
//
// 有效模式 = 工作流全部 agent 节点（含 loop 嵌套）的身份 knowledge.mode：
//   · 存在任一 inject/both（或不可解析/无 agent 节点）→ 照跑（缺省路径与现状一致）
//   · 全部可解析且全为 query → 跳过
// 缝一：纯函数 precomputeShouldRun（判定表本体）；缝二：真实 WorkflowEngine.run()
// 观察 hook 调用次数（公开面，fixture HOME 分身 config 提供模式）。

import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { parseWorkflow } from "@octopus/shared"
import type { KnowledgeMode, NodeDef } from "@octopus/shared"
import type { IAgentProvider } from "@octopus/providers"
import { WorkflowEngine } from "../engine"
import { IdentityResolver } from "../executors/identity-resolver"
import { precomputeShouldRun } from "../precompute-gate"

// ── 缝一：纯函数判定表（独立期望值，不依赖任何 HOME）──────────────────

const ref = (name: string): NodeDef => ({ id: "n", type: "agent", as: name, prompt: "p" })
const modeProbe = (map: Record<string, KnowledgeMode>) => (r: string): KnowledgeMode | undefined => map[r]

describe("precomputeShouldRun — 判定表（review fix #4 纯函数）", () => {
  it("无 agent 节点 → true（现状：bash-only 流照跑，逐字节不变）", () => {
    expect(precomputeShouldRun([{ id: "b", type: "bash", bash: "echo 1" }], () => "query")).toBe(true)
  })

  it("全部 agent 为 query → false", () => {
    expect(precomputeShouldRun([ref("q1")], modeProbe({ q1: "query" }))).toBe(false)
    expect(precomputeShouldRun([ref("q1"), ref("q2")], modeProbe({ q1: "query", q2: "query" }))).toBe(false)
  })

  it("任一 agent 为 inject 或 both → true（混合流里 both 节点依赖注入数据）", () => {
    expect(precomputeShouldRun([ref("q1")], modeProbe({ q1: "both" }))).toBe(true)
    expect(precomputeShouldRun([ref("q1")], modeProbe({ q1: "inject" }))).toBe(true)
    expect(precomputeShouldRun([ref("q1"), ref("q2")], modeProbe({ q1: "query", q2: "both" }))).toBe(true)
    expect(precomputeShouldRun([ref("q1"), ref("q2")], modeProbe({ q1: "inject", q2: "query" }))).toBe(true)
  })

  it("不可解析身份（probe=undefined）→ 保守 true（缺省通道不悄悄切轨）", () => {
    expect(precomputeShouldRun([ref("ghost")], modeProbe({}))).toBe(true)
    expect(precomputeShouldRun([ref("q1"), ref("ghost")], modeProbe({ q1: "query" }))).toBe(true)
  })

  it("递归 loop 嵌套子节点（loop 里的 agent 也算数）", () => {
    const nodes: NodeDef[] = [{
      id: "outer", type: "loop", max_iterations: 1,
      nodes: [ref("inner-q")],
    } as NodeDef]
    expect(precomputeShouldRun(nodes, modeProbe({ "inner-q": "query" }))).toBe(false)
  })

  it("缺省身份节点（无 as:）按 workflow-operator 探测", () => {
    const nodes: NodeDef[] = [{ id: "legacy", type: "agent", prompt: "x" } as NodeDef]
    expect(precomputeShouldRun(nodes, modeProbe({ "workflow-operator": "query" }))).toBe(false)
    expect(precomputeShouldRun(nodes, modeProbe({ "workflow-operator": "both" }))).toBe(true)
    // 缺省分身缺失（probe undefined）→ 保守 true（存量流零变化）
    expect(precomputeShouldRun(nodes, modeProbe({}))).toBe(true)
  })
})

// ── 缝二：引擎级真实 run() ─────────────────────────────────────────────

function makeNoopProvider(): IAgentProvider {
  return {
    getType: () => "claude",
    sendQuery: async function* () {
      yield { type: "text_delta", content: "ok", messageId: "m1" }
      yield { type: "result", content: "ok", sessionId: "sess-precompute-gate" }
    },
  }
}

const tmpDirs: string[] = []
function makeTmp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `precompute-gate-${label}-`))
  tmpDirs.push(dir)
  return dir
}
function writeCloneConfig(home: string, name: string, cloneConfig: Record<string, unknown> | undefined): void {
  const dir = join(home, ".octopus", "agent", "built-in", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "persona.md"), "gate persona", "utf-8")
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name, config: cloneConfig ?? { model: "sonnet" } }, null, 2), "utf-8")
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

const AGENT_YAML = (asName: string) => `apiVersion: octopus/v1
kind: Workflow
name: precompute-gate
nodes:
  - id: step
    type: agent
    as: ${asName}
    prompt: GATE-MARKER run
`

const LOOP_AGENT_YAML = (asName: string) => `apiVersion: octopus/v1
kind: Workflow
name: precompute-gate-loop
nodes:
  - id: outer
    type: loop
    max_iterations: 1
    nodes:
      - id: inner
        type: agent
        as: ${asName}
        prompt: GATE-MARKER run
`

async function runEngine(yaml: string, home: string): Promise<{ hookCount: number; status: string }> {
  const workspace = makeTmp("ws")
  const hookCalls: string[] = []
  const precomputeHook = async (_pool: unknown, workflowName: string) => {
    hookCalls.push(workflowName)
  }
  const wf = parseWorkflow(yaml)
  const engine = new WorkflowEngine(
    wf,
    { claude: makeNoopProvider() },
    workspace,
    workspace,
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, // promptInjector
    precomputeHook,
    undefined, // knowledgeInjectorFactory
  )
  engine.setIdentityResolver(new IdentityResolver({ homeDir: home }))
  const result = await engine.run()
  return { hookCount: hookCalls.length, status: result.status }
}

describe("precomputeHook — 引擎级 query 闸（真实 run()）", () => {
  it("query: 注入链预计算不运行", async () => {
    const home = makeTmp("home")
    writeCloneConfig(home, "gate-agent", { knowledge: { mode: "query" } })
    const { hookCount, status } = await runEngine(AGENT_YAML("gate-agent"), home)
    expect(status).toBe("completed")
    expect(hookCount).toBe(0)
  })

  it("both: 照跑（缺省路径与现状一致）", async () => {
    const home = makeTmp("home")
    writeCloneConfig(home, "gate-agent", { knowledge: { mode: "both" } })
    const { hookCount, status } = await runEngine(AGENT_YAML("gate-agent"), home)
    expect(status).toBe("completed")
    expect(hookCount).toBe(1)
  })

  it("inject: 照跑（回滚开关态注入链完整运行）", async () => {
    const home = makeTmp("home")
    writeCloneConfig(home, "gate-agent", { knowledge: { mode: "inject" } })
    const { hookCount, status } = await runEngine(AGENT_YAML("gate-agent"), home)
    expect(status).toBe("completed")
    expect(hookCount).toBe(1)
  })

  it("分身无 knowledge 配置 = both：照跑（存量工作流零变化）", async () => {
    const home = makeTmp("home")
    writeCloneConfig(home, "gate-agent", undefined)
    const { hookCount, status } = await runEngine(AGENT_YAML("gate-agent"), home)
    expect(status).toBe("completed")
    expect(hookCount).toBe(1)
  })

  it("loop 嵌套 agent 同样计入有效模式（query ⇒ 不跑）", async () => {
    const home = makeTmp("home")
    writeCloneConfig(home, "gate-agent", { knowledge: { mode: "query" } })
    const { hookCount, status } = await runEngine(LOOP_AGENT_YAML("gate-agent"), home)
    expect(status).toBe("completed")
    expect(hookCount).toBe(0)
  })

  it("显式 as: 不可解析 → 节点失败但 hook 保守已跑（判定先于执行，不静默切轨）", async () => {
    const home = makeTmp("home-empty")
    const { hookCount, status } = await runEngine(AGENT_YAML("ghost-not-installed"), home)
    expect(status).toBe("failed")
    expect(hookCount).toBe(1)
  })
})
