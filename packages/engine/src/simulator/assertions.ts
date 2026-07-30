// packages/engine/src/simulator/assertions.ts
//
// Assertion engine for validating simulation results.
// Supports 5 assertion types: status, vars, node_trace, node_outputs, logs.

import type { NodeExecutionResult } from "../executors/types"
import type { AssertionDef, AssertionReport, AssertionResult, NodeExecutionEntry } from "./types"

/**
 * Run all assertions against simulation results.
 * Returns an AssertionReport with per-assertion pass/fail details.
 */
export function runAssertions(
  def: AssertionDef,
  status: string,
  poolSnapshot: Record<string, any>,
  nodeResults: Record<string, NodeExecutionResult>,
  executionTrace: NodeExecutionEntry[],
): AssertionReport {
  const results: AssertionResult[] = []

  // 1. Status assertion
  if (def.status !== undefined) {
    results.push(assertStatus(def.status, status))
  }

  // 2. Vars assertion
  if (def.vars !== undefined) {
    results.push(...assertVars(def.vars, poolSnapshot))
  }

  // 3. Node trace assertion
  if (def.node_trace !== undefined) {
    results.push(...assertNodeTrace(def.node_trace, executionTrace))
  }

  // 4. Node outputs assertion
  if (def.node_outputs !== undefined) {
    results.push(...assertNodeOutputs(def.node_outputs, nodeResults))
  }

  // 5. Logs assertion
  if (def.logs !== undefined) {
    results.push(...assertLogs(def.logs, nodeResults))
  }

  const passed = results.every((r) => r.passed)
  return { passed, results }
}

// ── Status ────────────────────────────────────────────────────

function assertStatus(expected: string, actual: string): AssertionResult {
  const passed = expected === actual
  return {
    name: "status",
    passed,
    expected,
    actual,
    message: passed ? `status = ${actual}` : `Expected status "${expected}", got "${actual}"`,
  }
}

// ── Vars ──────────────────────────────────────────────────────

function assertVars(
  expected: Record<string, any>,
  actual: Record<string, any>,
): AssertionResult[] {
  const results: AssertionResult[] = []

  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[key]
    if (actualValue === undefined) {
      results.push({
        name: `vars.${key}`,
        passed: false,
        expected: expectedValue,
        actual: undefined,
        message: `Expected vars.${key} = ${JSON.stringify(expectedValue)}, but key is missing`,
      })
    } else if (!deepEqual(actualValue, expectedValue)) {
      results.push({
        name: `vars.${key}`,
        passed: false,
        expected: expectedValue,
        actual: actualValue,
        message: `vars.${key}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`,
      })
    } else {
      results.push({
        name: `vars.${key}`,
        passed: true,
        expected: expectedValue,
        actual: actualValue,
        message: `vars.${key} = ${JSON.stringify(actualValue)}`,
      })
    }
  }

  return results
}

// ── Node Trace ────────────────────────────────────────────────

function assertNodeTrace(
  expected: { executed?: string[]; skipped?: string[]; order?: string[] },
  trace: NodeExecutionEntry[],
): AssertionResult[] {
  const results: AssertionResult[] = []
  const executedIds = trace
    .filter((e) => !["skipped", "skipped_failed"].includes(e.status))
    .map((e) => e.nodeId)
  const skippedIds = trace
    .filter((e) => ["skipped", "skipped_failed"].includes(e.status))
    .map((e) => e.nodeId)

  // Check executed nodes
  if (expected.executed) {
    for (const nodeId of expected.executed) {
      const found = executedIds.includes(nodeId)
      results.push({
        name: `node_trace.executed.${nodeId}`,
        passed: found,
        expected: "executed",
        actual: found ? "executed" : "not found in executed",
        message: found
          ? `node "${nodeId}" was executed`
          : `Expected node "${nodeId}" to be executed, but it was not`,
      })
    }
  }

  // Check skipped nodes
  if (expected.skipped) {
    for (const nodeId of expected.skipped) {
      const found = skippedIds.includes(nodeId)
      results.push({
        name: `node_trace.skipped.${nodeId}`,
        passed: found,
        expected: "skipped",
        actual: found ? "skipped" : "not found in skipped",
        message: found
          ? `node "${nodeId}" was skipped`
          : `Expected node "${nodeId}" to be skipped, but it was not`,
      })
    }
  }

  // Check execution order
  if (expected.order) {
    const allIds = trace.map((e) => e.nodeId)
    const orderCorrect = isSubsequence(expected.order, allIds)
    results.push({
      name: "node_trace.order",
      passed: orderCorrect,
      expected: expected.order,
      actual: allIds,
      message: orderCorrect
        ? `execution order matches [${expected.order.join(", ")}]`
        : `Expected order [${expected.order.join(", ")}], got [${allIds.join(", ")}]`,
    })
  }

  return results
}

