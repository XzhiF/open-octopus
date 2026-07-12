import { describe, it, expect } from "vitest"
import { parseWorkflow, validateWorkflow } from "@octopus/shared"
import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const workflowsDir = join(__dirname, "..", "..", "..", "core-pack", "workflows")

const promptYamlPath = join(workflowsDir, "octopus-wf-e2e-tester.yaml")
const goalYamlPath = join(workflowsDir, "octopus-wf-e2e-tester-goal.yaml")

const EXPECTED_NODE_IDS = [
  "setup-env",
  "orchestrator",
  "notify-orchestrator",
  "final-verify",
  "verify-gate",
  "cleanup",
  "preserve-for-debug",
  "final-notify",
]

const EXPECTED_INPUTS = [
  "target_workflows", "test_requirement", "org", "repos", "workspace_name",
  "protected_ports", "max_fix_rounds", "max_workspace_rebuilds", "keep_on_failure",
]

const EXPECTED_VARS = [
  "all_passed", "build_ok", "conclusion", "display_name",
  "evidence_snapshot", "failed_details", "fix_log",
  "notify_target", "per_execution_status",
  "rebuild_count", "rebuild_log", "root_execution_id",
  "server_pid", "server_port",
  "tested_execution_ids", "total_rounds",
  "verification_details", "verification_status",
  "web_port", "workspace_id",
]

const EXPECTED_SUB_AGENTS = ["workspace-manager", "diagnostician", "evidence-collector", "reality-checker", "shipper"]

// ─── Prompt Mode ─────────────────────────────────────────────────────

