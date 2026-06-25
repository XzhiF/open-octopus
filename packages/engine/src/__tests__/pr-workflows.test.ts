import { describe, it, expect } from "vitest"
import { parseWorkflow, validateWorkflow } from "@octopus/shared"
import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const workflowsDir = join(__dirname, "..", "..", "..", "core-pack", "presets", "workflows")

const v2YamlPath = join(workflowsDir, "octopus-dev-s1-pr-flow.yaml")
const reviewYamlPath = join(workflowsDir, "octopus-dev-s2-cr-flow.yaml")

// ─── YAML Validation Tests ───────────────────────────────────────────

describe("octopus-dev-s1-pr-flow YAML Validation", () => {
  const yaml = readFileSync(v2YamlPath, "utf-8")

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
    expect(wf.name).toBe("octopus-dev-s1-pr-flow")
    expect(wf.model).toBe("opus[1m]")
    expect(wf.engine).toBe("claude")
    expect(wf.execution_mode).toBe("serial")
    expect(wf.timeout).toBe(86400)
  })

  it("defines all required inputs", () => {
    const wf = parseWorkflow(yaml)
    expect(wf.inputs).toBeDefined()
    expect(wf.inputs!.requirement).toBeDefined()
    expect(wf.inputs!.requirement.required).toBe(true)
    expect(wf.inputs!.base_branch).toBeDefined()
    expect(wf.inputs!.base_branch.default).toBe("main")
    expect(wf.inputs!.run_e2e).toBeDefined()
    expect(wf.inputs!.enable_adversarial).toBeDefined()
    expect(wf.inputs!.enable_security).toBeDefined()
    expect(wf.inputs!.enable_a11y).toBeDefined()
    expect(wf.inputs!.enable_performance).toBeDefined()
  })

  it("includes pr_urls and pr_count variables", () => {
    const wf = parseWorkflow(yaml)
    expect(wf.variables).toBeDefined()
    expect(wf.variables!.pr_urls).toBe("")
    expect(wf.variables!.pr_count).toBe("0")
  })

  it("has correct node IDs and structure", () => {
    const wf = parseWorkflow(yaml)
    const nodeIds = wf.nodes.map((n: any) => n.id)

    // Phase 0: Setup
    expect(nodeIds).toContain("setup")
    // notify-setup → moved to on_node_success hook

    // Phase 1: Analyze
    expect(nodeIds).toContain("analyze")
    expect(nodeIds).toContain("challenge-analyze")
    // notify-challenge-analyze → moved to on_node_success hook
    expect(nodeIds).toContain("synthesis-analyze")
    // notify-synthesis-analyze → moved to on_node_success hook
    expect(nodeIds).toContain("notify-analyze") // kept as bash (complex conditional)

    // Phase 2: Plan
    expect(nodeIds).toContain("plan")
    expect(nodeIds).toContain("challenge-plan")
    // notify-challenge-plan → moved to on_node_success hook
    expect(nodeIds).toContain("refine-plan")
    // notify-refine-plan → moved to on_node_success hook
    expect(nodeIds).toContain("notify-plan") // kept as bash (complex conditional)

    // Phase 3: Implement
    expect(nodeIds).toContain("implement")
    // notify-implement → moved to on_node_success hook

    // Phase 4: Review
    expect(nodeIds).toContain("review")
    expect(nodeIds).toContain("review-fix")
    expect(nodeIds).toContain("notify-review")

    // Phase 5: E2E
    expect(nodeIds).toContain("e2e-test")
    expect(nodeIds).toContain("notify-e2e")
    expect(nodeIds).toContain("e2e-gate")
    expect(nodeIds).toContain("notify-e2e-fail")

    // Phase 6: Ship (multi-project PR output)
    expect(nodeIds).toContain("ship")
    expect(nodeIds).toContain("notify-ship")
  })

  it("has no duplicate node IDs", () => {
    const wf = parseWorkflow(yaml)
    const nodeIds = wf.nodes.map((n: any) => n.id)
    const uniqueIds = new Set(nodeIds)
    expect(nodeIds.length).toBe(uniqueIds.size)
  })

  it("ship node prompt includes multi-project PR collection", () => {
    const wf = parseWorkflow(yaml)
    const shipNode = wf.nodes.find((n: any) => n.id === "ship")
    expect(shipNode).toBeDefined()
    expect(shipNode!.type).toBe("agent")
    expect(shipNode!.prompt).toContain("pr_urls")
    expect(shipNode!.prompt).toContain("JSON Map")
    expect(shipNode!.prompt).toContain("pr_count")
    expect(shipNode!.prompt).toContain("遍历")
  })

  it("ship node outputs pr_urls variable", () => {
    const wf = parseWorkflow(yaml)
    const shipNode = wf.nodes.find((n: any) => n.id === "ship")
    expect(shipNode).toBeDefined()
    // The prompt instructs the agent to output pr_urls in vars_update
    expect(shipNode!.prompt).toContain('"pr_urls"')
    expect(shipNode!.prompt).toContain('"pr_count"')
    expect(shipNode!.prompt).toContain('"ship_summary"')
  })

  it("notify-ship references pr_urls and pr_count", () => {
    const wf = parseWorkflow(yaml)
    const notifyShip = wf.nodes.find((n: any) => n.id === "notify-ship")
    expect(notifyShip).toBeDefined()
    expect(notifyShip!.type).toBe("bash")
    expect(notifyShip!.bash).toContain("$vars.pr_urls")
    expect(notifyShip!.bash).toContain("$vars.pr_count")
  })

  it("has lifecycle hooks for failure, interrupt, cancel", () => {
    const wf = parseWorkflow(yaml)
    expect(wf.hooks).toBeDefined()
    expect(wf.hooks!.on_workflow_failure).toBeDefined()
    expect(wf.hooks!.on_interrupt).toBeDefined()
    expect(wf.hooks!.on_cancel).toBeDefined()
  })

  it("has providers and channels for notify subsystem", () => {
    // providers/channels are not in WorkflowSchema — check raw YAML
    expect(yaml).toContain("providers:")
    expect(yaml).toContain("hermes-cli:")
    expect(yaml).toContain("type: hermes")
    expect(yaml).toContain("channels:")
    expect(yaml).toContain("default:")
    expect(yaml).toContain("provider: hermes-cli")
  })

  it("on_workflow_failure uses notify type", () => {
    const wf = parseWorkflow(yaml)
    const hooks = wf.hooks!.on_workflow_failure!
    expect(hooks.length).toBeGreaterThan(0)
    expect(hooks[0].type).toBe("notify")
    expect(hooks[0].channel).toBeDefined()
    expect(hooks[0].template).toBeDefined()
    expect(hooks[0].template!.title).toContain("工作流失败")
  })

  it("on_node_success has notify hooks for simple notifications", () => {
    const wf = parseWorkflow(yaml)
    const hooks = wf.hooks!.on_node_success!
    expect(hooks.length).toBeGreaterThanOrEqual(6)
    const hookIds = hooks.map((h: any) => h.id)
    expect(hookIds).toContain("notify-setup")
    expect(hookIds).toContain("notify-challenge-analyze")
    expect(hookIds).toContain("notify-synthesis-analyze")
    expect(hookIds).toContain("notify-challenge-plan")
    expect(hookIds).toContain("notify-refine-plan")
    expect(hookIds).toContain("notify-implement")
    // All should be notify type
    for (const h of hooks) {
      expect(h.type).toBe("notify")
    }
  })

  it("has on_complete hook for workflow completion notification", () => {
    const wf = parseWorkflow(yaml)
    expect(wf.hooks!.on_complete).toBeDefined()
    expect(wf.hooks!.on_complete!.length).toBeGreaterThan(0)
    expect(wf.hooks!.on_complete![0].type).toBe("notify")
  })

  it("has auto_answers configured for unattended mode", () => {
    const wf = parseWorkflow(yaml)
    expect(wf.auto_answers).toBeDefined()
    expect(wf.auto_answers!.length).toBeGreaterThan(0)
    expect(wf.auto_answers![0].pattern).toBe(".*")
    expect(wf.auto_answers![0].answer).toBe("proceed")
  })

  it("has condition nodes with valid targets", () => {
    const wf = parseWorkflow(yaml)
    const nodeIds = new Set(wf.nodes.map((n: any) => n.id))

    const conditionNodes = wf.nodes.filter((n: any) => n.type === "condition")
    for (const cn of conditionNodes) {
      expect(cn.cases).toBeDefined()
      for (const c of cn.cases!) {
        if (c.when !== "default") {
          expect(c.when).toBeTruthy()
        }
        expect(nodeIds.has(c.then)).toBe(true)
      }
    }
  })

  it("dependency chain has no cycles (topological sort)", () => {
    const wf = parseWorkflow(yaml)
    const nodeMap = new Map<string, any>()
    for (const n of wf.nodes) {
      nodeMap.set(n.id, n)
    }

    // Simple cycle detection via DFS
    const visited = new Set<string>()
    const inStack = new Set<string>()

    function dfs(id: string): boolean {
      if (inStack.has(id)) return true // cycle found
      if (visited.has(id)) return false
      visited.add(id)
      inStack.add(id)
      const node = nodeMap.get(id)
      if (node?.depends_on) {
        for (const dep of node.depends_on) {
          if (dfs(dep)) return true
        }
      }
      inStack.delete(id)
      return false
    }

    for (const n of wf.nodes) {
      expect(dfs(n.id)).toBe(false)
    }
  })

  it("all depends_on references exist", () => {
    const wf = parseWorkflow(yaml)
    const nodeIds = new Set(wf.nodes.map((n: any) => n.id))

    for (const n of wf.nodes) {
      if (n.depends_on) {
        for (const dep of n.depends_on) {
          expect(nodeIds.has(dep)).toBe(true)
        }
      }
    }
  })

  it("execute_when nodes have valid conditional expressions", () => {
    const wf = parseWorkflow(yaml)
    const conditionalNodes = wf.nodes.filter((n: any) => n.execute_when)
    expect(conditionalNodes.length).toBeGreaterThan(0)

    for (const cn of conditionalNodes) {
      expect(cn.execute_when).toBeTruthy()
      // Should reference $inputs or $vars
      expect(cn.execute_when!).toMatch(/\$inputs\.|\$vars\./)
    }
  })
})