// ── Node Outputs ──────────────────────────────────────────────

function assertNodeOutputs(
  expected: Record<string, { output?: string; outputs?: Record<string, any>; status?: string }>,
  nodeResults: Record<string, NodeExecutionResult>,
): AssertionResult[] {
  const results: AssertionResult[] = []

  for (const [nodeId, expectedOutput] of Object.entries(expected)) {
    const result = nodeResults[nodeId]

    if (!result) {
      results.push({
        name: `node_outputs.${nodeId}`,
        passed: false,
        expected: expectedOutput,
        actual: undefined,
        message: `Node "${nodeId}" was not executed — cannot check outputs`,
      })
      continue
    }

    // Check lastOutput
    if (expectedOutput.output !== undefined) {
      const passed = result.lastOutput === expectedOutput.output
      results.push({
        name: `node_outputs.${nodeId}.output`,
        passed,
        expected: expectedOutput.output,
        actual: result.lastOutput,
        message: passed
          ? `${nodeId}.output matches`
          : `${nodeId}.output: expected ${JSON.stringify(expectedOutput.output)}, got ${JSON.stringify(result.lastOutput)}`,
      })
    }

    // Check named outputs
    if (expectedOutput.outputs !== undefined) {
      for (const [key, expectedVal] of Object.entries(expectedOutput.outputs)) {
        const actualVal = result.outputs?.[key]
        const passed = deepEqual(actualVal, expectedVal)
        results.push({
          name: `node_outputs.${nodeId}.outputs.${key}`,
          passed,
          expected: expectedVal,
          actual: actualVal,
          message: passed
            ? `${nodeId}.outputs.${key} matches`
            : `${nodeId}.outputs.${key}: expected ${JSON.stringify(expectedVal)}, got ${JSON.stringify(actualVal)}`,
        })
      }
    }

    // Check status
    if (expectedOutput.status !== undefined) {
      const passed = result.status === expectedOutput.status
      results.push({
        name: `node_outputs.${nodeId}.status`,
        passed,
        expected: expectedOutput.status,
        actual: result.status,
        message: passed
          ? `${nodeId}.status = ${result.status}`
          : `${nodeId}.status: expected "${expectedOutput.status}", got "${result.status}"`,
      })
    }
  }

  return results
}

// ── Logs ──────────────────────────────────────────────────────

function assertLogs(
  expected: Record<string, { contains?: string[]; not_contains?: string[] }>,
  nodeResults: Record<string, NodeExecutionResult>,
): AssertionResult[] {
  const results: AssertionResult[] = []

  for (const [nodeId, logDef] of Object.entries(expected)) {
    const result = nodeResults[nodeId]
    const logLines = result?.logLines ?? []
    const logText = logLines.join("\n")

    if (logDef.contains) {
      for (const pattern of logDef.contains) {
        const found = logText.includes(pattern)
        results.push({
          name: `logs.${nodeId}.contains("${pattern}")`,
          passed: found,
          expected: pattern,
          actual: logText,
          message: found
            ? `${nodeId} log contains "${pattern}"`
            : `${nodeId} log does not contain "${pattern}"`,
        })
      }
    }

    if (logDef.not_contains) {
      for (const pattern of logDef.not_contains) {
        const found = logText.includes(pattern)
        results.push({
          name: `logs.${nodeId}.not_contains("${pattern}")`,
          passed: !found,
          expected: `not "${pattern}"`,
          actual: logText,
          message: !found
            ? `${nodeId} log does not contain "${pattern}"`
            : `${nodeId} log unexpectedly contains "${pattern}"`,
        })
      }
    }
  }

  return results
}

// ── Helpers ───────────────────────────────────────────────────

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return a === b
  if (typeof a !== typeof b) return false
  if (typeof a !== "object") return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    return a.every((val: any, i: number) => deepEqual(val, b[i]))
  }
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  return keysA.every((key) => deepEqual(a[key], b[key]))
}

function isSubsequence(sub: string[], full: string[]): boolean {
  let si = 0
  for (let fi = 0; fi < full.length && si < sub.length; fi++) {
    if (full[fi] === sub[si]) si++
  }
  return si === sub.length
}
