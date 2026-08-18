// packages/server/src/services/tasks/task-home-service.ts
//
// TaskHomeService — the filesystem foundation for "register, don't relocate"
// (ADR-0011). Each task derives a home directory `~/.octopus/tasks/{id}/` by
// id alone (NO DB field — the path is deterministic). Owns:
//   - createHome: the skills/ + artifacts/ skeleton (ADR-0010 / ADR-0011).
//   - readArtifacts / writeArtifactEntry: the artifacts.json index — the single
//     source of truth for "what did this task produce". Missing → []; corrupted
//     JSON → [] + warn (SW-BP12). Invalid entries rejected on write (AC3).
//   - reapHome: delete the whole home WITHOUT following junctions/symlinks
//     (SW-BP14 — a link inside skills/ must not drag its target into the void).
//
// Testability: the constructor takes an optional `baseDir` so tests inject a
// temp dir and never touch the real ~/.octopus (mirrors org.ts' baseDir pattern).
// Production callers omit it → `os.homedir()/.octopus`.
//
// Not this ticket's lane: wiring reapHome into DELETE /api/tasks/:id (ticket 03),
// the plugin-materializer that creates the skills/ junctions (separate ticket),
// and the `$vars.task_artifacts_dir` injection at dispatch (ticket 06).

import fs from "fs"
import path from "path"
import os from "os"
import {
  artifactIndexEntrySchema,
  type ArtifactIndexEntry,
} from "@octopus/shared"

const SKILLS_DIR = "skills"
const ARTIFACTS_DIR = "artifacts"
const ARTIFACTS_JSON = "artifacts.json"

/** Thrown by {@link TaskHomeService.readArtifactContent} when a requested path
 *  fails the whitelist (`FORBIDDEN` → HTTP 403) or passes the whitelist but the
 *  file is missing on disk (`NOT_FOUND` → HTTP 404). Mirrors the
 *  `AssistWorkflowError` code-field pattern so the route's `classifyError` maps
 *  codes to statuses without instanceof chains per code.
 *
 *  Why the whitelist lives here (not the route): the route must stay a thin
 *  delegate (mirrors the assist-workflow route pair). The whitelist is a
 *  filesystem concern — it needs the task's artifacts/ dir (pure derivation
 *  here) and the index (read here) to decide "is this path ours to serve". */
export class ArtifactAccessError extends Error {
  constructor(
    message: string,
    public readonly code: "FORBIDDEN" | "NOT_FOUND",
  ) {
    super(message)
    this.name = "ArtifactAccessError"
  }
}

