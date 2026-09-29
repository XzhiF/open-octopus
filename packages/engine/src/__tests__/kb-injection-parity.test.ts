// KB-P0 止血：知识/技能注入四类缺口回归 — swarm / loop / sub_workflow / hook。
// 每类一条「注入生效」测试：mock provider 捕获最终 prompt，断言内层真正的
// agent 执行点（runExpert / 内层 AgentExecutor / 子引擎 agent / hook agent）
// 收到了与顶层 agent 节点相同的注入内容。
import { describe, it, expect } from "vitest"
import { WorkflowEngine } from "../engine"
import { KnowledgeInjector } from "../knowledge-injector"
import { PromptInjector } from "../prompt-injector"
import type { IAgentProvider } from "@octopus/providers"
import type { WorkflowDef } from "@octopus/shared"

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Capture provider: records the final prompt of every sendQuery call. */
function makeCaptureProvider(captured: string[], text = "mock result"): IAgentProvider {
  return {
    getType: () => "claude",
    sendQuery: async function* (prompt: string) {
      captured.push(prompt)
      yield { type: "message_start", messageId: "msg1" }
      yield { type: "text_delta", content: text, messageId: "msg1" }
      yield { type: "text_done", messageId: "msg1" }
      yield { type: "message_stop", messageId: "msg1" }
      yield { type: "result", content: text, sessionId: "sess-kb" }
    },
  }
}

function makeEngine(workflow: WorkflowDef, captured: string[], opts: {
  initialInputs?: Record<string, string>
  precomputeHook?: (pool: any, workflowName: string, inputs: Record<string, string>) => Promise<void>
  promptInjector?: PromptInjector
}): WorkflowEngine {
  const providers: Record<string, IAgentProvider> = { claude: makeCaptureProvider(captured) }
  return new WorkflowEngine(
    workflow,
    providers,
    "/tmp/kb-injection-test",
    undefined, // orgDir
    undefined, // callbacks
    undefined, // signal
    undefined, // executionId
    opts.initialInputs,
    undefined, // executionName
    undefined, // crossExecResolver
    opts.promptInjector,
    opts.precomputeHook,
    // 与 server 侧 createKnowledgeInjectorFactory 同构：按 pool 实例化
    (pool: any) => new KnowledgeInjector(pool),
  )
}

const wf = (name: string, nodes: any[], extra?: Record<string, any>): WorkflowDef =>
  ({ apiVersion: "octopus/v1", kind: "Workflow", name, execution_mode: "serial", nodes, ...extra }) as WorkflowDef

// ─── 基线：顶层 agent 节点（既有契约，四类缺口照此接线） ─────────────────────

describe("KB-P0 injection parity — baseline (top-level agent)", () => {
  it("top-level agent prompt carries user-preference injection", async () => {
    const captured: string[] = []
    const engine = makeEngine(
      wf("kb-top", [{ id: "a1", type: "agent", prompt: "TOP-BODY" }]),
      captured,
      { initialInputs: { __user_preference_text: "KB-PREF-TOP" } },
    )
    const result = await engine.run()
    expect(result.status).toBe("completed")
    expect(captured).toHaveLength(1)
    expect(captured[0]).toContain("## User Preferences")
    expect(captured[0]).toContain("KB-PREF-TOP")
    expect(captured[0]).toContain("TOP-BODY")
  })
})

// ─── 缺口 1：swarm —— 专家 LLM 调用经 runExpert 拿到注入 ─────────────────────

describe("KB-P0 injection parity — swarm", () => {
  it("swarm expert prompt is prepended with knowledge + skill injection", async () => {
    const captured: string[] = []
    const engine = makeEngine(
      wf("kb-swarm", [{
        id: "sw", type: "swarm", mode: "review", topic: "KB-TOPIC",
        experts: [{ role: "sec", prompt: "SWARM-EXPERT-BODY" }],
      }]),
      captured,
      {
        initialInputs: { __user_preference_text: "KB-PREF-SWARM" },
        promptInjector: new PromptInjector({ global: ["KB-GLOBAL-SKILL"], targeted: [] }),
      },
    )
    const result = await engine.run()
    expect(result.status).toBe("completed")

    const expertCall = captured.find(p => p.includes("SWARM-EXPERT-BODY"))
    expect(expertCall, "expert LLM call should reach the capture provider").toBeDefined()
    // 注入前缀 = knowledge 段 + promptInjector 段（顺序与 AgentExecutor.buildPrompt 一致）
    expect(expertCall!).toContain("## User Preferences")
    expect(expertCall!).toContain("KB-PREF-SWARM")
    expect(expertCall!).toContain("KB-GLOBAL-SKILL")
    // host 合成等引擎机制调用不吃注入 — 只断言专家调用即可
  })
})

