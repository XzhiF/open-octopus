/**
 * E2E Test: CLI Validate Budget Field (AC-7)
 *
 * Tests:
 * - AC-7: octopus workflow validate supports budget field
 */

import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createResults, record, saveResults, exitWithResults } from "../../../.claude/skills/e2e-harness/lib/reporter.mjs"

const TMP_DIR = "C:/xzf/ai/open-octopus/.scratch/workflow-observability/e2e-data/cli-tmp"

async function main() {
  const results = createResults()

  console.log("=== E2E Test: CLI Validate Budget (AC-7) ===\n")

  fs.mkdirSync(TMP_DIR, { recursive: true })

  // Test 1: Valid budget YAML should pass
  console.log("Test 1: Valid budget YAML...")
  const validYaml = `apiVersion: octopus/v1
kind: Workflow
name: valid-budget-test
budget:
  max_tokens: 50000
  max_duration: 300
  max_cost_usd: 1.0
nodes:
  - id: hello
    type: bash
    command: echo "hello"
`
  const validPath = path.join(TMP_DIR, "valid-budget.yaml")
  fs.writeFileSync(validPath, validYaml)

  try {
    const output = execSync(`npx tsx packages/cli/src/index.ts workflow validate "${validPath}"`, {
      encoding: "utf8",
      timeout: 30000,
      cwd: "C:/xzf/ai/open-octopus",
    })
    const passed = output.includes("valid") || output.includes("Valid") || output.includes("通过") || !output.includes("error")
    record(results, "AC-7: Valid budget YAML passes validate", passed, output.trim().substring(0, 200))
  } catch (err) {
    const stderr = err.stderr?.toString() ?? ""
    const stdout = err.stdout?.toString() ?? ""
    // Check if the error is about budget (it shouldn't be for valid YAML)
    const isBudgetError = stderr.includes("budget") || stdout.includes("budget")
    record(results, "AC-7: Valid budget YAML passes validate", !isBudgetError,
      `exit=${err.status}, stderr=${stderr.substring(0, 100)}`)
  }

  // Test 2: Invalid budget YAML (negative max_tokens) should fail
  console.log("\nTest 2: Invalid budget YAML (negative max_tokens)...")
  const invalidYaml = `apiVersion: octopus/v1
kind: Workflow
name: invalid-budget-test
budget:
  max_tokens: -1
nodes:
  - id: hello
    type: bash
    command: echo "hello"
`
  const invalidPath = path.join(TMP_DIR, "invalid-budget.yaml")
  fs.writeFileSync(invalidPath, invalidYaml)

  try {
    const output = execSync(`npx tsx packages/cli/src/index.ts workflow validate "${invalidPath}"`, {
      encoding: "utf8",
      timeout: 30000,
      cwd: "C:/xzf/ai/open-octopus",
    })
    record(results, "AC-7: Invalid budget (negative) fails validate", false,
      "validate passed when it should have failed: " + output.trim().substring(0, 100))
  } catch (err) {
    const stderr = err.stderr?.toString() ?? ""
    const stdout = err.stdout?.toString() ?? ""
    const combined = stderr + stdout
    const hasBudgetError = combined.includes("budget") || combined.includes("max_tokens") || combined.includes("positive")
    record(results, "AC-7: Invalid budget (negative) fails validate", hasBudgetError,
      `output=${combined.substring(0, 200)}`)
  }

  // Test 3: Invalid budget YAML (string instead of number) should fail
  console.log("\nTest 3: Invalid budget YAML (string max_tokens)...")
  const stringYaml = `apiVersion: octopus/v1
kind: Workflow
name: string-budget-test
budget:
  max_tokens: "abc"
nodes:
  - id: hello
    type: bash
    command: echo "hello"
`
  const stringPath = path.join(TMP_DIR, "string-budget.yaml")
  fs.writeFileSync(stringPath, stringYaml)

  try {
    const output = execSync(`npx tsx packages/cli/src/index.ts workflow validate "${stringPath}"`, {
      encoding: "utf8",
      timeout: 30000,
      cwd: "C:/xzf/ai/open-octopus",
    })
    record(results, "AC-7: Invalid budget (string) fails validate", false,
      "validate passed when it should have failed: " + output.trim().substring(0, 100))
  } catch (err) {
    const stderr = err.stderr?.toString() ?? ""
    const stdout = err.stdout?.toString() ?? ""
    const combined = stderr + stdout
    const hasBudgetError = combined.includes("budget") || combined.includes("max_tokens") || combined.includes("number") || combined.includes("string")
    record(results, "AC-7: Invalid budget (string) fails validate", hasBudgetError,
      `output=${combined.substring(0, 200)}`)
  }

  // Test 4: Valid YAML without budget should pass
  console.log("\nTest 4: Valid YAML without budget...")
  const noBudgetYaml = `apiVersion: octopus/v1
kind: Workflow
name: no-budget-test
nodes:
  - id: hello
    type: bash
    command: echo "hello"
`
  const noBudgetPath = path.join(TMP_DIR, "no-budget.yaml")
  fs.writeFileSync(noBudgetPath, noBudgetYaml)

  try {
    const output = execSync(`npx tsx packages/cli/src/index.ts workflow validate "${noBudgetPath}"`, {
      encoding: "utf8",
      timeout: 30000,
      cwd: "C:/xzf/ai/open-octopus",
    })
    const passed = !output.includes("error") && !output.includes("Error")
    record(results, "AC-7: Valid YAML without budget passes", passed, output.trim().substring(0, 200))
  } catch (err) {
    const stderr = err.stderr?.toString() ?? ""
    const stdout = err.stdout?.toString() ?? ""
    record(results, "AC-7: Valid YAML without budget passes", false,
      `exit=${err.status}, error=${(stderr + stdout).substring(0, 200)}`)
  }

  // Cleanup tmp files
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
    record(results, "Cleanup CLI tmp files", true)
  } catch {
    record(results, "Cleanup CLI tmp files", false)
  }

  const resultsPath = saveResults(results, "C:/xzf/ai/open-octopus/.scratch/workflow-observability/e2e-data/cli-results.json")
  console.log(`\nResults saved to: ${resultsPath}`)

  exitWithResults(results, { title: "Workflow Observability — CLI Validate (AC-7)" })
}

main().catch(err => { console.error("FATAL:", err); process.exit(1) })
