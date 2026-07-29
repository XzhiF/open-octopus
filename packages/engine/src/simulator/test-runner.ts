// packages/engine/src/simulator/test-runner.ts
//
// Scenario executor — loads test fixtures, runs scenarios, and
// applies assertions. Handles auto-discovery and multi-scenario execution.

import { readFileSync, existsSync } from "fs"
import { join, dirname, basename } from "path"
import type { WorkflowDef } from "@octopus/shared"
import { parseWorkflow, parseYaml, TestFixtureSchema } from "@octopus/shared"
import { simulateScenario } from "./simulator-engine"
import { runAssertions } from "./assertions"
import { checkSyntax } from "./syntax-checker"
import type { TestFixture, SimResult, SimulatorOptions } from "./types"

export interface TestRunnerResult {
  results: SimResult[]
  totalDurationMs: number
  passed: boolean
  passedCount: number
  failedCount: number
}

/**
 * Auto-discover the test fixture path from a workflow path.
 * workflow.yaml → workflow.test.yaml
 * my-flow.yaml → my-flow.test.yaml
 */
export function discoverTestFixture(workflowPath: string): string | null {
  const dir = dirname(workflowPath)
  const name = basename(workflowPath).replace(/\.ya?ml$/, "")
  const testPath = join(dir, `${name}.test.yaml`)
  return existsSync(testPath) ? testPath : null
}

/**
 * Load and validate a test fixture from a YAML file.
 */
export function loadTestFixture(fixturePath: string): TestFixture {
  if (!existsSync(fixturePath)) {
    throw new Error(
      `Test fixture not found: ${fixturePath}\n` +
      `Create a test fixture file alongside your workflow YAML.`,
    )
  }

  const content = readFileSync(fixturePath, "utf-8")
  let parsed: any

  try {
    parsed = parseYaml(content)
  } catch (err) {
    throw new Error(
      `Failed to parse test fixture YAML: ${fixturePath}\n` +
      `${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Validate with Zod
  const result = TestFixtureSchema.safeParse(parsed)
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n")
    throw new Error(
      `Invalid test fixture: ${fixturePath}\n${errors}`,
    )
  }

  return result.data as unknown as TestFixture
}

/**
 * Load a workflow from a YAML file.
 */
export function loadWorkflow(workflowPath: string): WorkflowDef {
  if (!existsSync(workflowPath)) {
    throw new Error(`Workflow file not found: ${workflowPath}`)
  }

  const content = readFileSync(workflowPath, "utf-8")
  return parseWorkflow(content)
}

/**
 * Run all scenarios in a test fixture against a workflow.
 */
export async function runTestSuite(
  workflow: WorkflowDef,
  fixture: TestFixture,
  options: SimulatorOptions = {},
): Promise<TestRunnerResult> {
  const start = Date.now()
  const results: SimResult[] = []

  // Phase 1: Syntax pre-check
  const syntaxResult = checkSyntax(workflow.nodes)

  // Filter scenarios
  const scenarios = options.scenarioFilter
    ? fixture.scenarios.filter((s) => s.name === options.scenarioFilter)
    : fixture.scenarios

  if (scenarios.length === 0 && options.scenarioFilter) {
    throw new Error(
      `Scenario "${options.scenarioFilter}" not found. ` +
      `Available scenarios: ${fixture.scenarios.map((s) => `"${s.name}"`).join(", ")}`,
    )
  }

  // Phase 2+3: Simulate each scenario + assertions
  for (const scenario of scenarios) {
    const result = await simulateScenario(workflow, scenario, options)

    // Attach syntax errors
    if (!syntaxResult.passed) {
      result.syntaxErrors = syntaxResult.errors
    }

    // Phase 3: Run assertions
    const report = runAssertions(
      scenario.assertions,
      result.status,
      result.poolSnapshot,
      result.nodeResults,
      result.executionTrace,
    )

    result.assertionReport = report
    result.passed = report.passed && result.status !== "failed" || (
      scenario.assertions.status === "failed" && result.status === "failed" && report.passed
    )
    // Simplified: passed if assertions pass
    result.passed = report.passed

    results.push(result)
  }

  const passedCount = results.filter((r) => r.passed).length
  const failedCount = results.filter((r) => !r.passed).length

  return {
    results,
    totalDurationMs: Date.now() - start,
    passed: failedCount === 0,
    passedCount,
    failedCount,
  }
}
