// packages/server/src/services/tasks/task-artifact-sync.ts
//
// task-phase-redesign (ticket 06) + ws-authoritative-spec revision (ADR-0018)
// — the ONE-WAY ARTIFACT LOOP (K9/K10/K16).
//
//   seed    (下行): {home}/.scratch/<date>/<slug>/  →  ws/.scratch/<date>/<slug>/
//     Physical copy before a v4 phase/round execution starts (mount points:
//     WorkflowExecutor.execute v4 branch + TasksService.dispatchPhaseRound —
//     same precedent as copyTaskWorkflowsToWs, ADR-0013). home OVERWRITES ws
//     same-name files: home carries the LAST COLLECTED STATE (or the draft
//     baseline before round 1), so K16 makes "home-side edits between rounds
//     take effect on the next seed" fall out for free. Idempotent.
//
//   collect (上行): ws/.scratch/<date>/<slug>/  →  {home}/.scratch/<date>/<slug>/
//     Terminal-state recovery of what the EXECUTION side changed. Single-writer
//     per file class (K9: 每类文件单写者单方向 ⇒ 无 merge). Since ADR-0018 the
//     FINAL spec authority is the EXECUTION side (ws):
//       - spec*.md / issues/ / 报告 / 其它  → ws 权威: copied back when new in
//         ws or when the ws mtime is strictly newer than home's (the agent
//         reviewed/updated the spec in the ws — 有问题在 ws 里重新审查更新
//         spec.md, and home's copy follows). Equal/older mtimes skip —
//         re-collecting an untouched round is a no-op (seed preserves mtimes).
//     ABORT caveat (accepted): edits not yet collected die with the ws — the
//     final state only exists at a round's terminal transition.
//     AC4 (防丢兜底): collect runs at EVERY v4 terminal transition, so the home
//     copy is complete before retention/eviction (or an out-of-band rm) can take
//     the ws away; deleting the ws afterwards loses nothing.
//
// Failures are the CALLER's to contain (non-fatal log-and-continue at every
// mount) — these functions just throw fs errors as-is, mirroring
// copyTaskWorkflowsToWs.

import fs from "fs"
import path from "path"
import { PHASE_STATUS_UPDATE_EVENT } from "@octopus/shared"

/** home-relative position of a phase batch dir — the ws mirror path (K10:
 *  ws 内落 `.scratch/<date>/<slug>/`，与 home 同构相对位，git-able 随 PR).
 *  Returns null when specDir is not under homeDir (absolute/out-of-home spec
 *  path — off-contract, seed/collect skip the batch; the wf's own input_values
 *  still carry the absolute specPath). */
export function batchRelPath(homeDir: string, specDir: string): string | null {
  if (!homeDir || !specDir) return null
  const rel = path.relative(homeDir, specDir)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null
  return rel
}

/** task_spec.format === "v4" — cheap hot-path discriminator (no schema import).
 *  Shared by the SG2 status listener (K3 mirror skip) and the edit-window
 *  guards (K16). Invalid/empty JSON → false (v3 semantics preserved). */
export function isV4TaskSpec(taskSpecJson: string | null | undefined): boolean {
  if (!taskSpecJson) return false
  try {
    return (JSON.parse(taskSpecJson) as { format?: string }).format === "v4"
  } catch {
    return false
  }
}

/** Envelope (票 04 materialize) → the phase's absolute home specDir. One parse
 *  shape shared by BOTH terminal mounts (WorkflowExecutor.handleChainComplete
 *  + TasksService.finalizePhaseRoundExecution) — review ④: the inline
 *  `JSON.parse(config).phases?.find(p => p.index === …)?.specDir` was duplicated
 *  across the two files with independently re-declared envelope types.
 *  Returns undefined on any shape mismatch (v3/generic/composite rows). */
export function resolvePhaseSpecDir(configJson: string, phaseIndex: number): string | undefined {
  if (!configJson) return undefined
  try {
    const cfg = JSON.parse(configJson) as { phases?: Array<{ index?: number; specDir?: string }> }
    return cfg.phases?.find((p) => p.index === phaseIndex)?.specDir
  } catch {
    return undefined
  }
}

/** P3 (review round-terminal SSE): a v4 tagged execution reaching terminal
 *  means "a round awaits its human decision" — emit phase_status_update
 *  {status:'awaiting_review'} so the board moves the card to 待验收 without
 *  waiting for the 10s poll. Emitted INDEPENDENT of collect results (the
 *  transition is about the execution, not file flow). Emitted at both terminal
 *  mounts; acceptance/advance (票 07) owns every other transition. */
