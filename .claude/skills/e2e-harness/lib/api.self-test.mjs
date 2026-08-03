/**
 * Self-test for api.mjs
 * Run: node lib/api.self-test.mjs
 */

import { createResults, record, exitWithResults } from "./reporter.mjs"
import { fetchJSON, healthCheck, resolveApiUrl, resolveWebUrl, resolvePorts } from "./api.mjs"

const results = createResults()

async function main() {
  // Test 1: resolvePorts returns valid numbers
  try {
    const ports = resolvePorts()
    const valid =
      typeof ports.server === "number" &&
      typeof ports.web === "number" &&
      ports.server > 0 &&
      ports.web > 0
    record(results, "resolvePorts returns valid port pair", valid, `server=${ports.server}, web=${ports.web}`)
  } catch (err) {
    record(results, "resolvePorts returns valid port pair", false, err.message)
  }

  // Test 2: resolveApiUrl returns a URL string
  try {
    const url = resolveApiUrl()
    const valid = typeof url === "string" && url.startsWith("http")
    record(results, "resolveApiUrl returns URL", valid, `url=${url}`)
  } catch (err) {
    record(results, "resolveApiUrl returns URL", false, err.message)
  }

  // Test 3: resolveWebUrl returns a URL string
  try {
    const url = resolveWebUrl()
    const valid = typeof url === "string" && url.startsWith("http")
    record(results, "resolveWebUrl returns URL", valid, `url=${url}`)
  } catch (err) {
    record(results, "resolveWebUrl returns URL", false, err.message)
  }

  // Test 4: healthCheck against live server
  try {
    const healthy = await healthCheck()
    // Server may or may not be running — pass if we get a boolean
    const valid = typeof healthy === "boolean"
    record(results, "healthCheck returns boolean", valid, `healthy=${healthy}`)
  } catch (err) {
    record(results, "healthCheck returns boolean", false, err.message)
  }

  // Test 5: fetchJSON with valid path
  try {
    const result = await fetchJSON("/api/health")
    const valid =
      typeof result === "object" &&
      typeof result.ok === "boolean" &&
      typeof result.status === "number"
    record(results, "fetchJSON returns structured response", valid, `status=${result.status}`)
  } catch (err) {
    record(results, "fetchJSON returns structured response", false, err.message)
  }

  exitWithResults(results, { title: "api.mjs self-test" })
}

main()