describe("octopus-wf-e2e-tester (Prompt Mode) YAML Validation", () => {
  const yaml = readFileSync(promptYamlPath, "utf-8")

  it("parses without errors", () => {
    const wf = parseWorkflow(yaml)
    expect(wf).toBeDefined()
    expect(wf.apiVersion).toBe("octopus/v1")
    expect(wf.kind).toBe("Workflow")
  })

  it("validates without errors", () => {
    const wf = parseWorkflow(yaml)
    expect(() => validateWorkflow(wf)).not.toThrow()
  })

  it("has correct name and metadata", () => {
    const wf = parseWorkflow(yaml)
    expect(wf.name).toBe("octopus-wf-e2e-tester")
    expect(wf.model).toBe("pro-max")
    expect(wf.engine).toBe("claude")
    expect(wf.execution_mode).toBe("serial")
    expect(wf.timeout).toBe(86400)
  })

  it("defines all required inputs with smart defaults", () => {
    const wf = parseWorkflow(yaml)
    for (const inputName of EXPECTED_INPUTS) {
      expect(wf.inputs, `missing input: ${inputName}`).toHaveProperty(inputName)
    }
    expect(wf.inputs!.target_workflows.required).toBe(true)
    // org/repos/workspace_name 留空由 agent 智能推断
    expect(wf.inputs!.org.default).toBe("")
    expect(wf.inputs!.repos.default).toBe("")
    expect(wf.inputs!.workspace_name.default).toBe("")
    expect(wf.inputs!.test_requirement.default).toBe("")
    expect(wf.inputs!.protected_ports.default).toBe("3000,3001,3098,3099")
    expect(wf.inputs!.max_fix_rounds.default).toBe("5")
    expect(wf.inputs!.max_workspace_rebuilds.default).toBe("2")
  })

  it("target_workflows description mentions workflow name format", () => {
    const wf = parseWorkflow(yaml)
    const desc = wf.inputs!.target_workflows.description
    expect(desc).toContain("工作流名称")
    expect(desc).toContain("逗号分隔")
    expect(desc).toContain("config.json")
  })

  it("test_requirement description mentions priority over target_workflows inputs", () => {
    const wf = parseWorkflow(yaml)
    const desc = wf.inputs!.test_requirement.description
    expect(desc).toContain("优先级")
  })

  it("defines all expected variables", () => {
    const wf = parseWorkflow(yaml)
    for (const v of EXPECTED_VARS) {
      expect(wf.variables, `missing variable: ${v}`).toHaveProperty(v)
    }
    expect(wf.variables!.notify_target).toBe("telegram:xzf_hermes")
  })

  it("has all expected node IDs", () => {
    const wf = parseWorkflow(yaml)
    const nodeIds = wf.nodes.map((n: any) => n.id)
    for (const id of EXPECTED_NODE_IDS) {
      expect(nodeIds, `missing node: ${id}`).toContain(id)
    }
  })

  it("has no duplicate node IDs", () => {
    const wf = parseWorkflow(yaml)
    const nodeIds = wf.nodes.map((n: any) => n.id)
    expect(nodeIds.length).toBe(new Set(nodeIds).size)
  })

  it("setup-env uses goal mode with constraints", () => {
    const wf = parseWorkflow(yaml)
    const node = wf.nodes.find((n: any) => n.id === "setup-env")
    expect(node!.type).toBe("agent")
    expect(node!.goal).toBeDefined()
    expect(node!.constraints).toBeDefined()
    expect(node!.constraints!.length).toBeGreaterThan(0)
    expect(node!.planning).toBeDefined()
  })

  it("setup-env goal includes superpowers-zh and agency-agents-zh installation", () => {
    const wf = parseWorkflow(yaml)
    const node = wf.nodes.find((n: any) => n.id === "setup-env")
    const goal = node!.goal as string
    expect(goal).toContain("superpowers-zh")
    expect(goal).toContain("agency-agents-zh")
  })

  it("orchestrator has workspace-manager sub-agent with smart inference", () => {
    const wf = parseWorkflow(yaml)
    const node = wf.nodes.find((n: any) => n.id === "orchestrator")
    expect(node!.agents).toBeDefined()
    const wm = node!.agents!["workspace-manager"]
    expect(wm).toBeDefined()
    const prompt = wm.prompt as string
    // octopus 项目校验
    expect(prompt).toContain("octopus")
    // 两种 target_workflows 格式
    expect(prompt).toContain("工作流名称")
    expect(prompt).toContain("JSON 数组")
    // 智能推断
    expect(prompt).toContain("test_requirement")
    expect(prompt).toContain("优先")
    // 工作流拷贝
    expect(prompt).toContain("拷贝")
  })

  it("orchestrator uses prompt + agents with 5 sub-agents", () => {
    const wf = parseWorkflow(yaml)
    const node = wf.nodes.find((n: any) => n.id === "orchestrator")
    expect(node!.type).toBe("agent")
    expect(node!.prompt).toBeDefined()
    expect(node!.agents).toBeDefined()

    const agentNames = Object.keys(node!.agents!)
    for (const name of EXPECTED_SUB_AGENTS) {
      expect(agentNames, `missing sub-agent: ${name}`).toContain(name)
    }
  })

  it("orchestrator sub-agents have agent_file references", () => {
    const wf = parseWorkflow(yaml)
    const node = wf.nodes.find((n: any) => n.id === "orchestrator")
    const agents = node!.agents!

    expect(agents.diagnostician.agent_file).toContain("engineering-software-architect")
    expect(agents["evidence-collector"].agent_file).toContain("testing-evidence-collector")
    expect(agents["reality-checker"].agent_file).toContain("testing-reality-checker")
  })

  it("orchestrator prompt includes octopus notify notification instructions", () => {
    const wf = parseWorkflow(yaml)
    const node = wf.nodes.find((n: any) => n.id === "orchestrator")
    const prompt = node!.prompt as string
    expect(prompt).toContain("octopus notify")
    expect(prompt).toContain("--ignore-failure")
  })

  it("orchestrator prompt includes workspace rebuild and octopus project logic", () => {
    const wf = parseWorkflow(yaml)
    const node = wf.nodes.find((n: any) => n.id === "orchestrator")
    const prompt = node!.prompt as string
    expect(prompt).toContain("ENVIRONMENT_CORRUPT")
    expect(prompt).toContain("WORKSPACE_CONFIG_ERROR")
    expect(prompt).toContain("workspace-manager")
    expect(prompt).toContain("rebuild_count")
    expect(prompt).toContain("max_workspace_rebuilds")
  })

  it("orchestrator prompt includes anti-fake-run rules", () => {
    const wf = parseWorkflow(yaml)
    const node = wf.nodes.find((n: any) => n.id === "orchestrator")
    const prompt = node!.prompt as string
    expect(prompt).toContain("禁止跳过")
    expect(prompt).toContain("真实")
    expect(prompt).toContain("reality-checker")
  })

  it("skills are correctly assigned per node", () => {
    const wf = parseWorkflow(yaml)
    // setup-env: verification-before-completion only
    const setup = wf.nodes.find((n: any) => n.id === "setup-env")
    expect(setup!.skills).toContain("verification-before-completion")
    expect(setup!.skills).not.toContain("systematic-debugging")

    // orchestrator: systematic-debugging + verification-before-completion + dispatching-parallel-agents
    const orch = wf.nodes.find((n: any) => n.id === "orchestrator")
    expect(orch!.skills).toContain("systematic-debugging")
    expect(orch!.skills).toContain("verification-before-completion")
    expect(orch!.skills).toContain("dispatching-parallel-agents")

    // final-verify: verification-before-completion only
    const verify = wf.nodes.find((n: any) => n.id === "final-verify")
    expect(verify!.skills).toContain("verification-before-completion")
  })

  it("final-verify uses prompt mode", () => {
    const wf = parseWorkflow(yaml)
    const node = wf.nodes.find((n: any) => n.id === "final-verify")
    expect(node!.type).toBe("agent")
    expect(node!.prompt).toBeDefined()
    expect(node!.prompt).toContain("verification_status")
  })

  it("has complete lifecycle hooks including on_complete", () => {
    const wf = parseWorkflow(yaml)
    expect(wf.hooks).toBeDefined()
    expect(wf.hooks!.on_workflow_failure).toBeDefined()
    expect(wf.hooks!.on_interrupt).toBeDefined()
    expect(wf.hooks!.on_cancel).toBeDefined()
    expect(wf.hooks!.on_complete).toBeDefined()

    // on_workflow_failure uses notify type
    const failureHook = wf.hooks!.on_workflow_failure![0]
    expect(failureHook.type).toBe("notify")

    // on_complete uses octopus notify via bash
    const completeHook = wf.hooks!.on_complete![0]
    expect(completeHook.bash).toContain("octopus notify")
    expect(completeHook.bash).toContain("$vars.all_passed")
  })

  it("verify-gate routes correctly", () => {
    const wf = parseWorkflow(yaml)
    const gate = wf.nodes.find((n: any) => n.id === "verify-gate")
    expect(gate!.type).toBe("condition")
    expect(gate!.cases!.length).toBe(2)

    const nodeIds = new Set(wf.nodes.map((n: any) => n.id))
    for (const c of gate!.cases!) {
      expect(nodeIds.has(c.then)).toBe(true)
    }
  })

  it("cleanup and preserve-for-debug have correct execute_when", () => {
    const wf = parseWorkflow(yaml)
    const cleanup = wf.nodes.find((n: any) => n.id === "cleanup")
    expect(cleanup!.execute_when).toContain('all_passed == "true"')

    const preserve = wf.nodes.find((n: any) => n.id === "preserve-for-debug")
    expect(preserve!.execute_when).toContain('all_passed != "true"')
  })

  it("dependency chain has no cycles", () => {
    const wf = parseWorkflow(yaml)
    const nodeMap = new Map<string, any>()
    for (const n of wf.nodes) nodeMap.set(n.id, n)

    const visited = new Set<string>()
    const inStack = new Set<string>()
    function dfs(id: string): boolean {
      if (inStack.has(id)) return true
      if (visited.has(id)) return false
      visited.add(id); inStack.add(id)
      const node = nodeMap.get(id)
      if (node?.depends_on) {
        for (const dep of node.depends_on) {
          if (dfs(dep)) return true
        }
      }
      inStack.delete(id)
      return false
    }
    for (const n of wf.nodes) expect(dfs(n.id)).toBe(false)
  })

  it("all depends_on references exist", () => {
    const wf = parseWorkflow(yaml)
    const nodeIds = new Set(wf.nodes.map((n: any) => n.id))
    for (const n of wf.nodes) {
      if (n.depends_on) {
        for (const dep of n.depends_on) {
          expect(nodeIds.has(dep), `${n.id} depends on missing ${dep}`).toBe(true)
        }
      }
    }
  })

  it("has auto_answers for unattended mode", () => {
    const wf = parseWorkflow(yaml)
    expect(wf.auto_answers).toBeDefined()
    expect(wf.auto_answers![0].answer).toBe("proceed")
  })

  it("phase notify nodes use octopus notify instead of hermes send", () => {
    const wf = parseWorkflow(yaml)
    const notifyNodes = wf.nodes.filter((n: any) => n.id.startsWith("notify-"))
    for (const n of notifyNodes) {
      expect(n.bash, `${n.id} missing octopus notify`).toContain("octopus notify")
      expect(n.bash, `${n.id} still uses hermes send`).not.toContain("hermes send -t")
    }
  })

  it("final-notify marks __status failed when all_passed is false", () => {
    const wf = parseWorkflow(yaml)
    const finalNotify = wf.nodes.find((n: any) => n.id === "final-notify")
    expect(finalNotify!.bash).toContain("__status")
    expect(finalNotify!.bash).toContain("failed")
  })
})

