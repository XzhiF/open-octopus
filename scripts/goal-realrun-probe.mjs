#!/usr/bin/env node
/**
 * goal-realrun-probe.mjs — REAL claude CLI integration probe for goal-task-dev (ticket 03, AC5/AC6).
 *
 * Drives the repo engine directly (no server/看板) with two minimal workflows in throwaway
 * workspaces:
 *   A (converge):      goal="创建 hello.txt 内容 GTD_OK" → node completed + file exists
 *   B (not-converge):  goal="每轮只说一个递增数字,说出7时达成" × max_turns:3
 *                      → node failed + goal_not_met + evidence.numTurns > 0
 *                      + JSONL carries active_goal events (condition/iterations/last_reason —
 *                      AC5 evidence chain; blocks only exist on not-met rounds, hence here).
 *
 * Cost per full run ~ $0.1-0.4 (user-approved). Exit code: 0 = both PASS, 1 = any FAIL.
 * Artifacts (JSONL logs + summary) are copied to .scratch/goal-task-dev/e2e-data/ for reuse
 * by ticket 07 (E2E full-chain). Set GOAL_PROBE_KEEP=1 to keep the temp workspaces.
 *
 * Usage: node scripts/goal-realrun-probe.mjs [A|B]   (no arg = both)
 */

import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, copyFileSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { fileURLToPath } from "url"
import { dirname } from "path"

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

const { parseWorkflow } = await import(join(REPO, "packages/shared/dist/index.mjs"))
const { ClaudeSDKProvider } = await import(join(REPO, "packages/providers/dist/index.mjs"))
const { WorkflowEngine } = await import(join(REPO, "packages/engine/dist/index.mjs"))

const ARTIFACT_DIR = join(REPO, ".scratch/goal-task-dev/e2e-data")
const results = []

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args)
}

/** Run one minimal workflow in a fresh workspace + isolated orgDir (JSONL logs land there). */
async function runScenario(name, yaml, workspaceSetup) {
  const orgDir = mkdtempSync(join(tmpdir(), `gtd-probe-${name}-org-`))
  const workspace = mkdtempSync(join(tmpdir(), `gtd-probe-${name}-ws-`))
  const executionId = `probe-${name}-${Date.now()}`

  const wf = parseWorkflow(yaml)
  const providers = { claude: new ClaudeSDKProvider() }
  const engine = new WorkflowEngine(wf, providers, workspace, orgDir, undefined, undefined, executionId)

  log(`[${name}] workspace=${workspace} execId=${executionId} — starting real claude run...`)
  const start = Date.now()
  const result = await engine.run()
  log(`[${name}] finished in ${((Date.now() - start) / 1000).toFixed(1)}s, status=${result.status}`)

  const nodeResult = result.nodeResults["develop"] ?? {}
  const jsonlPath = join(orgDir, "logs", executionId, "develop.jsonl")
  const jsonl = existsSync(jsonlPath) ? readFileSync(jsonlPath, "utf8") : ""

  // Persist artifacts for ticket 07 reuse
  if (!existsSync(ARTIFACT_DIR)) mkdirSync(ARTIFACT_DIR, { recursive: true })
  if (existsSync(jsonlPath)) copyFileSync(jsonlPath, join(ARTIFACT_DIR, `${name}.jsonl`))
  writeFileSync(
    join(ARTIFACT_DIR, `${name}.summary.json`),
    JSON.stringify({ workspace, executionId, status: result.status, nodeResult, ranAt: new Date().toISOString() }, null, 2),
  )

  if (process.env.GOAL_PROBE_KEEP !== "1") {
    // orgDir/workspace are mkdtemp dirs — leave for OS tmp cleanup; just don't print more.
  }
  return { nodeResult, jsonl, workspace }
}

function check(name, cond, detail) {
  const line = `${cond ? "PASS" : "FAIL"} [${name}] ${detail ?? ""}`.trim()
  console.log(line)
  if (!cond) results.push({ name, ok: false })
  return cond
}

