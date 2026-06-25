import { describe, it, expect } from "vitest"
import { parsePipelineConfig } from "../yaml/pipeline-parser"

describe("Runtime Nodes Schema", () => {
  it("parses pipeline with empty runtime_nodes", () => {
    const config = parsePipelineConfig(`
apiVersion: octopus/v1
kind: Pipeline
runtime_nodes: []
`)
    expect(config.runtime_nodes).toEqual([])
  })

  it("parses pipeline with runtime bash node", () => {
    const config = parsePipelineConfig(`
apiVersion: octopus/v1
kind: Pipeline
runtime_nodes:
  - id: cleanup
    type: bash
    bash: "rm -rf tmp/"
    depends_on: [lint]
`)
    expect(config.runtime_nodes).toHaveLength(1)
    expect(config.runtime_nodes[0].id).toBe("cleanup")
    expect(config.runtime_nodes[0].type).toBe("bash")
    expect(config.runtime_nodes[0].bash).toBe("rm -rf tmp/")
    expect(config.runtime_nodes[0].depends_on).toEqual(["lint"])
  })

  it("parses pipeline with runtime agent node", () => {
    const config = parsePipelineConfig(`
apiVersion: octopus/v1
kind: Pipeline
runtime_nodes:
  - id: analyzer
    type: agent
    prompt: "Analyze the results"
    agent: claude
    depends_on: [build, test]
    execute_when: "$vars.run_analysis == true"
    timeout: 300
`)
    expect(config.runtime_nodes).toHaveLength(1)
    expect(config.runtime_nodes[0].type).toBe("agent")
    expect(config.runtime_nodes[0].prompt).toBe("Analyze the results")
    expect(config.runtime_nodes[0].depends_on).toEqual(["build", "test"])
    expect(config.runtime_nodes[0].execute_when).toBe("$vars.run_analysis == true")
    expect(config.runtime_nodes[0].timeout).toBe(300)
  })

  it("parses pipeline with runtime python node", () => {
    const config = parsePipelineConfig(`
apiVersion: octopus/v1
kind: Pipeline
runtime_nodes:
  - id: compute
    type: python
    python: "print('hello')"
`)
    expect(config.runtime_nodes).toHaveLength(1)
    expect(config.runtime_nodes[0].type).toBe("python")
    expect(config.runtime_nodes[0].python).toBe("print('hello')")
  })

  it("defaults runtime_nodes to empty array when not specified", () => {
    const config = parsePipelineConfig(`
apiVersion: octopus/v1
kind: Pipeline
`)
    expect(config.runtime_nodes).toEqual([])
  })

  it("rejects runtime node with invalid type", () => {
    expect(() => parsePipelineConfig(`
apiVersion: octopus/v1
kind: Pipeline
runtime_nodes:
  - id: bad
    type: condition
`)).toThrow()
  })

  it("parses multiple runtime nodes", () => {
    const config = parsePipelineConfig(`
apiVersion: octopus/v1
kind: Pipeline
runtime_nodes:
  - id: cleanup
    type: bash
    bash: "echo cleanup"
  - id: notify
    type: bash
    bash: "echo notify"
    depends_on: [cleanup]
`)
    expect(config.runtime_nodes).toHaveLength(2)
    expect(config.runtime_nodes[1].depends_on).toEqual(["cleanup"])
  })
})