// ─── Goal Mode ───────────────────────────────────────────────────────

describe("octopus-wf-e2e-tester-goal (Goal Mode) YAML Validation", () => {
  const yaml = readFileSync(goalYamlPath, "utf-8")

  it("parses without errors", () => {
    const wf = parseWorkflow(yaml)
    expect(wf.name).toBe("octopus-wf-e2e-tester-goal")
  })

  it("validates without errors", () => {
    const wf = parseWorkflow(yaml)
    expect(() => validateWorkflow(wf)).not.toThrow()
  })

  it("has all expected node IDs", () => {
    const wf = parseWorkflow(yaml)
    const nodeIds = wf.nodes.map((n: any) => n.id)
    for (const id of EXPECTED_NODE_IDS) {
      expect(nodeIds).toContain(id)
    }
  })

  it("orchestrator uses goal + constraints + agents", () => {
    const wf = parseWorkflow(yaml)
    const node = wf.nodes.find((n: any) => n.id === "orchestrator")
    expect(node!.type).toBe("agent")
    expect(node!.goal).toBeDefined()
    expect(node!.constraints).toBeDefined()
    expect(node!.constraints!.length).toBeGreaterThan(0)
    expect(node!.planning).toBeDefined()
    // Goal mode still supports sub-agents (engine agent.ts resolveAgents() is mode-agnostic)
    expect(node!.agents).toBeDefined()

    const agentNames = Object.keys(node!.agents!)
    for (const name of EXPECTED_SUB_AGENTS) {
      expect(agentNames).toContain(name)
    }
  })

  it("orchestrator goal includes workspace rebuild requirement", () => {
    const wf = parseWorkflow(yaml)
    const node = wf.nodes.find((n: any) => n.id === "orchestrator")
    const goal = node!.goal as string
    expect(goal).toContain("清理旧环境并重建工作空间")
    expect(goal).toContain("evidence-collector")
    expect(goal).toContain("reality-checker")
    expect(goal).toContain("workspace-manager")
  })

  it("orchestrator constraints include workspace rebuild and anti-fake-run", () => {
    const wf = parseWorkflow(yaml)
    const node = wf.nodes.find((n: any) => n.id === "orchestrator")
    const constraints = node!.constraints as string[]
    const allConstraints = constraints.join(" ")
    expect(allConstraints).toContain("ENVIRONMENT_CORRUPT")
    expect(allConstraints).toContain("DELETE")
    expect(allConstraints).toContain("禁止跳过")
  })

  it("final-verify uses goal + constraints", () => {
    const wf = parseWorkflow(yaml)
    const node = wf.nodes.find((n: any) => n.id === "final-verify")
    expect(node!.type).toBe("agent")
    expect(node!.goal).toBeDefined()
    expect(node!.constraints).toBeDefined()
  })

  it("has complete lifecycle hooks including on_complete", () => {
    const wf = parseWorkflow(yaml)
    expect(wf.hooks!.on_complete).toBeDefined()
    const completeHook = wf.hooks!.on_complete![0]
    expect(completeHook.bash).toContain("octopus notify")
    expect(completeHook.bash).toContain("$vars.all_passed")
  })

  it("variables have WARNING comment about 20-key truncation", () => {
    // Verify the YAML text contains the truncation warning
    expect(yaml).toContain("Goal mode 仅注入前 20 个变量")
  })

  it("first 20 variables include all critical keys", () => {
    const wf = parseWorkflow(yaml)
    const varKeys = Object.keys(wf.variables!)
    // The first 20 keys should include the critical ones
    const first20 = varKeys.slice(0, 20)
    const criticalKeys = [
      "all_passed", "build_ok", "workspace_id", "root_execution_id",
      "server_port", "server_pid", "total_rounds", "rebuild_count",
      "fix_log", "rebuild_log", "failed_details", "conclusion",
      "notify_target", "display_name",
    ]
    for (const key of criticalKeys) {
      expect(first20, `critical key "${key}" not in first 20 vars`).toContain(key)
    }
  })

  it("dependency chain has no cycles", () => {
    const wf = parseWorkflow(yaml)
    const nodeMap = new Map<string, any>()
    for (const n of wf.nodes) nodeMap.set(n.id, n)

    const visited = new Set<string>()
    const inStack = new Set<string>()
    function dfs(id: string): boolean {
      if (inStack.has(id)) return true
      if (visited.has(id)) return false
      visited.add(id); inStack.add(id)
      const node = nodeMap.get(id)
      if (node?.depends_on) {
        for (const dep of node.depends_on) {
          if (dfs(dep)) return true
        }
      }
      inStack.delete(id)
      return false
    }
    for (const n of wf.nodes) expect(dfs(n.id)).toBe(false)
  })
})

