import { describe, it, expect } from "vitest"
import { WorkflowSchema, NodeSchema, AutoAnswerSchema, BudgetSchema } from "../types/workflow"
import { isOctopusWorkflow, parseWorkflow } from "../yaml/parser"

describe("WorkflowSchema", () => {
  it("validates minimal workflow", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "test-flow",
      nodes: [{ id: "step1", type: "bash", bash: "echo hello" }],
    })
    expect(result.success).toBe(true)
  })

  it("validates workflow with globals", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "dev-flow",
      model: "sonnet",
      engine: "claude-code",
      timeout: 600,
      variables: { org: "xzf" },
      auto_answers: [{ pattern: "*", answer: "推荐选项" }],
      nodes: [{ id: "setup", type: "bash", bash: "echo ok" }],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.auto_answers?.length).toBe(1)
    }
  })

  it("rejects workflow without name", () => {
    const result = WorkflowSchema.safeParse({ nodes: [] })
    expect(result.success).toBe(false)
  })

  it("validates loop with inner nodes", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "loop-flow",
      nodes: [{
        id: "my-loop",
        type: "loop",
        max_iterations: 3,
        nodes: [{ id: "inner", type: "bash", bash: "echo hi" }],
      }],
    })
    expect(result.success).toBe(true)
  })

  it("validates condition node", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "cond-flow",
      nodes: [{
        id: "route",
        type: "condition",
        cases: [
          { when: "$vars.x == 1", then: "deploy" },
          { when: "default", then: "end" },
        ],
      }],
    })
    expect(result.success).toBe(true)
  })

  it("validates approval node", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "approve-flow",
      nodes: [{
        id: "approve",
        type: "approval",
        options: [
          { label: "Go", value: "go" },
          { label: "Stop", value: "stop" },
        ],
      }],
    })
    expect(result.success).toBe(true)
  })

  it("validates agent node", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "agent-flow",
      nodes: [{
        id: "review",
        type: "agent",
        agent: "code-review",
        skills: ["chinese-code-review"],
        prompt: "Review this code",
      }],
    })
    expect(result.success).toBe(true)
  })

  it("validates node with depends_on", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "dag-flow",
      nodes: [
        { id: "step1", type: "bash", bash: "echo 1" },
        { id: "step2", type: "bash", bash: "echo 2", depends_on: ["step1"] },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.nodes[1].depends_on).toEqual(["step1"])
    }
  })

  it("validates agent node with model, context, auto_answers, resume_from", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "agent-flow",
      nodes: [{
        id: "review",
        type: "agent",
        agent: "code-review",
        skills: ["chinese-code-review"],
        prompt: "Review this code",
        model: "sonnet",
        context: "new",
        auto_answers: [{ pattern: "是否使用 TDD", answer: "是" }],
        resume_from: "security-scan",
      }],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.nodes[0].model).toBe("sonnet")
      expect(result.data.nodes[0].context).toBe("new")
      expect(result.data.nodes[0].resume_from).toBe("security-scan")
      expect(result.data.nodes[0].auto_answers?.length).toBe(1)
    }
  })

  it("validates loop node with while, break_when, continue_when", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "loop-flow",
      nodes: [{
        id: "my-loop",
        type: "loop",
        while: "$vars.has_more == true",
        break_when: "$vars.error_count > 3",
        continue_when: "$vars.skip == true",
        max_iterations: 10,
        nodes: [{ id: "inner", type: "bash", bash: "echo hi" }],
      }],
    })
    expect(result.success).toBe(true)
  })

  it("validates python node with inputs and outputs", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "python-flow",
      nodes: [{
        id: "calc",
        type: "python",
        python: "import json; print(json.dumps({result: 42}))",
        inputs: { x: "$vars.count" },
        outputs: { result: "$last_output" },
      }],
    })
    expect(result.success).toBe(true)
  })

  it("validates condition node with inputs", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "cond-flow",
      nodes: [{
        id: "route",
        type: "condition",
        inputs: { env: "$vars.env" },
        cases: [
          { when: "$inputs.env == 'prod'", then: "deploy" },
          { when: "default", then: "end" },
        ],
      }],
    })
    expect(result.success).toBe(true)
  })

  it("validates approval node with approval_timeout", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "approve-flow",
      nodes: [{
        id: "approve",
        type: "approval",
        options: [{ label: "Go", value: "go" }, { label: "Stop", value: "stop" }],
        approval_timeout: 300,
      }],
    })
    expect(result.success).toBe(true)
  })

  it("validates bash node with outputs mapping", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "bash-flow",
      nodes: [{
        id: "step1",
        type: "bash",
        bash: "echo hello",
        outputs: { greeting: "$last_output" },
      }],
    })
    expect(result.success).toBe(true)
  })

  it("validates node with execute_when", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "cond-exec-flow",
      nodes: [
        { id: "step1", type: "bash", bash: "echo always" },
        { id: "step2", type: "bash", bash: "echo maybe", execute_when: "$vars.run_step2 == true", depends_on: ["step1"] },
      ],
    })
    expect(result.success).toBe(true)
  })
})

