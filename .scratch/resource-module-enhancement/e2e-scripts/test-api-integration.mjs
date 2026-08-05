#!/usr/bin/env node
/**
 * E2E Test: Resource Module Enhancement — API Integration (v2)
 * Branch: feat/resource-module-enhancement
 * Server: localhost:3001
 *
 * Fixed: URL construction (no double slashes), test ordering, cleanup safety
 */

const API_BASE = "http://localhost:3001/api/resources"
const results = []

function record(ac, step, pass, detail) {
  results.push({ ac: `AC-${ac}`, step, pass, detail: typeof detail === "object" ? JSON.stringify(detail) : String(detail), timestamp: new Date().toISOString() })
  const icon = pass ? "PASS" : "FAIL"
  console.log(`[${icon}] AC-${ac} | ${step}: ${typeof detail === "object" ? JSON.stringify(detail).substring(0, 200) : detail}`)
}

async function api(path, options = {}) {
  // Strip leading slash from path to avoid double slash (e.g. /api/resources//...)
  // For query strings like "?type=rule", prepend directly without slash
  let url
  if (path.startsWith("?")) {
    url = `${API_BASE}${path}`
  } else if (path.startsWith("/")) {
    url = `${API_BASE}${path}`
  } else {
    url = `${API_BASE}/${path}`
  }
  const opts = {
    headers: { "Content-Type": "application/json" },
    ...options,
  }
  if (opts.body && typeof opts.body === "object") {
    opts.body = JSON.stringify(opts.body)
  }
  const res = await fetch(url, opts)
  let data = null
  const text = await res.text()
  try { data = JSON.parse(text) } catch { data = text }
  return { ok: res.ok, status: res.status, data, text }
}

// ─── AC-20: Stats include new types ────────────────────────────────────────
async function testAC20() {
  console.log("\n=== AC-20: Stats include new type counts ===")
  const { ok, data } = await api("/stats")
  record(20, "GET /stats responds 200", ok && data !== null, `ok=${ok}`)

  if (data?.byType) {
    record(20, "byType has 'rule'", data.byType.rule !== undefined, `rule=${data.byType.rule}`)
    record(20, "byType has 'command'", data.byType.command !== undefined, `command=${data.byType.command}`)
    // clone may be 0 and omitted — note as partial
    record(20, "byType has 'clone'", data.byType.clone !== undefined,
      `clone=${data.byType.clone ?? "ABSENT (0 count types omitted)"}`)
    record(20, "rule count >= 1", (data.byType.rule ?? 0) >= 1, `count=${data.byType.rule}`)
    record(20, "command count >= 1", (data.byType.command ?? 0) >= 1, `count=${data.byType.command}`)
  }
}

// ─── AC-11: List resources with type filter ─────────────────────────────────
async function testAC11() {
  console.log("\n=== AC-11: List resources with type filter ===")

  const ruleRes = await api("?type=rule")
  record(11, "GET ?type=rule responds", ruleRes.ok, `status=${ruleRes.status}, total=${ruleRes.data?.total}`)
  if (ruleRes.ok && ruleRes.data?.resources) {
    const allRules = ruleRes.data.resources.every(r => r.type === "rule")
    record(11, "All items are type=rule", allRules, `count=${ruleRes.data.resources.length}`)
    if (ruleRes.data.resources.length > 0) {
      record(11, "Rule entries have 'activated' field",
        "activated" in ruleRes.data.resources[0],
        `activated=${ruleRes.data.resources[0].activated}`)
    }
  }

  const cmdRes = await api("?type=command")
  record(11, "GET ?type=command responds", cmdRes.ok, `status=${cmdRes.status}, total=${cmdRes.data?.total}`)
  if (cmdRes.ok && cmdRes.data?.resources) {
    const allCmds = cmdRes.data.resources.every(r => r.type === "command")
    record(11, "All items are type=command", allCmds, `count=${cmdRes.data.resources.length}`)
  }

  const cloneRes = await api("?type=clone")
  record(11, "GET ?type=clone responds", cloneRes.ok, `status=${cloneRes.status}, total=${cloneRes.data?.total}`)
}