// ─── PR Review Flow YAML Validation ──────────────────────────────────

describe("octopus-dev-s2-cr-flow YAML Validation", () => {
  const yaml = readFileSync(reviewYamlPath, "utf-8")

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
    expect(wf.name).toBe("octopus-dev-s2-cr-flow")
    expect(wf.model).toBe("opus[1m]")
    expect(wf.engine).toBe("claude")
    expect(wf.execution_mode).toBe("serial")
    expect(wf.timeout).toBe(86400)
  })

  it("accepts pr_urls as input with parent var_pool default", () => {
    const wf = parseWorkflow(yaml)
    expect(wf.inputs).toBeDefined()
    expect(wf.inputs!.pr_urls).toBeDefined()
    expect(wf.inputs!.pr_urls.description).toContain("JSON Map")
    // Chain 模式下通过 $parent.var_pool.pr_urls 自动获取，不强制必填
    expect(wf.inputs!.pr_urls.default).toBe("$parent.var_pool.pr_urls")
  })

  it("defines all optional inputs with defaults", () => {
    const wf = parseWorkflow(yaml)
    expect(wf.inputs!.base_branch).toBeDefined()
    expect(wf.inputs!.base_branch.default).toBe("")
    expect(wf.inputs!.run_e2e).toBeDefined()
    expect(wf.inputs!.run_e2e.default).toBe("true")
    expect(wf.inputs!.run_regression).toBeDefined()
    expect(wf.inputs!.run_regression.default).toBe("false")
    expect(wf.inputs!.merge_strategy).toBeDefined()
    expect(wf.inputs!.merge_strategy.default).toBe("squash")
    expect(wf.inputs!.protected_ports).toBeDefined()
    expect(wf.inputs!.protected_ports.default).toBe("3000,3001,3098,3099")
  })

  it("includes review-specific variables", () => {
    const wf = parseWorkflow(yaml)
    expect(wf.variables).toBeDefined()
    expect(wf.variables!.pr_urls).toBe("")
    expect(wf.variables!.pr_count).toBe("0")
    expect(wf.variables!.review_results).toBe("")
    expect(wf.variables!.total_processed).toBe("0")
    expect(wf.variables!.total_fixed).toBe("0")
    expect(wf.variables!.total_pushed).toBe("0")
    expect(wf.variables!.total_skipped).toBe("0")
    expect(wf.variables!.total_failed).toBe("0")
  })

  it("has correct node structure", () => {
    const wf = parseWorkflow(yaml)
    const nodeIds = wf.nodes.map((n: any) => n.id)

    // Phase 0: Setup
    expect(nodeIds).toContain("setup")
    // notify-setup → moved to on_node_success hook

    // Phase 1: Orchestrator
    expect(nodeIds).toContain("pr-review-orchestrator")
    expect(nodeIds).toContain("notify-review-done")

    // Phase 2: Final
    expect(nodeIds).toContain("final-notify")
  })

  it("has no duplicate node IDs", () => {
    const wf = parseWorkflow(yaml)
    const nodeIds = wf.nodes.map((n: any) => n.id)
    const uniqueIds = new Set(nodeIds)
    expect(nodeIds.length).toBe(uniqueIds.size)
  })

  it("orchestrator is a context:new agent with sub-agents", () => {
    const wf = parseWorkflow(yaml)
    const orchestrator = wf.nodes.find((n: any) => n.id === "pr-review-orchestrator")
    expect(orchestrator).toBeDefined()
    expect(orchestrator!.type).toBe("agent")
    expect(orchestrator!.context).toBe("new")
    expect(orchestrator!.timeout).toBe(86400)

    // Should have sub-agents
    expect(orchestrator!.agents).toBeDefined()
    const agentNames = Object.keys(orchestrator!.agents!)
    expect(agentNames).toContain("code-reviewer")
    expect(agentNames).toContain("product-completeness-assessor")
    expect(agentNames).toContain("business-reviewer")
    expect(agentNames).toContain("api-tester")
    expect(agentNames).toContain("vision-analyzer")
  })

  it("orchestrator uses required skills", () => {
    const wf = parseWorkflow(yaml)
    const orchestrator = wf.nodes.find((n: any) => n.id === "pr-review-orchestrator")
    expect(orchestrator!.skills).toBeDefined()
    expect(orchestrator!.skills).toContain("chinese-code-review")
    expect(orchestrator!.skills).toContain("systematic-debugging")
    expect(orchestrator!.skills).toContain("verification-before-completion")
  })

  it("orchestrator prompt includes all 7 steps", () => {
    const wf = parseWorkflow(yaml)
    const orchestrator = wf.nodes.find((n: any) => n.id === "pr-review-orchestrator")
    const prompt = orchestrator!.prompt as string

    // Step 1: Full-Codebase Review
    expect(prompt).toContain("Step 1")
    expect(prompt).toContain("Full-Codebase Review")

    // Step 2: Document Review
    expect(prompt).toContain("Step 2")
    expect(prompt).toContain("Document Review")

    // Step 3: Fetch & Merge Main
    expect(prompt).toContain("Step 3")
    expect(prompt).toContain("Fetch & Merge Main")

    // Step 4: Apply Modifications
    expect(prompt).toContain("Step 4")
    expect(prompt).toContain("Apply Modifications")

    // Step 5: PR E2E Testing
    expect(prompt).toContain("Step 5")
    expect(prompt).toContain("PR E2E Testing")

    // Step 6: Regression Testing
    expect(prompt).toContain("Step 6")
    expect(prompt).toContain("Regression Testing")

    // Step 7: Push
    expect(prompt).toContain("Step 7")
    expect(prompt).toContain("Push")
  })

  it("orchestrator prompt includes conflict resolution strategies", () => {
    const wf = parseWorkflow(yaml)
    const orchestrator = wf.nodes.find((n: any) => n.id === "pr-review-orchestrator")
    const prompt = orchestrator!.prompt as string

    expect(prompt).toContain("分支 a")
    expect(prompt).toContain("分支 b")
    expect(prompt).toContain("分支 c")
    expect(prompt).toContain("双向分析")
    expect(prompt).toContain("兼备")
    expect(prompt).toContain("矛盾")
  })

  it("orchestrator prompt outputs correct JSON format", () => {
    const wf = parseWorkflow(yaml)
    const orchestrator = wf.nodes.find((n: any) => n.id === "pr-review-orchestrator")
    const prompt = orchestrator!.prompt as string

    expect(prompt).toContain("vars_update")
    expect(prompt).toContain("review_results")
    expect(prompt).toContain("total_processed")
    expect(prompt).toContain("total_fixed")
    expect(prompt).toContain("total_pushed")
    expect(prompt).toContain("total_skipped")
    expect(prompt).toContain("total_failed")
  })

  it("setup node detects main branch for each project", () => {
    const wf = parseWorkflow(yaml)
    const setupNode = wf.nodes.find((n: any) => n.id === "setup")
    expect(setupNode).toBeDefined()
    expect(setupNode!.type).toBe("agent")
    expect(setupNode!.prompt).toContain("DEFAULT_BRANCH")
    expect(setupNode!.prompt).toContain("main")
    expect(setupNode!.prompt).toContain("master")
    expect(setupNode!.prompt).toContain("develop")
  })

  it("setup node installs superpowers-zh and agency-agents-zh", () => {
    const wf = parseWorkflow(yaml)
    const setupNode = wf.nodes.find((n: any) => n.id === "setup")
    expect(setupNode!.prompt).toContain("superpowers-zh")
    expect(setupNode!.prompt).toContain("agency-agents-zh")
  })

  it("final-notify handles success, partial, and failed states", () => {
    const wf = parseWorkflow(yaml)
    const finalNotify = wf.nodes.find((n: any) => n.id === "final-notify")
    expect(finalNotify).toBeDefined()
    expect(finalNotify!.type).toBe("bash")
    expect(finalNotify!.bash).toContain("completed")
    expect(finalNotify!.bash).toContain("partial")
    expect(finalNotify!.bash).toContain("failed")
    expect(finalNotify!.bash).toContain("__status")
  })

  it("has lifecycle hooks for failure, interrupt, cancel", () => {
    const wf = parseWorkflow(yaml)
    expect(wf.hooks).toBeDefined()
    expect(wf.hooks!.on_workflow_failure).toBeDefined()
    expect(wf.hooks!.on_interrupt).toBeDefined()
    expect(wf.hooks!.on_cancel).toBeDefined()

    // on_workflow_failure now uses notify type
    const failureHook = wf.hooks!.on_workflow_failure![0]
    expect(failureHook.type).toBe("notify")
    expect(failureHook.template!.body).toContain("$vars.total_processed")
    expect(failureHook.template!.body).toContain("$vars.pr_count")
  })

  it("dependency chain is valid (no cycles)", () => {
    const wf = parseWorkflow(yaml)
    const nodeMap = new Map<string, any>()
    for (const n of wf.nodes) {
      nodeMap.set(n.id, n)
    }

    const visited = new Set<string>()
    const inStack = new Set<string>()

    function dfs(id: string): boolean {
      if (inStack.has(id)) return true
      if (visited.has(id)) return false
      visited.add(id)
      inStack.add(id)
      const node = nodeMap.get(id)
      if (node?.depends_on) {
        for (const dep of node.depends_on) {
          if (dfs(dep)) return true
        }
      }
      inStack.delete(id)
      return false
    }

    for (const n of wf.nodes) {
      expect(dfs(n.id)).toBe(false)
    }
  })

  it("all depends_on references exist", () => {
    const wf = parseWorkflow(yaml)
    const nodeIds = new Set(wf.nodes.map((n: any) => n.id))

    for (const n of wf.nodes) {
      if (n.depends_on) {
        for (const dep of n.depends_on) {
          expect(nodeIds.has(dep)).toBe(true)
        }
      }
    }
  })

  it("has auto_answers configured for unattended mode", () => {
    const wf = parseWorkflow(yaml)
    expect(wf.auto_answers).toBeDefined()
    expect(wf.auto_answers!.length).toBeGreaterThan(0)
    expect(wf.auto_answers![0].answer).toBe("proceed")
  })

  it("Hermes notifications reference correct variables", () => {
    const wf = parseWorkflow(yaml)

    // notify-setup moved to on_node_success hook
    const notifySetupHook = wf.hooks!.on_node_success!.find((h: any) => h.id === "notify-setup")
    expect(notifySetupHook).toBeDefined()
    expect(notifySetupHook!.type).toBe("notify")
    expect(notifySetupHook!.template!.body).toContain("$vars.pr_count")

    // notify-review-done is still a bash node
    const notifyReviewDone = wf.nodes.find((n: any) => n.id === "notify-review-done")
    expect(notifyReviewDone!.bash).toContain("$vars.total_processed")
    expect(notifyReviewDone!.bash).toContain("$vars.total_fixed")
    expect(notifyReviewDone!.bash).toContain("$vars.total_pushed")
  })

  it("has providers and channels for notify subsystem", () => {
    expect(yaml).toContain("providers:")
    expect(yaml).toContain("hermes-cli:")
    expect(yaml).toContain("type: hermes")
    expect(yaml).toContain("channels:")
    expect(yaml).toContain("provider: hermes-cli")
  })

  it("on_node_success has notify hooks for setup and regression", () => {
    const wf = parseWorkflow(yaml)
    const hooks = wf.hooks!.on_node_success!
    const hookIds = hooks.map((h: any) => h.id)
    expect(hookIds).toContain("notify-setup")
    expect(hookIds).toContain("notify-regression")
    for (const h of hooks) {
      expect(h.type).toBe("notify")
    }
  })

  it("has on_complete hook for workflow completion notification", () => {
    const wf = parseWorkflow(yaml)
    expect(wf.hooks!.on_complete).toBeDefined()
    expect(wf.hooks!.on_complete!.length).toBeGreaterThan(0)
    expect(wf.hooks!.on_complete![0].type).toBe("notify")
  })
})