// ─── 缺口 2：loop —— 内层 agent 节点执行点拿到注入 ──────────────────────────

describe("KB-P0 injection parity — loop", () => {
  it("loop inner agent prompt carries user-preference injection", async () => {
    const captured: string[] = []
    const engine = makeEngine(
      wf("kb-loop", [{
        id: "lp", type: "loop", max_iterations: 1, while: "true",
        nodes: [{ id: "inner", type: "agent", prompt: "LOOP-INNER-BODY" }],
      }]),
      captured,
      { initialInputs: { __user_preference_text: "KB-PREF-LOOP" } },
    )
    const result = await engine.run()
    expect(result.status).toBe("completed")

    const innerCall = captured.find(p => p.includes("LOOP-INNER-BODY"))
    expect(innerCall, "inner agent call should reach the capture provider").toBeDefined()
    expect(innerCall!).toContain("## User Preferences")
    expect(innerCall!).toContain("KB-PREF-LOOP")
    expect(captured).toHaveLength(1) // 单轮单节点
  })
})

// ─── 缺口 3：sub_workflow —— 子引擎内层 agent 拿到注入 ──────────────────────
// 关键断言用「precompute 按子流名重算」的 marker：修复前三个 undefined 硬编码，
// 子引擎既没有 precomputeHook 也没有 knowledgeInjectorFactory，marker 不可能出现。

describe("KB-P0 injection parity — sub_workflow", () => {
  it("child workflow agent prompt carries per-child precomputed knowledge", async () => {
    const captured: string[] = []
    const child = wf("kb-child", [{ id: "c-agent", type: "agent", prompt: "CHILD-AGENT-BODY" }])
    const engine = makeEngine(
      wf("kb-parent", [{ id: "sub", type: "sub_workflow", workflow: "kb-child" }]),
      captured,
      {
        // precompute 只在子引擎里注入 marker（parent 没有该 key → 排除串扰）
        precomputeHook: async (pool, workflowName) => {
          pool.set("__user_preference_text", `KB-PREF-${workflowName}`)
        },
      },
    )
    engine.setWorkflowResolver((name) => (name === "kb-child" ? { parsed: child, content: "" } : undefined))

    const result = await engine.run()
    expect(result.status).toBe("completed")

    const childCall = captured.find(p => p.includes("CHILD-AGENT-BODY"))
    expect(childCall, "child agent call should reach the capture provider").toBeDefined()
    // 子引擎自己跑了 precomputeHook（作用名 = 子流名）+ knowledgeInjectorFactory
    expect(childCall!).toContain("## User Preferences")
    expect(childCall!).toContain("KB-PREF-kb-child")
  })
})

// ─── 缺口 4：hook —— agent hook 拿到知识注入 ────────────────────────────────

describe("KB-P0 injection parity — hook", () => {
  it("on_node_success agent hook prompt carries knowledge injection (promptInjector was wired, knowledge was not)", async () => {
    const captured: string[] = []
    const engine = makeEngine(
      wf(
        "kb-hook",
        [{ id: "step1", type: "agent", prompt: "MAIN-BODY" }],
        { hooks: { on_node_success: [{ id: "kb-hook", prompt: "HOOK-BODY" }] } },
      ),
      captured,
      { initialInputs: { __user_preference_text: "KB-PREF-HOOK" } },
    )
    const result = await engine.run()
    expect(result.status).toBe("completed")

    const hookCall = captured.find(p => p.includes("HOOK-BODY"))
    expect(hookCall, "agent hook should run through the capture provider").toBeDefined()
    expect(hookCall!).toContain("## User Preferences")
    expect(hookCall!).toContain("KB-PREF-HOOK")
    // 两个调用：主节点 + hook（主节点也吃到注入，作为对照组）
    expect(captured).toHaveLength(2)
    expect(captured[0]).toContain("KB-PREF-HOOK")
  })
})
