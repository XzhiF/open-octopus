import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { discoverTestFixture, loadTestFixture, runTestSuite } from "../../simulator/test-runner"
import type { WorkflowDef } from "@octopus/shared"

const tmpDir = join(tmpdir(), `sim-test-${Date.now()}`)

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
})

function writeFixture(name: string, content: string): string {
  const path = join(tmpDir, name)
  writeFileSync(path, content)
  return path
}

function makeMinimalWorkflow(nodes: any[] = []): WorkflowDef {
  return {
    apiVersion: "octopus/v1",
    kind: "Workflow",
    name: "test-workflow",
    execution_mode: "serial",
    nodes: nodes.length > 0 ? nodes : [
      { id: "agent-1", type: "agent" as const },
    ],
  }
}

describe("discoverTestFixture", () => {
  it("finds test fixture by convention", () => {
    const wfPath = writeFixture("workflow.yaml", "test")
    writeFixture("workflow.test.yaml", "scenarios: []")

    const result = discoverTestFixture(wfPath)
    expect(result).toContain("workflow.test.yaml")
  })

  it("returns null when fixture doesn't exist", () => {
    const wfPath = writeFixture("no-fixture.yaml", "test")
    const result = discoverTestFixture(wfPath)
    expect(result).toBeNull()
  })
})

describe("loadTestFixture", () => {
  it("loads valid fixture YAML", () => {
    const path = writeFixture("valid.test.yaml", `
scenarios:
  - name: "test scenario"
    mocks:
      agent-1:
        output: "hello"
    assertions:
      status: completed
`)
    const fixture = loadTestFixture(path)
    expect(fixture.scenarios).toHaveLength(1)
    expect(fixture.scenarios[0].name).toBe("test scenario")
  })

  it("throws for missing file", () => {
    expect(() => loadTestFixture(join(tmpDir, "nonexistent.yaml"))).toThrow("not found")
  })

  it("throws for invalid YAML", () => {
    const path = writeFixture("bad.test.yaml", `
scenarios:
  - name: 123
    mocks: "not an object"
    assertions: "invalid"
`)
    expect(() => loadTestFixture(path)).toThrow("Invalid test fixture")
  })
})

describe("runTestSuite", () => {
  it("runs multiple scenarios independently", async () => {
    const workflow = makeMinimalWorkflow()
    const fixture = {
      scenarios: [
        {
          name: "scenario A",
          mocks: { "agent-1": { output: "A", outputs: { result: "A" } } },
          assertions: { status: "completed" as const, vars: {} },
        },
        {
          name: "scenario B",
          mocks: { "agent-1": { output: "B", outputs: { result: "B" } } },
          assertions: { status: "completed" as const },
        },
      ],
    }

    const result = await runTestSuite(workflow, fixture)
    expect(result.results).toHaveLength(2)
    expect(result.passedCount).toBe(2)
  })

  it("scenario B VarPool is not affected by scenario A", async () => {
    const workflow = makeMinimalWorkflow()
    const fixture = {
      scenarios: [
        {
          name: "scenario A sets var",
          mocks: { "agent-1": { update_vars: { shared_var: "from_A" } } },
          assertions: { vars: { shared_var: "from_A" } },
        },
        {
          name: "scenario B checks var absent",
          mocks: { "agent-1": { output: "B" } },
          assertions: { status: "completed" as const },
        },
      ],
    }

    const result = await runTestSuite(workflow, fixture)
    // Scenario B should NOT have shared_var from A
    const scenarioB = result.results[1]
    expect(scenarioB.poolSnapshot.shared_var).toBeUndefined()
  })

  it("returns complete SimResult with nodeResults + poolSnapshot", async () => {
    const workflow = makeMinimalWorkflow()
    const fixture = {
      scenarios: [
        {
          name: "full result",
          mocks: { "agent-1": { output: "hello", outputs: { greeting: "hello" } } },
          assertions: {
            status: "completed" as const,
            node_outputs: { "agent-1": { output: "hello" } },
          },
        },
      ],
    }

    const result = await runTestSuite(workflow, fixture)
    expect(result.results[0].nodeResults["agent-1"]).toBeDefined()
    expect(result.results[0].poolSnapshot).toBeDefined()
    expect(result.results[0].assertionReport).toBeDefined()
  })

  it("filters by scenario name", async () => {
    const workflow = makeMinimalWorkflow()
    const fixture = {
      scenarios: [
        { name: "alpha", mocks: { "agent-1": {} }, assertions: {} },
        { name: "beta", mocks: { "agent-1": {} }, assertions: {} },
      ],
    }

    const result = await runTestSuite(workflow, fixture, { scenarioFilter: "alpha" })
    expect(result.results).toHaveLength(1)
    expect(result.results[0].scenarioName).toBe("alpha")
  })

  it("throws for unknown scenario filter", async () => {
    const workflow = makeMinimalWorkflow()
    const fixture = {
      scenarios: [
        { name: "alpha", mocks: { "agent-1": {} }, assertions: {} },
      ],
    }

    await expect(
      runTestSuite(workflow, fixture, { scenarioFilter: "nonexistent" }),
    ).rejects.toThrow("not found")
  })
})