// ── Scenario A: convergence ────────────────────────────────────────
const yamlA = `apiVersion: octopus/v1
kind: Workflow
name: gtd-probe-converge
engine: claude
nodes:
  - id: develop
    type: agent
    context: new
    max_turns: 12
    goal: 在当前工作目录创建文件 hello.txt,其内容(去除首尾空白后)必须恰好为 GTD_OK。创建成功即达成目标。
`

try {
  const { nodeResult, jsonl, workspace } = await runScenario("converge", yamlA)
  const filePath = join(workspace, "hello.txt")
  const fileOk = existsSync(filePath) && readFileSync(filePath, "utf8").trim() === "GTD_OK"
  check("A1 node completed", nodeResult.status === "completed", `status=${nodeResult.status} error=${nodeResult.error ?? ""}`)
  check("A2 hello.txt exists with GTD_OK", fileOk, filePath)
  // NOTE: no active_goal assertion here — converging first-try means the evaluator
  // never BLOCKED, and "Stop hook feedback" (the headless exit of a not-met verdict,
  // mapped by the provider into active_goal chunks) only exists on blocked rounds.
  // Evidence-chain assertion lives in scenario B (forced multi-round blocks).
} catch (err) {
  check("A converge scenario ran", false, `threw: ${err?.message ?? err}`)
}

// ── Scenario B: non-convergence (hard fuse) ────────────────────────
const yamlB = `apiVersion: octopus/v1
kind: Workflow
name: gtd-probe-not-converge
engine: claude
nodes:
  - id: develop
    type: agent
    context: new
    max_turns: 3
    goal: 你的回复按轮次逐个递增报数:每轮只说一个数字,从 1 开始,下一轮说 2,依此类推;数到 7 才算达成目标。不要在一轮里说完多个数字。
`

try {
  const { nodeResult, jsonl } = await runScenario("not-converge", yamlB)
  const evidence = nodeResult.outputs?.goal_evidence ?? {}
  check("B1 node failed", nodeResult.status === "failed", `status=${nodeResult.status}`)
  check("B2 error goal_not_met", String(nodeResult.error ?? "").includes("goal_not_met"), `error=${nodeResult.error}`)
  check("B3 evidence.numTurns > 0", typeof evidence.numTurns === "number" && evidence.numTurns > 0, JSON.stringify(evidence))
  // AC5 evidence chain: blocked rounds surface as "Stop hook feedback" user messages,
  // provider-mapped to active_goal chunks → AgentEvent → JSONL. Forced multi-round
  // goal guarantees >=1 block before max_turns cuts.
  const goalEvents = jsonl.split("\n").map((l) => {
    try {
      const e = JSON.parse(l)
      return e.event === "agent_event" && e.event_data?.type === "active_goal" ? e.event_data : null
    } catch { return null }
  }).filter(Boolean)
  check("B4 JSONL contains active_goal event(s)", goalEvents.length > 0, `count=${goalEvents.length}`)
  check("B5 active_goal carries condition+iterations+reason",
    goalEvents.length > 0 && goalEvents.every((g) => typeof g.condition === "string" && g.condition.length > 0 && typeof g.iterations === "number" && g.iterations >= 1 && typeof g.last_reason === "string" && g.last_reason.length > 0),
    JSON.stringify(goalEvents[goalEvents.length - 1] ?? null)?.slice(0, 200))
} catch (err) {
  check("B not-converge scenario ran", false, `threw: ${err?.message ?? err}`)
}

// ── Aggregate ──────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(failed.length === 0
  ? "\n=== GOAL REALRUN PROBE: ALL PASS ==="
  : `\n=== GOAL REALRUN PROBE: ${failed.length} FAILED (${failed.map(f => f.name).join(", ")}) ===`)
process.exit(failed.length === 0 ? 0 : 1)
