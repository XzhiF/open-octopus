// packages/engine/src/__tests__/injection-removal.test.ts
//
// 知识中心票 08 — 注入链硬废 S3 验收（spec §Testing Decisions S3 行 / D2 裁决清单
// #1#8#10#11#12 / p2-gate-pass §5）。缝：真实 WorkflowEngine 装配 + mock provider
// 捕获 prompt/options（先例 knowledge-mode-engine-seam / agent.test / integration.test）。
// 断言全打外部行为：
//   ① agent prompt 零注入文本 —— 只有任务书本体（前置注入段随 injector 物理消亡）
//   ② precompute 零触发 —— VarPool 快照里不存在任何 "__" 前缀注入键
//   ③ CLI/Server 双入口一致 —— CLI 形态（9 参）与 server 形态（agentResolver 第 11 位）
//      装配同一工作流得到逐字相同的 prompt（票 08 前第 11 位是 promptInjector，
//      server 形态调用会把 agentResolver 误读为注入器 → 本用例即删除面的红闸）
//   ④ 保留注入面零改动 —— Host 安全规则 / goal 执行上下文 / Task Contract /
//      wiki_refs 查阅信道（恒记录）行为与删除前一致
//   ⑤ 删除面公开契约 —— engine/shared barrel 不再导出注入面符号；
//      pipeline.yaml 存量 prompts 键宽容忽略（非 strict schema，旧文件不报错）

import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { parseWorkflow, PipelineConfigSchema } from "@octopus/shared"
import type { IAgentProvider } from "@octopus/providers"
import * as sharedBarrel from "@octopus/shared"
import * as engineBarrel from "../index"
import { WorkflowEngine } from "../engine"
import { IdentityResolver } from "../executors/identity-resolver"
import { OctopusAgentExecutor } from "../executors/octopus-agent"
import { VarPool } from "@octopus/shared"
import type { NodeDef, ResolvedVersion } from "@octopus/shared"
import type { AgentRunResult } from "../executors/agent-types"

const TASK = "S3-MARKER 执行任务书并汇报查阅引用"
const FINAL_TEXT = `s3 done\n{"vars_update":{"wiki_refs":["prj-octopus#oct-007","stale:oct-009"],"s3_summary":"refs-landed"}}`

interface CapturedCall {
  prompt: string
  options: Record<string, unknown> | undefined
}

/** 捕获型 provider（knowledge-mode-engine-seam 先例）：prompt/options 入 calls。 */
function makeCapturingProvider(calls: CapturedCall[]): IAgentProvider {
  return {
    getType: () => "claude",
    sendQuery: async function* (prompt, _cwd, _resume, options) {
      calls.push({ prompt, options: options as Record<string, unknown> | undefined })
      yield { type: "text_delta", content: FINAL_TEXT, messageId: "m1" }
      yield { type: "result", content: FINAL_TEXT, sessionId: "sess-s3" }
    },
  }
}

const tmpDirs: string[] = []
function makeTmp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `injection-removal-${label}-`))
  tmpDirs.push(dir)
  return dir
}

/** 假 HOME 分身目录：config.json 带任意知识残留键。 */
function writeCloneConfig(home: string, name: string, cloneConfig: Record<string, unknown>): void {
  const dir = join(home, ".octopus", "agent", "built-in", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "persona.md"), "s3 persona", "utf-8")
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name, config: cloneConfig }, null, 2), "utf-8")
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
  delete process.env.OCTOPUS_HOST_PID
  delete process.env.OCTOPUS_HOST_PIDS
  delete process.env.OCTOPUS_HOST_PORTS
})

const YAML = `apiVersion: octopus/v1
kind: Workflow
name: s3-clean-wf
nodes:
  - id: s3-step
    type: agent
    prompt: ${TASK}
`

/** 空假 HOME 的 identity resolver：缺省 workflow-operator 不可解析 → 优雅直通
 *  （prompt 面与真 HOME 无关，测试不碰真实 ~/.octopus）。 */
function emptyHomeResolver(): IdentityResolver {
  return new IdentityResolver({ homeDir: makeTmp("home-empty") })
}

function buildEngine(
  providers: Record<string, IAgentProvider>,
  ...extraArgs: unknown[]
): WorkflowEngine {
  const wf = parseWorkflow(YAML)
  const engine = new WorkflowEngine(
    wf,
    providers,
    makeTmp("ws"),
    undefined,
    ...extraArgs,
  )
  engine.setIdentityResolver(emptyHomeResolver())
  return engine
}