// ─── Cross-Variant Consistency ───────────────────────────────────────

describe("Cross-variant consistency (Prompt vs Goal)", () => {
  const promptYaml = readFileSync(promptYamlPath, "utf-8")
  const goalYaml = readFileSync(goalYamlPath, "utf-8")

  it("both have identical input definitions", () => {
    const pw = parseWorkflow(promptYaml)
    const gw = parseWorkflow(goalYaml)

    const pInputs = Object.keys(pw.inputs!).sort()
    const gInputs = Object.keys(gw.inputs!).sort()
    expect(pInputs).toEqual(gInputs)
  })

  it("both have identical variable names", () => {
    const pw = parseWorkflow(promptYaml)
    const gw = parseWorkflow(goalYaml)

    const pVars = Object.keys(pw.variables!).sort()
    const gVars = Object.keys(gw.variables!).sort()
    expect(pVars).toEqual(gVars)
  })

  it("both have identical node IDs", () => {
    const pw = parseWorkflow(promptYaml)
    const gw = parseWorkflow(goalYaml)

    const pNodes = pw.nodes.map((n: any) => n.id).sort()
    const gNodes = gw.nodes.map((n: any) => n.id).sort()
    expect(pNodes).toEqual(gNodes)
  })

  it("both have identical hook event names", () => {
    const pw = parseWorkflow(promptYaml)
    const gw = parseWorkflow(goalYaml)

    const pHooks = Object.keys(pw.hooks!).sort()
    const gHooks = Object.keys(gw.hooks!).sort()
    expect(pHooks).toEqual(gHooks)
  })

  it("both use the same notify_target convention", () => {
    const pw = parseWorkflow(promptYaml)
    const gw = parseWorkflow(goalYaml)
    expect(pw.variables!.notify_target).toBe(gw.variables!.notify_target)
  })

  it("both have the same sub-agents on orchestrator", () => {
    const pw = parseWorkflow(promptYaml)
    const gw = parseWorkflow(goalYaml)

    const pOrch = pw.nodes.find((n: any) => n.id === "orchestrator")
    const gOrch = gw.nodes.find((n: any) => n.id === "orchestrator")

    const pAgents = Object.keys(pOrch!.agents!).sort()
    const gAgents = Object.keys(gOrch!.agents!).sort()
    expect(pAgents).toEqual(gAgents)
  })

  it("mode differentiation: prompt uses prompt, goal uses goal+constraints", () => {
    const pw = parseWorkflow(promptYaml)
    const gw = parseWorkflow(goalYaml)

    // Prompt mode: orchestrator has prompt field
    const pOrch = pw.nodes.find((n: any) => n.id === "orchestrator")
    expect(pOrch!.prompt).toBeDefined()
    expect(pOrch!.goal).toBeUndefined()

    // Goal mode: orchestrator has goal + constraints
    const gOrch = gw.nodes.find((n: any) => n.id === "orchestrator")
    expect(gOrch!.goal).toBeDefined()
    expect(gOrch!.constraints).toBeDefined()
    expect(gOrch!.constraints!.length).toBeGreaterThan(0)
    // Goal mode orchestrator still has agents (goal+agents is supported)
    expect(gOrch!.agents).toBeDefined()
  })

  it("mode differentiation: final-verify prompt vs goal", () => {
    const pw = parseWorkflow(promptYaml)
    const gw = parseWorkflow(goalYaml)

    const pVerify = pw.nodes.find((n: any) => n.id === "final-verify")
    expect(pVerify!.prompt).toBeDefined()
    expect(pVerify!.goal).toBeUndefined()

    const gVerify = gw.nodes.find((n: any) => n.id === "final-verify")
    expect(gVerify!.goal).toBeDefined()
    expect(gVerify!.constraints).toBeDefined()
  })
})
