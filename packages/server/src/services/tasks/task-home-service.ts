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
// task-workflow-handoff (ADR-0013): task home owns a `workflows/` directory for
// agent-authored workflow YAMLs. Dispatch copies these into the execution ws
// workflows/ (via WorkflowExecutor.execute post-createFromSpec).
const WORKFLOWS_DIR = "workflows"
const RULES_DIR = path.join(".claude", "rules")
const RULES_FILENAME = "task-context.md"
const CONTEXT_FILENAME = "context.md"
const SPEC_FILENAME = "spec.json"

/** A project reference with name and optional filesystem path. When `path` is
 *  resolved the agent knows where the codebase lives on disk; when unresolved
 *  (path absent) only the name is shown so the agent at least knows the name. */
export interface ProjectRef {
  name: string
  path?: string
}

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

  /** Directory holding agent-authored workflow YAMLs (ADR-0013). Dispatch
   *  copies these into the execution ws `workflows/` so the engine's existing
   *  `{ws}/workflows/` resolver finds them. Pure path — no FS side effect. */
  workflowsDir(taskId: string): string {
    return path.join(this.homePath(taskId), WORKFLOWS_DIR)
  }

  /** Read a workflow YAML from `{home}/workflows/{ref}` (ADR-0013). `ref` is
   *  a filename in the workflows/ directory (e.g. `my-flow.yaml`). Returns the
   *  file content on hit, null on miss. Rejects path-escape attempts (ref
   *  must be a bare filename with no `/`, `\`, `..`). */
  readWorkflowFile(taskId: string, ref: string): string | null {
    // Path-injection guard — ref must be a bare filename (no separators or escapes).
    if (ref.includes("/") || ref.includes("\\") || ref.includes("..") || ref.includes("\0")) {
      return null
    }
    const dir = this.workflowsDir(taskId)
    const filePath = path.join(dir, ref)
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return null
    }
    return fs.readFileSync(filePath, "utf-8")
  }

  /** List YAML filenames in `{home}/workflows/` (ADR-0013). Returns [] when
   *  the directory is missing or empty. Bare filenames only (no path prefix). */
  listWorkflowFiles(taskId: string): string[] {
    const dir = this.workflowsDir(taskId)
    if (!fs.existsSync(dir)) return []
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => (f.endsWith(".yaml") || f.endsWith(".yml")) && fs.statSync(path.join(dir, f)).isFile())
    } catch {
      return []
    }
  }

  /** Path to artifacts.json (may not exist yet). */
  private artifactsJsonPath(taskId: string): string {
    return path.join(this.artifactsDir(taskId), ARTIFACTS_JSON)
  }

  /** Create the home skeleton: `tasks/{id}/` + `skills/` + `artifacts/` +
   *  `.claude/rules/task-context.md` + `context.md` + `spec.json`. Idempotent
   *  (mkdir recursive). Returns the home path.
   *
   *  Design split (prompt-cache friendly):
   *    - Rules file = **static constraints** (SDK-loaded, CLAUDE.md priority):
   *      cwd, relative-path resolution, artifacts dir, path rules.
   *      References `context.md` for dynamic state.
   *    - context.md = **dynamic state** (org, projects, skill groups):
   *      Read by the agent on demand. Rewritten when state changes.
   *    - spec.json = **structured goal/ac snapshot**: the task-author agent
   *      reads it for the current goal/ac/confirmations instead of curling the
   *      API. Written with an empty baseline at creation; `writeSpecFile`
   *      refreshes it whenever the task_spec changes.
   *    - System prompt = **no dynamic context** — only static persona + skill
   *      content. Prompt cache stays stable across turns. */
  createHome(taskId: string, opts: { org?: string; projects?: ProjectRef[]; skillGroups?: string[] } = {}): string {
    const home = this.homePath(taskId)
    fs.mkdirSync(path.join(home, SKILLS_DIR), { recursive: true })
    fs.mkdirSync(path.join(home, ARTIFACTS_DIR), { recursive: true })
    // task-workflow-handoff (ADR-0013): workflows/ for agent-authored YAMLs.
    // Dispatch copies these into the execution ws workflows/ so the engine
    // resolver hits them. Empty at creation; the agent (or a seed) writes.
    fs.mkdirSync(path.join(home, WORKFLOWS_DIR), { recursive: true })
    fs.mkdirSync(path.join(home, RULES_DIR), { recursive: true })
    this.writeTaskContextRule(taskId)
    this.writeContextFile(taskId, opts.org, opts.projects, opts.skillGroups)
    this.writeSpecFile(taskId, { version: 1, spec: {}, updated_at: new Date().toISOString() })
    return home
  }

  /** Write (or refresh) `context.md` in the task home root. Contains the
   *  dynamic workspace state: org, locked projects (with filesystem paths),
   *  locked skill groups. The agent reads this file on demand (triggered by
   *  @@context_updated notice) instead of receiving the state in the system
   *  prompt. This keeps the system prompt stable for prompt caching. */
  writeContextFile(taskId: string, org?: string, projects?: ProjectRef[], skillGroups?: string[]): void {
    const home = this.homePath(taskId)
    const filePath = path.join(home, CONTEXT_FILENAME)
    try {
      const lines = ['# Workspace Context', '']
      if (org) lines.push(`- org: ${org}`)
      lines.push(`- cwd: ${home}`)
      if (projects && projects.length > 0) {
        for (const p of projects) {
          if (p.path) {
            lines.push(`- project: ${p.name}  →  ${p.path}`)
          } else {
            lines.push(`- project: ${p.name}  (路径未解析)`)
          }
        }
      }
      if (skillGroups && skillGroups.length > 0) {
        lines.push(`- locked skill groups: ${skillGroups.join(', ')}`)
      }
      lines.push('')
      // 06: point the agent at the structured goal/ac snapshot (spec.json) —
      // the file it should read for goal/ac instead of curling the API.
      lines.push('- 当前 goal/ac/确认状态快照见同目录 `spec.json`（每次 spec-field 保存后由 server 重写，权威）')
      lines.push('')
      lines.push('> 此文件由系统维护。当"编写语境"变更时自动更新。')
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.warn(
        `[task-home] writeContextFile for ${taskId} failed (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /** Write (or refresh) `{home}/spec.json` — a structured snapshot of the
   *  current task_spec (goal, ac, confirmations, decisions, …). The
   *  task-author agent reads this file for goal/ac instead of curling the REST
   *  API (deterministic — it may miss the skill's API instructions on an early
   *  turn, but the rules file always points it here). Rewritten on every
   *  spec-field update / PUT / creation (see TasksService.writeSpecSnapshot).
   *
   *  No home dir → silent no-op (legacy/v2 tasks have no home; the agent falls
   *  back to the API). Best-effort: a failed write must not break the
   *  spec-field path. */
  writeSpecFile(
    taskId: string,
    payload: { version: number; spec: Record<string, unknown>; updated_at: string },
  ): void {
    const home = this.homePath(taskId)
    if (!fs.existsSync(home)) return
    try {
      fs.writeFileSync(
        path.join(home, SPEC_FILENAME),
        JSON.stringify(
          {
            task_id: taskId,
            version: payload.version,
            updated_at: payload.updated_at,
            spec: payload.spec,
          },
          null,
          2,
        ),
        'utf-8',
      )
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.warn(
        `[task-home] writeSpecFile for ${taskId} failed (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /** Ensure `context.md` exists. No-op when the file is already present.
   *  Called from the chat route so existing task homes get backfilled. */
  ensureContextFile(taskId: string, org?: string, projects?: ProjectRef[], skillGroups?: string[]): void {
    const home = this.homePath(taskId)
    if (!fs.existsSync(home)) return
    const filePath = path.join(home, CONTEXT_FILENAME)
    if (fs.existsSync(filePath)) return
    this.writeContextFile(taskId, org, projects, skillGroups)
  }

  /** Write `.claude/rules/task-context.md` — static path constraints + a
   *  reference to `context.md` for dynamic state. The rules file is loaded by
   *  the SDK at session start (CLAUDE.md priority). Its content is static so
   *  prompt cache stays stable. Dynamic state (org, projects, skill groups)
   *  lives in context.md — the agent reads it on demand. */
  private writeTaskContextRule(taskId: string): void {
    const home = this.homePath(taskId)
    const rulePath = path.join(home, RULES_DIR, RULES_FILENAME)
    const artifactsDir = path.join(home, ARTIFACTS_DIR)
    try {
      const content = [
        '---',
        'description: "Task workspace path constraints — HIGHEST PRIORITY"',
        'alwaysApply: true',
        '---',
        '',
        '# ⛔ 路径强制规则（最高优先级，不可违反）',
        '',
        `你的工作目录是：${home}`,
        `你的产物目录是：${artifactsDir}`,
        '',
        '## 强制：所有文件必须写入工作目录内',
        '',
        `1. **必须** 将所有输出文件写入工作目录或其子目录`,
        `2. **必须** 将正式产物写入 \`${artifactsDir}\``,
        `3. **禁止** 写入工作目录之外的任何路径 — 包括项目代码库、系统目录、用户主目录等`,
        `4. **禁止** 因为你"认为"某个路径更合适就写入工作目录之外`,
        `5. 如果用户要求你写入项目代码库，**拒绝并说明**你只能在工作目录内操作`,
        '',
        '## 路径解析',
        '',
        '- 技能中的相对路径（如 `docs/superpowers/specs/...`）→ 相对于工作目录解析',
        '- 创建文件前，展示完整绝对路径（= 工作目录 + 相对路径）供用户确认',
        '- 产物写入 `artifacts/` 后，在 `artifacts.json` 登记索引条目',
        '- 外部资源用绝对路径并登记 `external: true`',
        '',
        '## 违反后果',
        '',
        '写入工作目录之外的文件会被系统 **强制阻止**（hook 拦截）。',
        '不要尝试写入 — 会被拒绝并浪费你的 turn。',
        '',
        '## 工作上下文',
        '',
        '- 当前工作上下文（org、项目、技能组）见 `context.md`',
        '- 当前 goal/ac/确认状态快照见 `spec.json`（每次 spec-field 保存后由 server 重写；权威本地快照，不必 curl API）',
        '- 当收到 `@@context_updated` 通知时，请重新读取 `context.md` 获取最新值',
      ].join('\n')
      fs.writeFileSync(rulePath, content, 'utf-8')
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.warn(
        `[task-home] writeTaskContextRule for ${taskId} failed (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /** Ensure the `.claude/rules/task-context.md` file exists. No-op if the
   *  file is already present (idempotent — the content is deterministic from
   *  the home path). Called from the chat route so that existing task homes
   *  (created before the rules feature) get backfilled on the first chat
   *  turn. One stat call per turn; the write only happens once. */
  ensureRulesFile(taskId: string): void {
    const home = this.homePath(taskId)
    if (!fs.existsSync(home)) return
    const rulePath = path.join(home, RULES_DIR, RULES_FILENAME)
    if (fs.existsSync(rulePath)) return
    fs.mkdirSync(path.join(home, RULES_DIR), { recursive: true })
    this.writeTaskContextRule(taskId)
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