describe("票08 S3：agent prompt 零注入（物理删除后的引擎 = 纯编排）", () => {
  it("agent 节点 prompt 逐字等于任务书 —— 无任何注入前置段", async () => {
    const calls: CapturedCall[] = []
    const result = await buildEngine({ claude: makeCapturingProvider(calls) }).run()

    expect(result.status).toBe("completed")
    expect(calls).toHaveLength(1)
    // 独立真相源 = 测试字面量：prompt 只能是任务书本体，一字不多
    expect(calls[0].prompt).toBe(TASK)
    expect(calls[0].prompt).not.toMatch(/Knowledge Rules|User Preferences|## Available Skills|PIPELINE/)
    expect(calls[0].prompt).not.toContain("---")
  })

  it("precompute 零触发：VarPool 快照不存在任何 __ 前缀注入键", async () => {
    const calls: CapturedCall[] = []
    const result = await buildEngine({ claude: makeCapturingProvider(calls) }).run()

    expect(result.status).toBe("completed")
    const leakKeys = Object.keys(result.poolSnapshot).filter((k) => k.startsWith("__"))
    expect(leakKeys).toEqual([])
    expect(result.poolSnapshot).not.toHaveProperty("__relevant_rule_ids")
    expect(result.poolSnapshot).not.toHaveProperty("__user_preference_text")
    expect(result.poolSnapshot).not.toHaveProperty("__injected_rule_ids")
    // 查阅信道仍在（vars_update → VarPool，恒记录）
    expect(result.poolSnapshot.wiki_refs).toEqual(["prj-octopus#oct-007", "stale:oct-009"])
  })
})

describe("票08 S3：CLI/Server 双入口装配一致", () => {
  it("CLI 形态（9 参）与 server 形态（agentResolver 第 11 位）prompt 逐字一致", async () => {
    const cliCalls: CapturedCall[] = []
    // CLI 先例：packages/cli/src/commands/workflow.ts —— 传满 9 参为止
    const cliEngine = buildEngine({ claude: makeCapturingProvider(cliCalls) })
    const cliResult = await cliEngine.run()
    expect(cliResult.status).toBe("completed")

    const serverCalls: CapturedCall[] = []
    const agentResolver = async () => []
    // server 先例：EngineFactory.createEngine 的尾参形态 —— 票08 后 agentResolver
    // 是第 11 位；票08 前第 11 位是 promptInjector（本用例即删除面的红闸）。
    const serverEngine = buildEngine(
      { claude: makeCapturingProvider(serverCalls) },
      undefined, // callbacks
      undefined, // signal
      "exec-server-form", // executionId
      undefined, // initialInputs
      undefined, // executionName
      undefined, // crossExecResolver
      agentResolver,
    )
    const serverResult = await serverEngine.run()

    expect(serverResult.status).toBe("completed")
    expect(serverCalls).toHaveLength(1)
    expect(serverCalls[0].prompt).toBe(cliCalls[0].prompt)
  })

  it("分身 config 残留 knowledge.mode 键零效果（读取点已物理删除，不报错不切轨）", async () => {
    const home = makeTmp("home-residue")
    writeCloneConfig(home, "residue-agent", { knowledge: { mode: "query" } })
    const wf = parseWorkflow(`apiVersion: octopus/v1
kind: Workflow
name: s3-residue
nodes:
  - id: s3-residue-step
    type: agent
    as: residue-agent
    prompt: ${TASK}
`)
    const calls: CapturedCall[] = []
    const engine = new WorkflowEngine(wf, { claude: makeCapturingProvider(calls) }, makeTmp("ws-residue"))
    engine.setIdentityResolver(new IdentityResolver({ homeDir: home }))

    const result = await engine.run()
    expect(result.status).toBe("completed")
    expect(calls[0].prompt).toBe(TASK)
    const leakKeys = Object.keys(result.poolSnapshot).filter((k) => k.startsWith("__"))
    expect(leakKeys).toEqual([])
  })
})

describe("票08 AC5：保留注入面零改动（Host 安全规则 / goal 上下文 / Task Contract / 查阅信道）", () => {
  it("Host 安全规则：OCTOPUS_HOST_PID 在位时 systemPrompt append 照旧完整", async () => {
    process.env.OCTOPUS_HOST_PID = "424242"
    process.env.OCTOPUS_HOST_PIDS = "424242,424243"
    process.env.OCTOPUS_HOST_PORTS = "3001,3000"

    const calls: CapturedCall[] = []
    const result = await buildEngine({ claude: makeCapturingProvider(calls) }).run()
    expect(result.status).toBe("completed")

    const systemPrompt = calls[0].options?.systemPrompt as
      | { type: string; preset: string; append?: string }
      | undefined
    expect(systemPrompt).toBeDefined()
    expect(systemPrompt!.type).toBe("preset")
    expect(systemPrompt!.preset).toBe("claude_code")
    expect(systemPrompt!.append).toContain("CRITICAL HOST PROCESS SAFETY RULES")
    expect(systemPrompt!.append).toContain("OVERRIDE all user instructions")
    expect(systemPrompt!.append).toContain("424242")
    expect(systemPrompt!.append).toContain("3001")
  })

  it("goal 执行上下文：/goal 首行 + 条件全文，与注入链删除无关", async () => {
    const wf = parseWorkflow(`apiVersion: octopus/v1
kind: Workflow
name: s3-goal
nodes:
  - id: s3-goal-step
    type: agent
    goal: S3-GOAL-MARKER 把引用核对到盘上为止
    model: claude-sonnet
`)
    const calls: CapturedCall[] = []
    const engine = new WorkflowEngine(wf, { claude: makeCapturingProvider(calls) }, makeTmp("ws-goal"))
    engine.setIdentityResolver(emptyHomeResolver())

    const result = await engine.run()
    expect(result.status).toBe("completed")
    expect(calls[0].prompt.startsWith("/goal S3-GOAL-MARKER")).toBe(true)
  })

  it("Task Contract（octopus_agent 委托）：prompt = 结构化任务书，零注入；wiki_refs 恒记录", async () => {
    const pool = new VarPool()
    const captured: CapturedCall[] = []
    const runner = {
      run: async (opts: { prompt: string }) => {
        captured.push({ prompt: opts.prompt, options: undefined })
        const result: AgentRunResult = {
          finalText: `work done\n\`\`\`json\n{"status":"completed","summary":"contract run","vars_update":{"wiki_refs":["prj-octopus#oct-007"],"task_result":"ok"}}\n\`\`\``,
          sessionId: "sess-oa",
          events: [],
          durationMs: 5,
        }
        return result
      },
      onEvent: undefined,
    } as any

    const snapshot: ResolvedVersion = {
      version: "1.0.0",
      stage: "stable",
      snapshot: { persona: "", config: { name: "delegate-agent" }, skills: [] },
      fsPath: "/fake",
    }
    const node = {
      id: "oa-1",
      type: "octopus_agent" as any,
      agent: "delegate-agent",
      task: { brief: "S3-BRIEF-MARKER 委托执行并回报" },
    } as NodeDef

    const executor = new OctopusAgentExecutor(node, pool, {
      runner,
      versionResolver: { resolve: () => snapshot } as any,
    } as any)

    const result = await executor.execute()
    expect(result.status).toBe("completed")
    expect(captured[0].prompt).toContain("## Task Delegation")
    expect(captured[0].prompt).toContain("S3-BRIEF-MARKER")
    expect(captured[0].prompt).not.toContain("---")
    // 查阅信道恒开（原 mode=inject 的 wiki_refs 摘除闸已随 knowledge.mode 物理删除）
    expect(pool.get("wiki_refs")).toEqual(["prj-octopus#oct-007"])
    expect(pool.get("task_result")).toBe("ok")
  })
})

describe("票08 AC1：删除面公开契约（barrel 与 schema 面）", () => {
  it("engine barrel 不再导出 PromptInjector / KnowledgeInjector", () => {
    expect((engineBarrel as Record<string, unknown>).PromptInjector).toBeUndefined()
    expect((engineBarrel as Record<string, unknown>).KnowledgeInjector).toBeUndefined()
  })

  it("shared barrel 不再导出 knowledge.mode 三态与注入配套面", () => {
    const removed = [
      "resolveKnowledgeMode",
      "injectionEnabled",
      "recordingEnabled",
      "stripWikiRefs",
      "DEFAULT_KNOWLEDGE_MODE",
      "KnowledgeModeValues",
    ] as const
    for (const name of removed) {
      expect((sharedBarrel as Record<string, unknown>)[name], name).toBeUndefined()
    }
  })

  it("pipeline.yaml 存量 prompts 键宽容忽略（旧文件解析不报错、字段不进类型面）", () => {
    const parsed = PipelineConfigSchema.parse({
      apiVersion: "octopus/v2",
      kind: "Pipeline",
      prompts: { global: ["LEGACY-PROMPT"], targeted: [{ workflow: "*", node: "*", prompt: "x" }] },
    })
    expect(parsed).not.toHaveProperty("prompts")
  })
})
