/**
 * E2E Harness — reporter.mjs
 * Test result recording and reporting for E2E tests.
 *
 * @module reporter
 * @status STABLE
 *
 * Provides a lightweight, dependency-free test reporter that records
 * step-by-step results and generates formatted output.
 */

import fs from "node:fs"
import path from "node:path"

/**
 * Record a test step result.
 *
 * @param {Array<{ step: string, pass: boolean, detail: string, timestamp: string }>} results
 *   Mutable results array (passed by reference).
 * @param {string} step - Test step name
 * @param {boolean} pass - Whether the step passed
 * @param {string} [detail=""] - Additional detail or error message
 * @returns {void}
 */
export function record(results, step, pass, detail = "") {
  const entry = {
    step,
    pass,
    detail,
    timestamp: new Date().toISOString(),
  }
  results.push(entry)

  const icon = pass ? "PASS" : "FAIL"
  const detailStr = detail ? ` | ${detail}` : ""
  console.log(`${icon} | ${step}${detailStr}`)
}

/**
 * Print a formatted test report to stdout.
 *
 * @param {Array<{ step: string, pass: boolean, detail: string }>} results
 * @param {object} [options]
 * @param {string} [options.title="E2E Test Results"]
 * @returns {{ total: number, passed: number, failed: number, allPass: boolean }}
 */
export function printReport(results, options = {}) {
  const title = options.title || "E2E Test Results"

  const passed = results.filter((r) => r.pass).length
  const failed = results.filter((r) => !r.pass).length
  const total = results.length
  const allPass = failed === 0

  console.log(`\n${"=".repeat(60)}`)
  console.log(`  ${title}`)
  console.log(`${"=".repeat(60)}`)

  // Calculate column widths
  const maxStep = Math.max(...results.map((r) => r.step.length), 4)
  const maxDetail = Math.max(...results.map((r) => (r.detail || "").length), 6)

  // Header
  console.log(
    `${"Status".padEnd(6)} | ${"Step".padEnd(maxStep)} | ${"Detail".padEnd(Math.min(maxDetail, 60))}`,
  )
  console.log(`${"-".repeat(6)}-+-${"-".repeat(maxStep)}-+-${"-".repeat(Math.min(maxDetail, 60))}`)

  // Rows
  for (const r of results) {
    const status = r.pass ? "PASS" : "FAIL"
    const detail = (r.detail || "").slice(0, 60)
    console.log(
      `${status.padEnd(6)} | ${r.step.padEnd(maxStep)} | ${detail.padEnd(Math.min(maxDetail, 60))}`,
    )
  }

  console.log(`${"-".repeat(6)}-+-${"-".repeat(maxStep)}-+-${"-".repeat(Math.min(maxDetail, 60))}`)
  console.log(
    `Total: ${total} | Passed: ${passed} | Failed: ${failed} | ${allPass ? "ALL PASS ✓" : "SOME FAILED ✗"}`,
  )
  console.log("=".repeat(60))

  return { total, passed, failed, allPass }
}

/**
 * Save test results to a JSON file.
 *
 * @param {Array<{ step: string, pass: boolean, detail: string, timestamp: string }>} results
 * @param {string} filePath - Output file path
 * @returns {string} absolute path to saved file
 */
export function saveResults(results, filePath) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })

  const summary = {
    generatedAt: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    results,
  }

  fs.writeFileSync(filePath, JSON.stringify(summary, null, 2))
  return path.resolve(filePath)
}

/**
 * Create a new empty results array.
 * Convenience for consistent initialization.
 *
 * @returns {Array<{ step: string, pass: boolean, detail: string, timestamp: string }>}
 */
export function createResults() {
  return []
}

/**
 * Assert that all results passed; throw if any failed.
 * Useful for CI integration.
 *
 * @param {Array<{ step: string, pass: boolean }>} results
 * @param {string} [message] - Custom error message prefix
 * @throws {Error} if any result failed
 */
export function assertAllPass(results, message) {
  const failed = results.filter((r) => !r.pass)
  if (failed.length > 0) {
    const prefix = message ? `${message}: ` : ""
    const details = failed.map((r) => `  - ${r.step}: ${r.detail}`).join("\n")
    throw new Error(`${prefix}${failed.length} step(s) failed:\n${details}`)
  }
}

/**
 * Exit the process with the appropriate code based on results.
 *
 * @param {Array<{ step: string, pass: boolean }>} results
 * @param {object} [options]
 * @param {string} [options.title] - Report title
 */
export function exitWithResults(results, options = {}) {
  const { allPass } = printReport(results, options)
  process.exit(allPass ? 0 : 1)
}