describe("AutoAnswerSchema", () => {
  it("validates auto answer", () => {
    const result = AutoAnswerSchema.safeParse({ pattern: "是否使用 TDD", answer: "是" })
    expect(result.success).toBe(true)
  })
})

describe("WorkflowSchema apiVersion + kind", () => {
  it("requires apiVersion and kind fields", () => {
    const result = WorkflowSchema.safeParse({
      name: "test-flow",
      nodes: [{ id: "step1", type: "bash", bash: "echo hello" }],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const missing = result.error.issues.map(i => i.path.join("."))
      expect(missing).toContain("apiVersion")
      expect(missing).toContain("kind")
    }
  })

  it("accepts valid apiVersion and kind=Workflow", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "test-flow",
      nodes: [{ id: "step1", type: "bash", bash: "echo hello" }],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.apiVersion).toBe("octopus/v1")
      expect(result.data.kind).toBe("Workflow")
    }
  })

  it("rejects kind other than Workflow", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/v1",
      kind: "SomethingElse",
      name: "test-flow",
      nodes: [{ id: "step1", type: "bash", bash: "echo hello" }],
    })
    expect(result.success).toBe(false)
  })

  it("rejects invalid apiVersion format", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/",    // missing version number
      kind: "Workflow",
      name: "test-flow",
      nodes: [{ id: "step1", type: "bash", bash: "echo hello" }],
    })
    expect(result.success).toBe(false)
  })

  it("rejects non-octopus apiVersion", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "k8s/v1",
      kind: "Workflow",
      name: "test-flow",
      nodes: [{ id: "step1", type: "bash", bash: "echo hello" }],
    })
    expect(result.success).toBe(false)
  })
})

describe("WorkflowSchema inputs", () => {
  it("validates workflow with inputs", () => {
    const result = WorkflowSchema.safeParse({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "Deploy",
      inputs: {
        environment: { description: "部署环境", required: true, default: "dev" },
        version: { description: "版本号", required: true },
      },
      nodes: [],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.inputs?.environment.description).toBe("部署环境")
      expect(result.data.inputs?.environment.required).toBe(true)
      expect(result.data.inputs?.environment.default).toBe("dev")
      expect(result.data.inputs?.version.required).toBe(true)
      expect(result.data.inputs?.version.default).toBe("")
    }
  })

  it("validates workflow without inputs", () => {
    const result = WorkflowSchema.safeParse({ apiVersion: "octopus/v1", kind: "Workflow", name: "Test", nodes: [] })
    expect(result.success).toBe(true)
  })
})

describe("isOctopusWorkflow", () => {
  it("returns true for valid Octopus workflow YAML string", () => {
    expect(isOctopusWorkflow("apiVersion: octopus/v1\nkind: Workflow\nname: test\nnodes: []")).toBe(true)
  })

  it("returns true for YAML dict with apiVersion and kind=Workflow", () => {
    expect(isOctopusWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "test", nodes: [] })).toBe(true)
  })

  it("returns false for YAML without apiVersion", () => {
    expect(isOctopusWorkflow("kind: Workflow\nname: test\nnodes: []")).toBe(false)
  })

  it("returns false for YAML with kind != Workflow", () => {
    expect(isOctopusWorkflow("apiVersion: octopus/v1\nkind: Service\nname: test")).toBe(false)
  })

  it("returns false for random non-workflow YAML", () => {
    expect(isOctopusWorkflow("foo: bar\nbaz: 123")).toBe(false)
  })

  it("returns false for empty string", () => {
    expect(isOctopusWorkflow("")).toBe(false)
  })

  it("returns false for invalid YAML", () => {
    expect(isOctopusWorkflow(": invalid yaml {{")).toBe(false)
  })
})

