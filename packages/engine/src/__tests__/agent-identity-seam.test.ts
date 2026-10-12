// packages/engine/src/__tests__/agent-identity-seam.test.ts
//
// LLM-WIKI P1 ticket 10 — S2 engine assembly seam.
// Full WorkflowEngine run with a capturing mock provider: agent nodes assemble
// their `as:` identity (explicit → named clone; omitted → workflow-operator)
// into the provider request trio (systemPrompt persona, skills whitelist, cwd)
// while cwd/workspace isolation stays byte-identical to the engine workspace.
//
// Fixture persona/skills are constructed under a fake HOME — expected values
// come from the fixture, not from the implementation (spec Testing Decisions).

import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { parseWorkflow, validateWorkflow } from "@octopus/shared"
import type { IAgentProvider } from "@octopus/providers"
import { WorkflowEngine } from "../engine"
import { IdentityResolver } from "../executors/identity-resolver"
import { simulateScenario } from "../simulator"
import type { TestScenario } from "../simulator/types"

const OPERATOR_PERSONA = '你是工作流执行工程师，代表 Octopus 在工作流 agent 节点中执行任务。'
const ARCHIVE_PERSONA = "# Archive analyst persona (fixture)"

interface CapturedCall {
  prompt: string
  cwd: string
  skills?: string[]
  systemPrompt?: unknown
}

function makeCapturingProvider(calls: CapturedCall[]): IAgentProvider {
  return {
    getType: () => "claude",
    sendQuery: async function* (prompt, cwd, _resume, options) {
      calls.push({ prompt, cwd, skills: options?.skills, systemPrompt: options?.systemPrompt })
      yield { type: "text_delta", content: "ok", messageId: "m1" }
      yield { type: "result", content: "ok", sessionId: "sess-seam" }
    },
  }
}

const tmpDirs: string[] = []
function makeTmp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agent-identity-seam-${label}-`))
  tmpDirs.push(dir)
  return dir
}
function writeCloneDir(home: string, kind: "built-in", name: string, persona: string, skills: string[]): void {
  const dir = join(home, ".octopus", "agent", kind, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "persona.md"), persona, "utf-8")
  for (const s of skills) {
    mkdirSync(join(dir, "skills", s), { recursive: true })
    writeFileSync(join(dir, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\nbody`, "utf-8")
  }
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

const YAML_TWO_NODES = `apiVersion: octopus/v1
kind: Workflow
name: identity-seam
nodes:
  - id: archive-step
    type: agent
    as: archive
    prompt: ARCHIVE-MARKER analyze
  - id: default-step
    type: agent
    prompt: DEFAULT-MARKER operate
`

function failureTextOf(nodeResult: { error?: string; logLines?: string[] }): string {
  return [nodeResult.error ?? "", ...(nodeResult.logLines ?? [])].join("\n")
}

function callBy(calls: CapturedCall[], marker: string): CapturedCall {
  const c = calls.find((x) => x.prompt.includes(marker))
  if (!c) throw new Error(`no captured call for ${marker}`)
  return c
}