export class TaskHomeService {
  private readonly baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), ".octopus")
  }

  /** Pure derivation of the task home path from the id. NO fs side effect, NO
   *  DB field (ADR-0011). `homePath(id) === base/tasks/id`. */
  homePath(taskId: string): string {
    return path.join(this.baseDir, "tasks", taskId)
  }

  /** Directory holding artifacts.json + native artifact files. */
  artifactsDir(taskId: string): string {
    return path.join(this.homePath(taskId), ARTIFACTS_DIR)
  }

  /** Path to artifacts.json (may not exist yet). */
  private artifactsJsonPath(taskId: string): string {
    return path.join(this.artifactsDir(taskId), ARTIFACTS_JSON)
  }

  /** Create the home skeleton: `tasks/{id}/` + `skills/` + `artifacts/`.
   *  Idempotent (mkdir recursive). Returns the home path. */
  createHome(taskId: string): string {
    const home = this.homePath(taskId)
    fs.mkdirSync(path.join(home, SKILLS_DIR), { recursive: true })
    fs.mkdirSync(path.join(home, ARTIFACTS_DIR), { recursive: true })
    return home
  }

  /** Read artifacts.json. Missing file → []. Corrupted JSON → [] + warn
   *  (SW-BP12). Non-array top-level → [] + warn. Per-entry schema-invalid
   *  rows are dropped (defense-in-depth — the writer rejects before persist,
   *  but a hand-edited or partial-write file must not break GET). */
  readArtifacts(taskId: string): ArtifactIndexEntry[] {
    const file = this.artifactsJsonPath(taskId)
    let raw: string
    try {
      raw = fs.readFileSync(file, "utf-8")
    } catch {
      // Missing file (ENOENT) — nothing registered yet. Not a warning: a
      // fresh task legitimately has no index.
      return []
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.warn(
        `[task-home] artifacts.json for ${taskId} is corrupted — returning []. (${msg})`,
      )
      return []
    }
    if (!Array.isArray(parsed)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[task-home] artifacts.json for ${taskId} is not an array — returning [].`,
      )
      return []
    }
    const valid: ArtifactIndexEntry[] = []
    for (let i = 0; i < parsed.length; i++) {
      const result = artifactIndexEntrySchema.safeParse(parsed[i])
      if (result.success) {
        valid.push(result.data)
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `[task-home] artifacts.json[${i}] for ${taskId} is invalid — dropped: ${result.error.message}`,
        )
      }
    }
    return valid
  }

  /** Append or upsert (by `path`) an artifact entry. The entry is validated
   *  against {@link artifactIndexEntrySchema} (reject invalid, AC3) and the
   *  external↔path consistency rule (AC5: external=true ⇒ absolute path,
   *  external=false ⇒ relative). The artifacts/ dir is created on demand so a
   *  caller that skipped {@link createHome} still persists. Returns the full
   *  index after the write. */
  writeArtifactEntry(taskId: string, entry: ArtifactIndexEntry): ArtifactIndexEntry[] {
    const validated = artifactIndexEntrySchema.parse(entry) as ArtifactIndexEntry
    assertPathExternalConsistency(validated)
    const file = this.artifactsJsonPath(taskId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const current = this.readArtifacts(taskId)
    const idx = current.findIndex((e) => e.path === validated.path)
    if (idx >= 0) current[idx] = validated
    else current.push(validated)
    fs.writeFileSync(file, JSON.stringify(current, null, 2), "utf-8")
    return current
  }

  /** Read the full content of one artifact (ticket 06, US7 / AC2/AC3/AC4). The
   *  whitelist has two branches:
   *    - Absolute path → MUST be registered in the index with `external===true`
   *      and an exact `path` match (AC2 — registered-not-relocated, ADR-0011).
   *      Unregistered absolute path → FORBIDDEN (403); registered but missing
   *      on disk → NOT_FOUND (404, AC4 — the UI shows a degraded state).
   *    - Relative path → resolved against the task's `artifacts/` dir and must
   *      NOT escape it (AC2 — `../` and cross-drive paths rejected). The
   *      canonical idiom: `path.relative(artDir, resolved)` must not start with
   *      `..` and must not be absolute (a cross-drive rel on Windows). Not
   *      required to be in the index — the home owns everything inside
   *      `artifacts/`. Missing on disk → NOT_FOUND (404).
   *
   *  Returns `{ path, content }` where `path` is the requested path verbatim
   *  (relative for internal, absolute for external — the caller/UI uses it as
   *  the identity key). `content` is the live disk content (== fs.readFileSync,
   *  AC3 — never a cached value). Null bytes are rejected upfront (path-
   *  injection guard). */
  readArtifactContent(
    taskId: string,
    requestedPath: string,
  ): { path: string; content: string } {
    // Path-injection guard — a null byte can truncate the path mid-component
    // in some native APIs; reject upfront rather than reason about it below.
    if (requestedPath.includes("\0")) {
      throw new ArtifactAccessError(
        "artifact path must not contain null bytes",
        "FORBIDDEN",
      )
    }

    const artDir = this.artifactsDir(taskId)

    if (path.isAbsolute(requestedPath)) {
      // External branch: must be a registered external entry (exact path match).
      const index = this.readArtifacts(taskId)
      const registered = index.some(
        (e) => e.external && e.path === requestedPath,
      )
      if (!registered) {
        throw new ArtifactAccessError(
          `path not whitelisted: ${requestedPath} (not a registered external artifact)`,
          "FORBIDDEN",
        )
      }
      if (!fs.existsSync(requestedPath)) {
        throw new ArtifactAccessError(
          `artifact file not found on disk: ${requestedPath}`,
          "NOT_FOUND",
        )
      }
      const content = fs.readFileSync(requestedPath, "utf-8")
      return { path: requestedPath, content }
    }

    // Internal branch: relative path resolved against the artifacts/ dir, must
    // not escape. path.resolve collapses `..` segments; path.relative then
    // yields the offset from artDir — if it starts with `..` or is absolute
    // (cross-drive on Windows), the path escaped.
    const resolved = path.resolve(artDir, requestedPath)
    const rel = path.relative(artDir, resolved)
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      // Escaped the artifacts dir (e.g. `../persona.md`) or landed on another
      // drive (Windows cross-drive rel is absolute). Reject as forbidden.
      throw new ArtifactAccessError(
        `path escapes the artifacts directory: ${requestedPath}`,
        "FORBIDDEN",
      )
    }
    // rel === "" means the path resolves to the artifacts dir itself (e.g.
    // path=".") — not a file, so NOT_FOUND rather than FORBIDDEN (not an escape).
    if (rel === "" || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new ArtifactAccessError(
        `artifact file not found: ${requestedPath}`,
        "NOT_FOUND",
      )
    }
    const content = fs.readFileSync(resolved, "utf-8")
    return { path: requestedPath, content }
  }

  /** Delete the whole task home. Junctions/symlinks inside the tree (the
   *  skills/ dir will contain them once the plugin-materializer runs) are
   *  unlinked as links, NOT followed into their targets (SW-BP14 — a deletion
   *  that followed a link would destroy a user's skill source dir). Idempotent
   *  on a missing home.
   *
   *  Implementation: a pre-pass walks the tree and `rmSync({recursive:false})`s
   *  every `lstat.isSymbolicLink()` entry (this covers Windows junctions —
   *  `fs.symlinkSync(t,p,'junction')` produces a reparse point that lstat
   *  reports as a symlink), THEN `rmSync(home,{recursive:true})` removes the
   *  now-link-free real tree. Node's rmSync already detaches links on current
   *  versions; the pre-pass is the explicit guarantee for AC4 and stays robust
   *  across Node versions / the top-level-junction case. */
  reapHome(taskId: string): void {
    const home = this.homePath(taskId)
    if (!fs.existsSync(home)) return
    this.unlinkLinksRecursive(home)
    fs.rmSync(home, { recursive: true, force: true })
  }

  /** Walk `dir` and unlink every symlink/junction in place (not following it).
   *  Recurses into real subdirectories so a link nested under skills/sub/.../
   *  is also detached before the top-level recursive rm. Best-effort: a
   *  missing/locked entry is warned and skipped rather than aborting the reap. */
  private unlinkLinksRecursive(dir: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      let lst: fs.Stats
      try {
        lst = fs.lstatSync(full)
      } catch {
        continue
      }
      if (lst.isSymbolicLink()) {
        try {
          fs.rmSync(full, { recursive: false, force: true })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          // eslint-disable-next-line no-console
          console.warn(
            `[task-home] reap: could not unlink link ${full} (non-fatal): ${msg}`,
          )
        }
      } else if (lst.isDirectory()) {
        this.unlinkLinksRecursive(full)
      }
    }
  }
}

/** AC5: an external entry's path must be absolute (native location, registered
 *  not relocated); an internal entry's path must be relative to the task's
 *  artifacts/ dir. Throws on mismatch so the route returns 400, not a silent
 *  bad row in the index. */
function assertPathExternalConsistency(entry: ArtifactIndexEntry): void {
  if (entry.external) {
    if (!path.isAbsolute(entry.path)) {
      throw new Error(
        `artifact entry external=true requires an absolute path, got: ${entry.path}`,
      )
    }
  } else {
    if (path.isAbsolute(entry.path)) {
      throw new Error(
        `artifact entry external=false requires a relative path, got: ${entry.path}`,
      )
    }
  }
}