// ─── Builtin catalog ───────────────────────────────────────────────────────
async function testBuiltin() {
  console.log("\n=== Builtin Catalog ===")
  const { ok, data } = await api("/builtin")
  record("builtin", "GET /builtin responds", ok, `total=${data?.total}`)
  if (data?.resources) {
    const rules = data.resources.filter(r => r.type === "rule")
    const cmds = data.resources.filter(r => r.type === "command")
    record("builtin", "Has rule(s)", rules.length > 0, `names=${rules.map(r => r.name).join(",")}`)
    record("builtin", "Has command(s)", cmds.length > 0, `names=${cmds.map(r => r.name).join(",")}`)
    record("builtin", "Rule has sourcePath", rules.length > 0 && !!rules[0].sourcePath, `${rules[0]?.sourcePath}`)
  }
}

// ─── AC-1: Install rule from builtin ────────────────────────────────────────
async function testAC1() {
  console.log("\n=== AC-1: Install rule from builtin ===")
  const existing = await api("/rule/code-style")
  if (existing.ok) {
    record(1, "Rule already installed (verify fields)", true, `type=${existing.data?.type}, activated=${existing.data?.activated}`)
    record(1, "type=rule", existing.data?.type === "rule", `actual=${existing.data?.type}`)
    record(1, "has 'activated' field", "activated" in (existing.data ?? {}), `activated=${existing.data?.activated}`)
    return
  }
  const { ok, status, data } = await api("/install", {
    method: "POST", body: { ref: "builtin:code-style" },
  })
  record(1, "POST /install builtin:code-style", ok, `status=${status}, type=${data?.type}`)
  if (ok) {
    record(1, "type=rule", data?.type === "rule", `actual=${data?.type}`)
    record(1, "status=installed", data?.status === "installed", `actual=${data?.status}`)
  }
  const verify = await api("/rule/code-style")
  record(1, "Registry confirms install", verify.ok, `activated=${verify.data?.activated}`)
}

// ─── AC-4: Install command from builtin ─────────────────────────────────────
async function testAC4() {
  console.log("\n=== AC-4: Install command from builtin ===")
  const existing = await api("/command/cmd-review")
  if (existing.ok) {
    record(4, "Command already installed (verify fields)", true, `type=${existing.data?.type}, activated=${existing.data?.activated}`)
    record(4, "type=command", existing.data?.type === "command", `actual=${existing.data?.type}`)
    record(4, "has 'activated' field", "activated" in (existing.data ?? {}), `activated=${existing.data?.activated}`)
    return
  }
  const { ok, status, data } = await api("/install", {
    method: "POST", body: { ref: "builtin:cmd-review" },
  })
  record(4, "POST /install builtin:cmd-review", ok, `status=${status}, type=${data?.type}`)
}

// ─── AC-2: Activate a rule ─────────────────────────────────────────────────
async function testAC2() {
  console.log("\n=== AC-2: Activate a rule ===")

  // Ensure clean state — deactivate if needed
  const current = await api("/rule/code-style")
  if (current.ok && current.data?.activated) {
    await api("/deactivate", { method: "POST", body: { name: "code-style", type: "rule" } })
  }

  const { ok, status, data } = await api("/activate", {
    method: "POST", body: { name: "code-style", type: "rule" },
  })
  record(2, "POST /activate returns success", ok, `status=${status}`)
  if (ok) {
    record(2, "Has activatedTo", !!data?.activatedTo, `path=${data?.activatedTo}`)
    record(2, "Path includes .claude/rules/", data?.activatedTo?.includes(".claude") && data?.activatedTo?.includes("rules"), `path=${data?.activatedTo}`)

    // File exists check
    const fs = await import("fs")
    const exists = fs.existsSync(data.activatedTo)
    record(2, "File exists at target", exists, `path=${data.activatedTo}`)

    // Registry check
    const verify = await api("/rule/code-style")
    record(2, "Registry activated=true", verify.data?.activated === true, `activated=${verify.data?.activated}`)
    record(2, "Registry has activatedAt", !!verify.data?.activatedAt, `activatedAt=${verify.data?.activatedAt}`)
    record(2, "Registry has activatedTo", !!verify.data?.activatedTo, `activatedTo=${verify.data?.activatedTo}`)
  }
}

