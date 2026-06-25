import { describe, it, expect } from "vitest"
import { parseWorkflow, validateWorkflow } from "../yaml/parser"

describe("parseWorkflow", () => {
  it("parses minimal YAML dict", () => {
    const wf = parseWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "test", nodes: [{ id: "s1", type: "bash", bash: "echo" }] })
    expect(wf.name).toBe("test")
    expect(wf.nodes.length).toBe(1)
  })

  it("parses workflow with globals", () => {
    const wf = parseWorkflow({
      apiVersion: "octopus/v1",
      kind: "Workflow",
      name: "dev-flow",
      model: "sonnet",
      engine: "claude-code",
      timeout: 600,
      variables: { org: "xzf" },
      auto_answers: [{ pattern: "*", answer: "推荐选项" }],
      nodes: [{ id: "s1", type: "bash", bash: "echo ok" }],
    })
    expect(wf.model).toBe("sonnet")
    expect(wf.variables.org).toBe("xzf")
  })

  it("throws on missing name", () => {
    expect(() => parseWorkflow({ nodes: [] })).toThrow("apiVersion is required")
  })

  it("parses YAML string", () => {
    const yaml = `
apiVersion: octopus/v1
kind: Workflow
name: test-flow
model: sonnet
nodes:
  - id: step1
    type: bash
    bash: echo hello
`
    const wf = parseWorkflow(yaml)
    expect(wf.name).toBe("test-flow")
  })
})

describe("validateWorkflow", () => {
  it("rejects duplicate node ids", () => {
    const wf = parseWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "bad", nodes: [
      { id: "s1", type: "bash", bash: "echo a" },
      { id: "s1", type: "bash", bash: "echo b" },
    ]})
    expect(() => validateWorkflow(wf)).toThrow("duplicate id")
  })

  it("rejects loop without max_iterations", () => {
    const wf = parseWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "bad", nodes: [{ id: "loop", type: "loop", nodes: [] }] })
    expect(() => validateWorkflow(wf)).toThrow("max_iterations")
  })

  it("rejects bash node without bash content", () => {
    const wf = parseWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "bad", nodes: [{ id: "s1", type: "bash" }] })
    expect(() => validateWorkflow(wf)).toThrow("bash content required")
  })

  it("rejects python node without python content", () => {
    const wf = parseWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "bad", nodes: [{ id: "s1", type: "python" }] })
    expect(() => validateWorkflow(wf)).toThrow("python content required")
  })

  it("rejects agent node without agent name, prompt, or agents", () => {
    const wf = parseWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "bad", nodes: [{ id: "s1", type: "agent" }] })
    expect(() => validateWorkflow(wf)).toThrow("agent name, prompt, goal, or agents required")
  })

  it("accepts agent node with prompt only", () => {
    const wf = parseWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "ok", nodes: [{ id: "s1", type: "agent", prompt: "do stuff" }] })
    expect(() => validateWorkflow(wf)).not.toThrow()
  })

  it("accepts agent node with agents definition", () => {
    const wf = parseWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "ok", nodes: [
      { id: "s1", type: "agent", agents: { scanner: { description: "Scanner", prompt: "Scan code" } } },
    ]})
    expect(() => validateWorkflow(wf)).not.toThrow()
  })

  it("rejects agents definition without description", () => {
    expect(() => parseWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "bad", nodes: [
      { id: "s1", type: "agent", agents: { scanner: { prompt: "Scan code" } } },
    ]})).toThrow(/description is required/)
  })

  it("rejects agents definition without prompt or agent_file", () => {
    expect(() => parseWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "bad", nodes: [
      { id: "s1", type: "agent", agents: { scanner: { description: "Scanner" } } },
    ]})).toThrow(/prompt or agent_file is required/)
  })

  it("accepts agents definition with agent_file only", () => {
    const wf = parseWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "ok", nodes: [
      { id: "s1", type: "agent", agents: { scanner: { description: "Scanner", agent_file: ".claude/agents/scanner.md" } } },
    ]})
    expect(() => validateWorkflow(wf)).not.toThrow()
  })

  it("rejects condition node without cases", () => {
    const wf = parseWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "bad", nodes: [{ id: "s1", type: "condition" }] })
    expect(() => validateWorkflow(wf)).toThrow("cases required")
  })

  it("accepts valid workflow", () => {
    const wf = parseWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "ok", nodes: [{ id: "s1", type: "bash", bash: "echo" }] })
    expect(() => validateWorkflow(wf)).not.toThrow()
  })

  // swarm: debate + host.prompt without assessment
  it("rejects debate swarm with host.prompt missing assessment output", () => {
    const wf = parseWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "bad", nodes: [
      { id: "s1", type: "swarm", mode: "debate", topic: "pick one",
        experts: [
          { role: "a", prompt: "argue A" },
          { role: "b", prompt: "argue B" },
        ],
        host: { role: "host", prompt: "Synthesize the final report" },
      },
    ]})
    expect(() => validateWorkflow(wf)).toThrow(/assessment/)
  })

  it("accepts debate swarm with host.prompt containing assessment", () => {
    const wf = parseWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "ok", nodes: [
      { id: "s1", type: "swarm", mode: "debate", topic: "pick one",
        experts: [
          { role: "a", prompt: "argue A" },
          { role: "b", prompt: "argue B" },
        ],
        host: { role: "host", prompt: 'Synthesize and return { "assessment": { "consensus_score": 0.0 } }' },
      },
    ]})
    expect(() => validateWorkflow(wf)).not.toThrow()
  })

  it("accepts debate swarm without host.prompt (uses built-in)", () => {
    const wf = parseWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "ok", nodes: [
      { id: "s1", type: "swarm", mode: "debate", topic: "pick one",
        experts: [
          { role: "a", prompt: "argue A" },
          { role: "b", prompt: "argue B" },
        ],
      },
    ]})
    expect(() => validateWorkflow(wf)).not.toThrow()
  })

  it("accepts review swarm with host.prompt missing assessment", () => {
    const wf = parseWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "ok", nodes: [
      { id: "s1", type: "swarm", mode: "review", topic: "review code",
        experts: [{ role: "r", prompt: "review" }],
        host: { role: "host", prompt: "Just summarize" },
      },
    ]})
    expect(() => validateWorkflow(wf)).not.toThrow()
  })

  it("rejects swarm mode with host.prompt missing assessment", () => {
    const wf = parseWorkflow({ apiVersion: "octopus/v1", kind: "Workflow", name: "bad", nodes: [
      { id: "s1", type: "swarm", mode: "swarm", topic: "dynamic topic",
        dynamic: true, max_experts: 3,
        host: { role: "host", prompt: "Just give me the final answer" },
      },
    ]})
    expect(() => validateWorkflow(wf)).toThrow(/assessment/)
  })
})