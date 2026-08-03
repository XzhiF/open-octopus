/**
 * Self-test for reporter.mjs
 * Run: node lib/reporter.self-test.mjs
 * No server required — pure unit test.
 */

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import {
  createResults,
  record,
  printReport,
  saveResults,
  assertAllPass,
} from "./reporter.mjs"

const results = createResults()

// Test 1: createResults returns empty array
const empty = createResults()
record(results, "createResults returns empty array", Array.isArray(empty) && empty.length === 0, `length=${empty.length}`)

// Test 2: record adds entries to results
const testResults = createResults()
record(testResults, "step-1", true, "detail-1")
record(testResults, "step-2", false, "detail-2")
record(
  results,
  "record adds entries",
  testResults.length === 2 && testResults[0].pass === true && testResults[1].pass === false,
  `entries=${testResults.length}`,
)

// Test 3: printReport returns summary
const printResults = createResults()
record(printResults, "alpha", true, "ok")
record(printResults, "beta", true, "ok")
record(printResults, "gamma", false, "oops")
const summary = printReport(printResults, { title: "Reporter self-test: inner report" })
record(
  results,
  "printReport returns correct summary",
  summary.total === 3 && summary.passed === 2 && summary.failed === 1 && summary.allPass === false,
  `total=${summary.total}, pass=${summary.passed}, fail=${summary.failed}`,
)

// Test 4: saveResults writes file
const tmpFile = path.join(os.tmpdir(), `e2e-harness-reporter-test-${Date.now()}.json`)
try {
  const saveResults2 = createResults()
  record(saveResults2, "save-step", true, "save-detail")
  const savedPath = saveResults(saveResults2, tmpFile)
  const exists = fs.existsSync(savedPath)
  const content = exists ? JSON.parse(fs.readFileSync(savedPath, "utf8")) : null
  record(
    results,
    "saveResults writes valid JSON",
    exists && content && content.total === 1 && content.passed === 1,
    `path=${savedPath}`,
  )
} catch (err) {
  record(results, "saveResults writes valid JSON", false, err instanceof Error ? err.message : String(err))
} finally {
  try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
}

// Test 5: assertAllPass throws on failure
let threw = false
try {
  const failingResults = [{ step: "x", pass: false, detail: "bad" }]
  assertAllPass(failingResults)
} catch {
  threw = true
}
record(results, "assertAllPass throws on failure", threw, "")

// Test 6: assertAllPass passes on success
let didNotThrow = true
try {
  const passingResults = [{ step: "x", pass: true }]
  assertAllPass(passingResults)
} catch {
  didNotThrow = false
}
record(results, "assertAllPass passes on success", didNotThrow, "")

printReport(results, { title: "reporter.mjs self-test" })
process.exit(results.every((r) => r.pass) ? 0 : 1)