// ─── AC-5: Activate/deactivate command ──────────────────────────────────────
async function testAC5() {
  console.log("\n=== AC-5: Activate/deactivate a command ===")

  // Clean state
  const current = await api("/command/cmd-review")
  if (current.ok && current.data?.activated) {
    await api("/deactivate", { method: "POST", body: { name: "cmd-review", type: "command" } })
  }

  const { ok, status, data } = await api("/activate", {
    method: "POST", body: { name: "cmd-review", type: "command" },
  })
  record(5, "POST /activate command succeeds", ok, `status=${status}`)
  if (ok) {
    record(5, "Path includes .claude/commands/", data?.activatedTo?.includes("commands"), `path=${data?.activatedTo}`)
    const fs = await import("fs")
    record(5, "File exists at target", fs.existsSync(data.activatedTo), `path=${data?.activatedTo}`)
  }

  // Deactivate
  const deact = await api("/deactivate", { method: "POST", body: { name: "cmd-review", type: "command" } })
  record(5, "POST /deactivate command succeeds", deact.ok, `status=${deact.status}`)
  if (data?.activatedTo) {
    const fs = await import("fs")
    record(5, "File removed after deactivation", !fs.existsSync(data.activatedTo), `path=${data.activatedTo}`)
  }
}

// ─── AC-3: Deactivate a rule ────────────────────────────────────────────────
async function testAC3() {
  console.log("\n=== AC-3: Deactivate a rule ===")

  // Ensure activated
  const current = await api("/rule/code-style")
  if (current.ok && !current.data?.activated) {
    await api("/activate", { method: "POST", body: { name: "code-style", type: "rule" } })
  }

  const before = await api("/rule/code-style")
  const targetPath = before.data?.activatedTo

  const { ok, status, data } = await api("/deactivate", {
    method: "POST", body: { name: "code-style", type: "rule" },
  })
  record(3, "POST /deactivate succeeds", ok, `status=${status}`)

  const verify = await api("/rule/code-style")
  record(3, "Registry activated=false", verify.data?.activated === false, `activated=${verify.data?.activated}`)

  if (targetPath) {
    const fs = await import("fs")
    record(3, "File removed from target", !fs.existsSync(targetPath), `path=${targetPath}`)
  }
}

// ─── AC-8: Block uninstall of activated resource ────────────────────────────
async function testAC8() {
  console.log("\n=== AC-8: Block uninstall of activated resource ===")

  // Activate first
  const current = await api("/rule/code-style")
  if (current.ok && !current.data?.activated) {
    await api("/activate", { method: "POST", body: { name: "code-style", type: "rule" } })
  }

  const { ok, status, data } = await api("/uninstall", {
    method: "POST", body: { name: "code-style", type: "rule" },
  })
  record(8, "Uninstall returns error", !ok, `ok=${ok}, status=${status}`)
  record(8, "Status is 409", status === 409, `status=${status}`)
  record(8, "Error code is UNINSTALL_BLOCKED",
    data?.error?.code === "UNINSTALL_BLOCKED",
    `code=${data?.error?.code}`)
  record(8, "Message mentions deactivate",
    (data?.error?.message ?? "").toLowerCase().includes("deactivat"),
    `msg=${data?.error?.message}`)
}

// ─── AC-18: Audit log records activate/deactivate ───────────────────────────
async function testAC18() {
  console.log("\n=== AC-18: Audit log ===")
  const { ok, data } = await api("/audit?last=20")
  record(18, "GET /audit responds", ok, `status=${ok ? 200 : "error"}`)
  if (data?.records) {
    const activateRecs = data.records.filter(r => r.action === "activate")
    const deactivateRecs = data.records.filter(r => r.action === "deactivate")
    record(18, "Has activate records", activateRecs.length > 0, `count=${activateRecs.length}`)
    record(18, "Has deactivate records", deactivateRecs.length > 0, `count=${deactivateRecs.length}`)
    if (activateRecs.length > 0) {
      const r = activateRecs[0]
      record(18, "Activate record has details", !!r.details?.activatedTo,
        `name=${r.resource_name}, type=${r.resource_type}, to=${r.details?.activatedTo}`)
    }
  }
}

// ─── AC-19: Verify works for new types ──────────────────────────────────────
async function testAC19() {
  console.log("\n=== AC-19: Verify for new types ===")
  const ruleV = await api("/rule/code-style/verify")
  record(19, "Rule verify responds", ruleV.ok, `status=${ruleV.status}, verify=${ruleV.data?.verify?.status}`)
  if (ruleV.ok) {
    record(19, "Rule verify has steps", Array.isArray(ruleV.data?.verify?.steps),
      `steps=${ruleV.data?.verify?.steps?.length}`)
  }
  const cmdV = await api("/command/cmd-review/verify")
  record(19, "Command verify responds", cmdV.ok, `status=${cmdV.status}, verify=${cmdV.data?.verify?.status}`)
}