describe("BudgetSchema", () => {
  const baseWorkflow = {
    apiVersion: "octopus/v1",
    kind: "Workflow",
    name: "test",
    nodes: [{ id: "step1", type: "bash", bash: "echo hello" }],
  }

  it("accepts workflow without budget (optional)", () => {
    const result = WorkflowSchema.safeParse(baseWorkflow)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.budget).toBeUndefined()
    }
  })

  it("accepts valid full budget", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      budget: {
        max_tokens: 100000,
        max_duration: 300,
        max_cost_usd: 2.0,
        alert_threshold: 0.9,
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.budget).toEqual({
        max_tokens: 100000,
        max_duration: 300,
        max_cost_usd: 2,
        alert_threshold: 0.9,
        token_counting_mode: "all",
      })
    }
  })

  it("accepts empty budget object", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      budget: {},
    })
    expect(result.success).toBe(true)
    if (result.success) {
      // alert_threshold defaults to 0.8
      expect(result.data.budget?.alert_threshold).toBe(0.8)
    }
  })

  it("applies default alert_threshold 0.8", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      budget: { max_tokens: 5000 },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.budget?.alert_threshold).toBe(0.8)
    }
  })

  it("rejects max_tokens as string", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      budget: { max_tokens: "abc" },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map(i => i.path.join("."))
      expect(paths.some(p => p.includes("max_tokens"))).toBe(true)
    }
  })

  it("rejects negative max_tokens", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      budget: { max_tokens: -1 },
    })
    expect(result.success).toBe(false)
  })

  it("rejects non-integer max_tokens", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      budget: { max_tokens: 1.5 },
    })
    expect(result.success).toBe(false)
  })

  it("accepts max_tokens with K suffix", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      budget: { max_tokens: "50K" },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.budget?.max_tokens).toBe(50000)
    }
  })

  it("accepts max_tokens with M suffix", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      budget: { max_tokens: "1.5M" },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.budget?.max_tokens).toBe(1500000)
    }
  })

  it("accepts token_counting_mode no_cache", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      budget: { max_tokens: 100000, token_counting_mode: "no_cache" },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.budget?.token_counting_mode).toBe("no_cache")
    }
  })

  it("rejects negative max_duration", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      budget: { max_duration: -10 },
    })
    expect(result.success).toBe(false)
  })

  it("rejects non-integer max_duration", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      budget: { max_duration: 1.5 },
    })
    expect(result.success).toBe(false)
  })

  it("rejects negative max_cost_usd", () => {
    const result = WorkflowSchema.safeParse({
      ...baseWorkflow,
      budget: { max_cost_usd: -0.5 },
    })
    expect(result.success).toBe(false)
  })

  it("rejects alert_threshold outside 0-1 range", () => {
    const r1 = WorkflowSchema.safeParse({
      ...baseWorkflow,
      budget: { alert_threshold: 1.5 },
    })
    expect(r1.success).toBe(false)

    const r2 = WorkflowSchema.safeParse({
      ...baseWorkflow,
      budget: { alert_threshold: -0.1 },
    })
    expect(r2.success).toBe(false)
  })

  it("accepts alert_threshold at boundaries 0 and 1", () => {
    const r1 = WorkflowSchema.safeParse({
      ...baseWorkflow,
      budget: { alert_threshold: 0 },
    })
    expect(r1.success).toBe(true)

    const r2 = WorkflowSchema.safeParse({
      ...baseWorkflow,
      budget: { alert_threshold: 1 },
    })
    expect(r2.success).toBe(true)
  })

  it("parseWorkflow throws on invalid budget with clear message", () => {
    const yaml = `
apiVersion: octopus/v1
kind: Workflow
name: test
budget:
  max_tokens: "abc"
nodes:
  - id: step1
    type: bash
    bash: echo hello
`
    expect(() => parseWorkflow(yaml)).toThrow(/budget/)
  })

  it("parseWorkflow accepts valid budget YAML", () => {
    const yaml = `
apiVersion: octopus/v1
kind: Workflow
name: test
budget:
  max_tokens: 100000
  max_duration: 300
  max_cost_usd: 2.0
  alert_threshold: 0.9
nodes:
  - id: step1
    type: bash
    bash: echo hello
`
    const wf = parseWorkflow(yaml)
    expect(wf.budget).toEqual({
      max_tokens: 100000,
      max_duration: 300,
      max_cost_usd: 2,
      alert_threshold: 0.9,
      token_counting_mode: "all",
    })
  })
})