function appendOf(systemPrompt: unknown): string {
  expect(systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" })
  return (systemPrompt as { append?: string }).append ?? ""
}

describe("agent node identity assembly — S2 engine seam", () => {
  it("explicit as: assembles persona into systemPrompt and snapshot skills into the whitelist; cwd stays the workspace", async () => {
    const home = makeTmp("home")
    const workspace = makeTmp("ws")
    writeCloneDir(home, "built-in", "archive", ARCHIVE_PERSONA, ["octo-archive-analyst"])
    writeCloneDir(home, "built-in", "workflow-operator", OPERATOR_PERSONA, ["octo-wiki"])

    const wf = parseWorkflow(YAML_TWO_NODES)
    validateWorkflow(wf)
    const calls: CapturedCall[] = []
    const engine = new WorkflowEngine(wf, { claude: makeCapturingProvider(calls) }, workspace, workspace)
    engine.setIdentityResolver(new IdentityResolver({ homeDir: home }))

    const result = await engine.run()
    expect(result.status).toBe("completed")

    // ── explicit as: archive ──
    const archCall = callBy(calls, "ARCHIVE-MARKER")
    expect(archCall.cwd).toBe(workspace) // cwd = workspace, NEVER the identity directory
    expect(appendOf(archCall.systemPrompt)).toContain(ARCHIVE_PERSONA)
    expect(appendOf(archCall.systemPrompt)).toContain("as: archive")
    expect(archCall.skills).toContain("octo-archive-analyst")

    // ── omitted as: → default workflow-operator ──
    const defCall = callBy(calls, "DEFAULT-MARKER")
    expect(defCall.cwd).toBe(workspace)
    expect(appendOf(defCall.systemPrompt)).toContain(OPERATOR_PERSONA)
    expect(defCall.skills).toEqual(["octo-wiki"])
  })

  it("unresolvable explicit as: fails the node at runtime (engine-init gate backstop)", async () => {
    const home = makeTmp("home-empty")
    const workspace = makeTmp("ws")
    writeCloneDir(home, "built-in", "workflow-operator", OPERATOR_PERSONA, ["octo-wiki"])

    const wf = parseWorkflow(`apiVersion: octopus/v1
kind: Workflow
name: identity-seam-ghost
nodes:
  - id: ghost-step
    type: agent
    as: ghost-clone
    prompt: GHOST-MARKER run
`)
    const calls: CapturedCall[] = []
    const engine = new WorkflowEngine(wf, { claude: makeCapturingProvider(calls) }, workspace, workspace)
    engine.setIdentityResolver(new IdentityResolver({ homeDir: home }))

    const result = await engine.run()

    expect(result.status).toBe("failed")
    const nodeResult = result.nodeResults["ghost-step"]
    expect(nodeResult.status).toBe("failed")
    expect(failureTextOf(nodeResult)).toMatch(/ghost-clone/)
    expect(calls).toHaveLength(0) // doomed execution never reaches the provider
  })

  it("loop-nested agent nodes inherit the same assembly semantics", async () => {
    const home = makeTmp("home")
    const workspace = makeTmp("ws")
    writeCloneDir(home, "built-in", "workflow-operator", OPERATOR_PERSONA, ["octo-wiki"])

    const wf = parseWorkflow(`apiVersion: octopus/v1
kind: Workflow
name: identity-seam-loop
nodes:
  - id: outer
    type: loop
    max_iterations: 1
    nodes:
      - id: inner-agent
        type: agent
        as: workflow-operator
        prompt: LOOP-INNER-MARKER work
`)
    const calls: CapturedCall[] = []
    const engine = new WorkflowEngine(wf, { claude: makeCapturingProvider(calls) }, workspace, workspace)
    engine.setIdentityResolver(new IdentityResolver({ homeDir: home }))

    const result = await engine.run()
    expect(result.status).toBe("completed")

    const inner = callBy(calls, "LOOP-INNER-MARKER")
    expect(inner.cwd).toBe(workspace)
    expect(appendOf(inner.systemPrompt)).toContain(OPERATOR_PERSONA)
    expect(inner.skills).toEqual(["octo-wiki"])
  })

  it("sub_workflow child agent nodes inherit the same assembly semantics", async () => {
    const home = makeTmp("home")
    const workspace = makeTmp("ws")
    writeCloneDir(home, "built-in", "workflow-operator", OPERATOR_PERSONA, ["octo-wiki"])

    const childYaml = `apiVersion: octopus/v1
kind: Workflow
name: identity-child
nodes:
  - id: child-agent
    type: agent
    prompt: CHILD-AGENT-MARKER work
`
    const childWf = parseWorkflow(childYaml)

    const wf = parseWorkflow(`apiVersion: octopus/v1
kind: Workflow
name: identity-seam-subwf
nodes:
  - id: sub
    type: sub_workflow
    workflow: identity-child
`)
    const calls: CapturedCall[] = []
    const engine = new WorkflowEngine(wf, { claude: makeCapturingProvider(calls) }, workspace, workspace)
    engine.setIdentityResolver(new IdentityResolver({ homeDir: home }))
    engine.setWorkflowResolver((name) => (name === "identity-child" ? { parsed: childWf, content: childYaml } : undefined))

    const result = await engine.run()
    expect(result.status).toBe("completed")

    const child = callBy(calls, "CHILD-AGENT-MARKER")
    expect(child.cwd).toBe(workspace)
    expect(appendOf(child.systemPrompt)).toContain(OPERATOR_PERSONA)
    expect(child.skills).toEqual(["octo-wiki"])
  })

  it("CLI-parity: factory-built resolver needs no versionResolver — fs-only resolution path", async () => {
    // Simulates the CLI shape (workflow.ts builds WorkflowEngine without
    // setVersionResolver): the ExecutorFactory constructs its IdentityResolver
    // itself, fs-only, because versionResolver is now OPTIONAL (handoff-08 gap
    // closed). Observable through an explicit as: that fs cannot find anywhere —
    // deterministic on any machine (random clone name).
    const home = makeTmp("home")
    const workspace = makeTmp("ws")
    writeCloneDir(home, "built-in", "workflow-operator", OPERATOR_PERSONA, ["octo-wiki"])

    const ghost = `cli-ghost-${process.pid}-${Date.now()}`
    const wf = parseWorkflow(`apiVersion: octopus/v1
kind: Workflow
name: identity-seam-cli
nodes:
  - id: agent-node
    type: agent
    as: ${ghost}
    prompt: CLI-PARITY-MARKER run
`)
    const calls: CapturedCall[] = []
    const engine = new WorkflowEngine(wf, { claude: makeCapturingProvider(calls) }, workspace, workspace)
    // no setVersionResolver / no setIdentityResolver — pure factory default

    const result = await engine.run()
    expect(result.status).toBe("failed")
    expect(failureTextOf(result.nodeResults["agent-node"])).toContain(ghost)
    expect(calls).toHaveLength(0)
  })

  it("simulator path accepts agent nodes carrying as: (.test.yaml deliverable — mock passthrough)", async () => {
    const wf = parseWorkflow(YAML_TWO_NODES)
    validateWorkflow(wf)

    const scenario: TestScenario = {
      name: "as-passthrough",
      mocks: {
        "archive-step": { output: "mocked archive work" },
        "default-step": { output: "mocked default work" },
      },
      assertions: { status: "completed" },
    }

    const sim = await simulateScenario(wf, scenario)
    expect(sim.status).toBe("completed")
    expect(sim.passed).toBe(true)
    expect(sim.syntaxErrors ?? []).toHaveLength(0)
  })
})