export function emitPhaseAwaitingReview(
  emit: (channel: "taskpool", payload: unknown) => void,
  taskId: string,
  phaseIndex: number,
  roundIndex: number,
): void {
  emit("taskpool", {
    event: PHASE_STATUS_UPDATE_EVENT,
    data: {
      task_id: taskId,
      phase_index: phaseIndex,
      status: "awaiting_review" as const,
      round_index: roundIndex,
    },
  })
}

/** seed 下行: recursively copy `homeAbsSpecDir` into
 *  `{wsPath}/{relBatchPath}` (mkdir -p, home overwrites ws same-names,
 *  idempotent re-seed safe). Missing/empty source, non-directory source or an
 *  unsafe relBatchPath are no-ops (copyTaskWorkflowsToWs discipline).
 *  Returns the number of files copied (0 = nothing seeded). */
export function seedPhaseToWorkspace(
  homeAbsSpecDir: string,
  wsPath: string,
  relBatchPath: string,
): number {
  if (!homeAbsSpecDir || !wsPath || !relBatchPath) return 0
  if (path.isAbsolute(relBatchPath) || relBatchPath.startsWith("..")) return 0
  if (!fs.existsSync(homeAbsSpecDir)) return 0
  if (!fs.statSync(homeAbsSpecDir).isDirectory()) return 0
  return copyTree(homeAbsSpecDir, path.join(wsPath, relBatchPath))
}

function copyTree(srcDir: string, dstDir: string): number {
  let count = 0
  fs.mkdirSync(dstDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name)
    const dst = path.join(dstDir, entry.name)
    if (entry.isDirectory()) {
      count += copyTree(src, dst)
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst)
      // Preserve the source mtime: a freshly SEEDED ws file must not look
      // "modified" to collect's ws>home mtime rule (copyFileSync otherwise
      // stamps now(), and an untouched round would wrongly flow back every
      // file). An execution-side edit re-stamps the ws file → collect sees it.
      const st = fs.statSync(src)
      fs.utimesSync(dst, st.atime, st.mtime)
      count++
    }
    // symlinks/other types: skipped (never drag link targets into the ws)
  }
  return count
}

/** collect 上行: recursively scan `wsAbsSpecDir` and copy back into
 *  `homeAbsSpecDir` only what the execution side authored:
 *    - file new in ws (no home counterpart) → copy (spec*.md new files flow
 *      back too);
 *    - existing home file + ws mtime strictly newer → copy — INCLUDING
 *      spec*.md: the execution side reviews/updates the spec in the ws
 *      (ADR-0018 ws 权威), so home's copy follows to the final state;
 *    - otherwise (equal/older mtime) → skip (idempotent re-collect).
 *  Missing ws dir → [] (ws deleted out of band: nothing to recover, home holds
 *  the last collected state — AC4 premise). Returns collected ws-relative paths. */
export function collectFromWorkspace(
  wsAbsSpecDir: string,
  homeAbsSpecDir: string,
): string[] {
  const collected: string[] = []
  if (!wsAbsSpecDir || !homeAbsSpecDir) return collected
  if (!fs.existsSync(wsAbsSpecDir) || !fs.statSync(wsAbsSpecDir).isDirectory()) return collected
  walkTree(wsAbsSpecDir, "", wsAbsSpecDir, homeAbsSpecDir, collected)
  return collected
}

function walkTree(
  dir: string,
  rel: string,
  wsAbsSpecDir: string,
  homeAbsSpecDir: string,
  collected: string[],
): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name
    const wsFile = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkTree(wsFile, childRel, wsAbsSpecDir, homeAbsSpecDir, collected)
      continue
    }
    if (!entry.isFile()) continue
    const homeFile = path.join(homeAbsSpecDir, childRel)
    const homeExists = fs.existsSync(homeFile)
    if (homeExists) {
      // Execution-side (ws) authority across the whole batch dir (ADR-0018):
      // flow back only what the round actually touched (strictly-newer mtime;
      // seed preserves mtimes so an untouched round re-collects as a no-op).
      const wsMtime = fs.statSync(wsFile).mtimeMs
      const homeMtime = fs.statSync(homeFile).mtimeMs
      if (wsMtime <= homeMtime) continue
    }
    fs.mkdirSync(path.dirname(homeFile), { recursive: true })
    fs.copyFileSync(wsFile, homeFile)
    // Symmetric with seed: carry the execution-side edit mtime into home so a
    // later home-side edit (strictly newer) still wins the next seed, and an
    // untouched re-collect stays a no-op.
    const st = fs.statSync(wsFile)
    fs.utimesSync(homeFile, st.atime, st.mtime)
    collected.push(childRel)
  }
}