// ─── Cross-Workflow Compatibility ────────────────────────────────────

describe("Cross-Workflow Compatibility (Dev Flow → PR Review Flow)", () => {
  const v2Yaml = readFileSync(v2YamlPath, "utf-8")
  const reviewYaml = readFileSync(reviewYamlPath, "utf-8")

  it("dev-flow outputs pr_urls that review-fix-flow accepts as input", () => {
    const v2Wf = parseWorkflow(v2Yaml)
    const reviewWf = parseWorkflow(reviewYaml)

    // Dev flow should have pr_urls variable and explicit outputs on ship node
    expect(v2Wf.variables!.pr_urls).toBeDefined()
    const shipNode = v2Wf.nodes.find((n: any) => n.id === "ship")
    expect(shipNode!.outputs).toBeDefined()
    expect(shipNode!.outputs!.pr_urls).toBe("$vars.pr_urls")

    // Review flow accepts pr_urls with $parent.var_pool default for chain execution
    expect(reviewWf.inputs!.pr_urls).toBeDefined()
    expect(reviewWf.inputs!.pr_urls.default).toBe("$parent.var_pool.pr_urls")
  })

  it("dev-flow ship node output format matches review-fix-flow input expectations", () => {
    const v2Wf = parseWorkflow(v2Yaml)
    const shipNode = v2Wf.nodes.find((n: any) => n.id === "ship")

    // Ship should output pr_urls as JSON Map
    expect(shipNode!.prompt).toContain("pr_urls")
    expect(shipNode!.prompt).toContain("JSON")

    // Review flow setup should parse JSON Map
    const reviewWf = parseWorkflow(reviewYaml)
    const setupNode = reviewWf.nodes.find((n: any) => n.id === "setup")
    expect(setupNode!.prompt).toContain("JSON Map")
  })

  it("both workflows use the same notify_target convention", () => {
    const v2Wf = parseWorkflow(v2Yaml)
    const reviewWf = parseWorkflow(reviewYaml)

    expect(v2Wf.variables!.notify_target).toBe("telegram:xzf_hermes")
    expect(reviewWf.variables!.notify_target).toBe("telegram:xzf_hermes")
  })

  it("both workflows use the same workspace_rules pattern", () => {
    const v2Wf = parseWorkflow(v2Yaml)
    const reviewWf = parseWorkflow(reviewYaml)

    expect(v2Wf.variables!.workspace_rules).toContain("工作空间规范")
    expect(reviewWf.variables!.workspace_rules).toContain("工作空间规范")
    expect(v2Wf.variables!.workspace_rules).toContain("projects/")
    expect(reviewWf.variables!.workspace_rules).toContain("projects/")
  })

  it("s2 orchestrator prompt uses octopus notify instead of hermes send", () => {
    const reviewWf = parseWorkflow(reviewYaml)
    const orchestrator = reviewWf.nodes.find((n: any) => n.id === "pr-review-orchestrator")
    const prompt = orchestrator!.prompt as string

    // All inline notifications should use octopus notify
    expect(prompt).toContain("octopus notify")
    expect(prompt).toContain("--ignore-failure")
    // hermes send should NOT be in the orchestrator prompt
    expect(prompt).not.toContain("hermes send")
  })

  it("bash notification nodes use octopus notify instead of hermes send", () => {
    // s1 YAML
    expect(v2Yaml).toContain("octopus notify")
    // Only on_interrupt/on_cancel hooks should still use hermes send
    const hermesOccurrences = (v2Yaml.match(/hermes send -t/g) || []).length
    expect(hermesOccurrences).toBe(2) // on_interrupt + on_cancel

    // s2 YAML
    expect(reviewYaml).toContain("octopus notify")
    const reviewHermesOccurrences = (reviewYaml.match(/hermes send -t/g) || []).length
    expect(reviewHermesOccurrences).toBe(2) // on_interrupt + on_cancel
  })
})