// ─── AC-12: Resource info with activation details ──────────────────────────
async function testAC12() {
  console.log("\n=== AC-12: Resource info with activation details ===")
  const { ok, data } = await api("/rule/code-style")
  record(12, "GET /rule/code-style responds", ok, `status=${ok ? 200 : "error"}`)
  if (ok) {
    record(12, "Has 'activated' field", "activated" in data, `activated=${data.activated}`)
    record(12, "Has 'type' field", data.type === "rule", `type=${data.type}`)
    record(12, "Has 'installPath'", !!data.installPath, `path=${data.installPath}`)
  }
}

// ─── Edge case tests ────────────────────────────────────────────────────────
async function testEdgeCases() {
  console.log("\n=== Edge Cases ===")

  // Deactivate non-activated resource
  const current = await api("/rule/code-style")
  if (current.ok && current.data?.activated) {
    await api("/deactivate", { method: "POST", body: { name: "code-style", type: "rule" } })
  }
  const deact = await api("/deactivate", { method: "POST", body: { name: "code-style", type: "rule" } })
  record("edge", "Deactivate non-activated → DEACTIVATION_BLOCKED",
    !deact.ok && deact.status === 409 && deact.data?.error?.code === "DEACTIVATION_BLOCKED",
    `status=${deact.status}, code=${deact.data?.error?.code}`)

  // Activate skill type → INVALID_TYPE
  const skillAct = await api("/activate", { method: "POST", body: { name: "octo-guide", type: "skill" } })
  record("edge", "Activate skill → INVALID_TYPE",
    !skillAct.ok && skillAct.data?.error?.code === "INVALID_TYPE",
    `status=${skillAct.status}, code=${skillAct.data?.error?.code}`)

  // Double activation → ACTIVATION_BLOCKED
  await api("/activate", { method: "POST", body: { name: "code-style", type: "rule" } })
  const doubleAct = await api("/activate", { method: "POST", body: { name: "code-style", type: "rule" } })
  record("edge", "Double activation → ACTIVATION_BLOCKED",
    !doubleAct.ok && doubleAct.status === 409 && doubleAct.data?.error?.code === "ACTIVATION_BLOCKED",
    `status=${doubleAct.status}, code=${doubleAct.data?.error?.code}`)

  // Cleanup
  await api("/deactivate", { method: "POST", body: { name: "code-style", type: "rule" } })
}

// ─── Cleanup ────────────────────────────────────────────────────────────────
async function cleanup() {
  console.log("\n=== Cleanup ===")
  try {
    const rule = await api("/rule/code-style")
    if (rule.ok && rule.data?.activated) {
      await api("/deactivate", { method: "POST", body: { name: "code-style", type: "rule" } })
      console.log("  Deactivated code-style")
    }
  } catch {}
  try {
    const cmd = await api("/command/cmd-review")
    if (cmd.ok && cmd.data?.activated) {
      await api("/deactivate", { method: "POST", body: { name: "cmd-review", type: "command" } })
      console.log("  Deactivated cmd-review")
    }
  } catch {}
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Resource Module Enhancement — E2E API Integration Tests (v2) ===")
  console.log(`Server: ${API_BASE}`)
  console.log(`Timestamp: ${new Date().toISOString()}\n`)

  await testAC20()
  await testAC11()
  await testBuiltin()
  await testAC1()
  await testAC4()
  await testAC2()
  await testAC5()
  await testAC3()
  await testAC8()
  await testAC18()
  await testAC19()
  await testAC12()
  await testEdgeCases()
  await cleanup()

  // Summary
  const passed = results.filter(r => r.pass).length
  const failed = results.filter(r => !r.pass).length
  console.log(`\n=== SUMMARY ===`)
  console.log(`Total: ${results.length} | PASS: ${passed} | FAIL: ${failed}`)
  if (failed > 0) {
    console.log("\nFailures:")
    results.filter(r => !r.pass).forEach(r =>
      console.log(`  ${r.ac} | ${r.step}: ${r.detail}`))
  }

  // Save
  const fs = await import("fs")
  const out = ".scratch/resource-module-enhancement/e2e-data/test-results.json"
  fs.writeFileSync(out, JSON.stringify({
    timestamp: new Date().toISOString(),
    total: results.length, passed, failed, results
  }, null, 2))
  console.log(`\nResults saved to ${out}`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
