import { describe, it, expect } from "vitest"
import { WorkflowEngine } from "../engine"
import { parseWorkflow, validateWorkflow } from "@octopus/shared"
import type { IAgentProvider } from "@octopus/providers"
import os from "os"

function makeMockProvider(): IAgentProvider {
  return {
    getType: () => "claude",
    sendQuery: async function* () {
      yield { type: "result" }
    },
  }
}

const SUBPROCESS_TIMEOUT = 15000

describe("WorkflowEngine integration", () => {
  it("executes a simple bash workflow", async () => {
    const yaml = `
apiVersion: octopus/v1
kind: Workflow
name: simple-bash
nodes:
  - id: step1
    type: bash
    bash: echo hello
  - id: step2
    type: bash
    bash: echo world
`
    const wf = parseWorkflow(yaml)
    validateWorkflow(wf)

    const mp = makeMockProvider()
    const engine = new WorkflowEngine(wf, { "claude": mp }, os.tmpdir())
    const result = await engine.run()

    expect(result.status).toBe("completed")
    expect(result.nodeResults["step1"]).toBeDefined()
    expect(result.nodeResults["step2"]).toBeDefined()
    expect(result.nodeResults["step1"].status).toBe("completed")
    expect(result.nodeResults["step2"].status).toBe("completed")
  }, SUBPROCESS_TIMEOUT)

  it("executes workflow with variables", async () => {
    const yaml = `
apiVersion: octopus/v1
kind: Workflow
name: vars-flow
variables:
  org: xzf
  env: prod
nodes:
  - id: setup
    type: bash
    bash: echo org=$vars.org env=$vars.env
    outputs:
      result: $last_output
`
    const wf = parseWorkflow(yaml)
    const mp = makeMockProvider()
    const engine = new WorkflowEngine(wf, { "claude": mp }, os.tmpdir())
    const result = await engine.run()

    expect(result.status).toBe("completed")
    expect(result.nodeResults["setup"].outputs.result).toContain("xzf")
    expect(result.poolSnapshot.org).toBe("xzf")
  }, SUBPROCESS_TIMEOUT)

  it("handles bash node failure", async () => {
    const yaml = `
apiVersion: octopus/v1
kind: Workflow
name: fail-flow
execution_mode: serial
nodes:
  - id: fail
    type: bash
    bash: exit 1
  - id: after
    type: bash
    bash: echo after
`
    const wf = parseWorkflow(yaml)
    const mp = makeMockProvider()
    const engine = new WorkflowEngine(wf, { "claude": mp }, os.tmpdir())
    const result = await engine.run()

    expect(result.status).toBe("failed")
    expect(result.nodeResults["fail"].status).toBe("failed")
    expect(result.nodeResults["after"]).toBeUndefined()
  }, SUBPROCESS_TIMEOUT)

  it("executes python node", async () => {
    const yaml = `
apiVersion: octopus/v1
kind: Workflow
name: python-flow
nodes:
  - id: calc
    type: python
    python: |
      import json
      print(json.dumps({"result": 42}))
    outputs:
      result: $last_output
`
    const wf = parseWorkflow(yaml)
    const mp = makeMockProvider()
    const engine = new WorkflowEngine(wf, { "claude": mp }, os.tmpdir())
    const result = await engine.run()

    expect(result.status).toBe("completed")
    expect(result.nodeResults["calc"].status).toBe("completed")
  }, SUBPROCESS_TIMEOUT)

  it("routes execution via condition node", async () => {
    const yaml = `
apiVersion: octopus/v1
kind: Workflow
name: condition-flow
variables:
  mode: uat
nodes:
  - id: check
    type: condition
    cases:
      - when: $vars.mode == 'prod'
        then: deploy-prod
      - when: $vars.mode == 'uat'
        then: deploy-uat
  - id: deploy-prod
    type: bash
    bash: echo deploying to prod
  - id: deploy-uat
    type: bash
    bash: echo deploying to uat
`
    const wf = parseWorkflow(yaml)
    validateWorkflow(wf)
    const mp = makeMockProvider()
    const engine = new WorkflowEngine(wf, { "claude": mp }, os.tmpdir())
    const result = await engine.run()

    expect(result.nodeResults["check"].jumpTo).toBe("deploy-uat")
    expect(result.nodeResults["deploy-uat"]).toBeDefined()
  }, SUBPROCESS_TIMEOUT)

  it("validates workflow YAML via CLI validate", () => {
    const yaml = `
apiVersion: octopus/v1
kind: Workflow
name: valid-flow
model: pro
engine: claude-code
timeout: 600
variables:
  org: xzf
  env: prod
nodes:
  - id: setup
    type: bash
    bash: echo hello
`
    const wf = parseWorkflow(yaml)
    expect(() => validateWorkflow(wf)).not.toThrow()
  })

  it("rejects invalid workflow YAML", () => {
    const yaml = `
apiVersion: octopus/v1
kind: Workflow
name: bad-flow
nodes:
  - id: s1
    type: bash
`
    const wf = parseWorkflow(yaml)
    expect(() => validateWorkflow(wf)).toThrow("bash content required")
  })
})