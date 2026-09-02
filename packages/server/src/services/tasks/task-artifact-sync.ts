// packages/server/src/services/tasks/task-artifact-sync.ts
//
// task-phase-redesign (ticket 06) — the ONE-WAY ARTIFACT LOOP (K9/K10/K16).
//
//   seed    (下行): {home}/.scratch/<date>/<slug>/  →  ws/.scratch/<date>/<slug>/
//     Physical copy before a v4 phase/round execution starts (mount points:
//     WorkflowExecutor.execute v4 branch + TasksService.dispatchPhaseRound —
//     same precedent as copyTaskWorkflowsToWs, ADR-0013). home OVERWRITES ws
//     same-name files: home is the spec authority and K16 makes "edits between
//     rounds take effect on the next seed" fall out for free. Idempotent.
//
//   collect (上行): ws/.scratch/<date>/<slug>/  →  {home}/.scratch/<date>/<slug>/
//     Terminal-state recovery of what the EXECUTION side changed. Single-writer
//     per file class (K9: 每类文件单写者单方向 ⇒ 无 merge):
//       - spec*.md            → home 权威: an EXISTING home file is never
//                                overwritten by the ws copy (AC3 — an agent
//                                mangling spec.md in the ws loses; home keeps
//                                its bytes). A brand-new spec file with no home
//                                counterpart still flows back (no 覆盖 happens).
//       - issues/报告/其它     → ws 权威: copied back when new in ws or when the
//                                ws mtime is strictly newer than home's (the
//                                agent edited it). Equal/older mtimes skip —
//                                re-collecting an untouched round is a no-op.
//     AC4 (防丢兜底): collect runs at EVERY v4 terminal transition, so the home
//     copy is complete before retention/eviction (or an out-of-band rm) can take
//     the ws away; deleting the ws afterwards loses nothing.
//
// Failures are the CALLER's to contain (non-fatal log-and-continue at every
// mount) — these functions just throw fs errors as-is, mirroring
// copyTaskWorkflowsToWs.

import fs from "fs"
import path from "path"

/** Batch dir basename classes with a SINGLE upstream rule — spec*.md is the
 *  draft-side (home) authority; everything else in the batch dir is execution-
 *  side (ws) authority per K9. */
const HOME_AUTHORITATIVE_RE = /^spec.*\.md$/i

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
 *    - file new in ws (no home counterpart) → copy (EXCEPT this is still a
 *      "new file", so spec*.md new files flow back — nothing is overwritten);
 *    - existing home file + HOME_AUTHORITATIVE (spec*.md) → SKIP (home 权威,
 *      AC3 — never overwrite);
 *    - existing home file + ws mtime strictly newer → copy (ws 权威类, AC2);
 *    - otherwise (equal/older mtime) → skip (idempotent re-collect).
 *  Missing ws dir → [] (ws deleted out of band: nothing to recover, home is
 *  already authoritative — AC4 premise). Returns collected ws-relative paths. */
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
      // Write-ownership discipline (K9/AC3): home 权威文件永不回流覆盖.
      if (HOME_AUTHORITATIVE_RE.test(entry.name)) continue
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
