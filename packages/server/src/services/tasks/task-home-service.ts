// packages/server/src/services/tasks/task-home-service.ts
//
// TaskHomeService — the filesystem foundation for "register, don't relocate"
// (ADR-0011). Each task derives a home directory `~/.octopus/tasks/{id}/` by
// id alone (NO DB field — the path is deterministic). Owns:
//   - createHome: the skills/ + artifacts/ skeleton (ADR-0010 / ADR-0011).
//   - readArtifacts: SCAN-FIRST — the filesystem under artifacts/ is the source
//     of truth for "what did this task produce"; artifacts.json is an optional
//     ENRICHMENT layer (by/title overlay + external absolute-path entries).
//     Missing/corrupted index → [] (still lists the dir); invalid entries
//     dropped (SW-BP12).
//   - writeArtifactEntry: register/enrich one index row (rejects invalid,
//     AC3; upserts by path).
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
// The home manifest: a structured snapshot of task_spec (format / phases 绑定 /
// decisions / …) — metadata, NOT a spec document. Renamed from spec.json
// (2026-09): the old name collided with the per-phase `spec.md` authority it
// merely points at. LEGACY_SPEC_FILENAME drives the lazy migration (§writeManifestFile).
const MANIFEST_FILENAME = "manifest.json"
const LEGACY_SPEC_FILENAME = "spec.json"
export { MANIFEST_FILENAME, LEGACY_SPEC_FILENAME }
// v3-only task_spec keys. The shared schema defaults them into EVERY task_spec
// (scheduler-job.ts — `ac_confirmed: []` etc.), which polluted v4 snapshots with
// dead v3 vocabulary. Filtered on the manifest WRITE side only — the DB row and
// the v3 read paths keep them untouched.
export const V3_ONLY_SPEC_KEYS: readonly string[] = [
  "goal",
  "ac",
  "goal_confirmed",
  "ac_confirmed",
  "subunits",
  "integration_goal",
  "input_values",
  "workflow_ref",
  "task_type",
]
// 契约修复 (v4 batch area): the ONLY subtree of the task home the UI home-file
// endpoint reads/writes — v4 phase spec.md live here (`.scratch/<date>/<slug>/`).
const BATCH_AREA_PREFIX = ".scratch"

/** A project reference with name and optional filesystem path. When `path` is
 *  resolved the agent knows where the codebase lives on disk; when unresolved
 *  (path absent) only the name is shown so the agent at least knows the name. */
export interface ProjectRef {
  name: string
  path?: string
}

/** Matt-convention files probed per selected project when context.md is
 *  written (task-phase-redesign ticket 09, AC3; decisions/06 §2/§4). The
 *  server does a cheap existence check so the agent's domain-reading step
 *  starts from the probe RESULT, not a blind ls — reads are unrestricted in
 *  draft sessions (decisions/06 §1). All four missing ⇒ the project is
 *  annotated 「无领域文档 project」 and the skill degrades (US2). */
const CONVENTION_PROBES: ReadonlyArray<{ label: string; rel: string }> = [
  { label: "CONTEXT-MAP.md", rel: "CONTEXT-MAP.md" },
  { label: "CONTEXT.md", rel: "CONTEXT.md" },
  { label: "docs/adr/", rel: path.join("docs", "adr") },
  { label: ".scratch/index.md", rel: path.join(".scratch", "index.md") },
]

/** One-line existence summary for a project dir. Any error (unreadable dir)
 *  degrades to "all missing" — the probe is advisory, never fatal. */
function probeProjectConventions(projectPath: string): { line: string; allMissing: boolean } {
  const marks = CONVENTION_PROBES.map(({ label, rel }) => {
    let found = false
    try {
      found = fs.existsSync(path.join(projectPath, rel))
    } catch {
      found = false
    }
    return `${label} ${found ? "✓" : "—"}`
  })
  const allMissing = marks.every((m) => m.endsWith("—"))
  return {
    line: allMissing
      ? "领域文档 probe: 惯例文件全部缺失 — 按「无领域文档 project」降级（以 README/代码结构为准，并在 brief/spec 标注）"
      : `领域文档 probe: ${marks.join(" · ")}`,
    allMissing,
  }
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
   *  `.claude/rules/task-context.md` + `context.md` + `manifest.json`. Idempotent
   *  (mkdir recursive). Returns the home path.
   *
   *  Design split (prompt-cache friendly):
   *    - Rules file = **static constraints** (SDK-loaded, CLAUDE.md priority):
   *      cwd, relative-path resolution, artifacts dir, path rules.
   *      References `context.md` for dynamic state.
   *    - context.md = **dynamic state** (org, projects, skill groups):
   *      Read by the agent on demand. Rewritten when state changes.
   *    - manifest.json = **structured task_spec snapshot** (format / phases
   *      绑定 / decisions / …): the task-author agent reads it for the current
   *      spec state instead of curling the API. Written with an empty baseline
   *      at creation; `writeManifestFile` refreshes it whenever the task_spec
   *      changes. (Metadata index — NOT a spec document; the phase specs live
   *      under `.scratch/…` and manifest's phases[].specPath points at them.)
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
    this.writeManifestFile(taskId, { version: 1, spec: {}, updated_at: new Date().toISOString() })
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
            // ticket 09 (AC3): probe RESULT rides under the path line — the
            // agent's 领域阅读 step reads these instead of blind-ls'ing.
            lines.push(`  - ${probeProjectConventions(p.path).line}`)
          } else {
            lines.push(`- project: ${p.name}  (路径未解析)`)
          }
        }
        lines.push('')
        // Probe guidance (US2 / decisions/06 §4): which conventions, how to
        // read them, and the degradation rule. Lives in context.md (dynamic —
        // refreshed with the paths) NOT in the static rules file.
        lines.push('## 领域阅读指引（matt 惯例 — 起草前逐 project 执行）')
        lines.push('')
        lines.push('- 惯例四件套（绝对路径 = 上方各 project 路径 + 下列相对路径）：')
        lines.push('  1. `CONTEXT-MAP.md` — 全局术语表 / 包索引')
        lines.push('  2. `CONTEXT.md` — 包级领域语言（monorepo 亦见 `packages/*/CONTEXT.md`）')
        lines.push('  3. `docs/adr/` — 决策记录（编号递增，新决策须顺延）')
        lines.push('  4. `.scratch/index.md` — 历史需求批次（`.scratch/<date>/<slug>/`）')
        lines.push('- 上方每个 project 已标注 server 写入时刻的 probe 结果（✓ 存在 / — 缺失）；agent 可直接按绝对路径 Read 全文。')
        lines.push('- 四件套全缺 → 该 project 按「无领域文档 project」降级：以 README/代码结构为准，并在 brief/spec 中标注。')
        lines.push('- 领域知识只读：术语进产物、ADR 号记入决策表；**不得写回 project 仓库**（草稿会话写锁强制，归并走归档）。')
      }
      if (skillGroups && skillGroups.length > 0) {
        lines.push(`- locked skill groups: ${skillGroups.join(', ')}`)
      }
      lines.push('')
      // 06 (renamed): point the agent at the structured task_spec snapshot
      // (manifest.json) — the file it should read instead of curling the API.
      lines.push('- 当前规格快照（format / phases / decisions）见同目录 `manifest.json`（每次 spec-field 保存后由 server 重写，权威）')
      lines.push('')
      lines.push('> 此文件由系统维护。当"codebase"变更时自动更新。')
      fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.warn(
        `[task-home] writeContextFile for ${taskId} failed (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /** Write (or refresh) `{home}/manifest.json` — a structured snapshot of the
   *  current task_spec (format, phases 绑定, decisions, …). The task-author
   *  agent reads this file for the spec state instead of curling the REST API
   *  (deterministic — it may miss the skill's API instructions on an early
   *  turn, but the rules file always points it here). Rewritten on every
   *  spec-field update / PUT / creation (see TasksService.writeManifestSnapshot).
   *
   *  v4 filtering: when `format === "v4"`, v3-only schema-default keys
   *  ({@link V3_ONLY_SPEC_KEYS}) are stripped — they're DB-compat noise, not
   *  v4 vocabulary. The DB row itself is never touched.
   *
   *  Lazy migration (rename from spec.json): if a legacy `{home}/spec.json`
   *  is present it's removed after the new write, and the static rules file
   *  (which used to point at the old name) is refreshed — both best-effort.
   *
   *  No home dir → silent no-op (legacy/v2 tasks have no home; the agent falls
   *  back to the API). Best-effort: a failed write must not break the
   *  spec-field path. */
  writeManifestFile(
    taskId: string,
    payload: { version: number; spec: Record<string, unknown>; updated_at: string; format?: string },
  ): void {
    const home = this.homePath(taskId)
    if (!fs.existsSync(home)) return
    try {
      let spec = payload.spec
      if (payload.format === "v4") {
        spec = { ...spec }
        for (const k of V3_ONLY_SPEC_KEYS) delete spec[k]
      }
      fs.writeFileSync(
        path.join(home, MANIFEST_FILENAME),
        JSON.stringify(
          {
            task_id: taskId,
            version: payload.version,
            updated_at: payload.updated_at,
            spec,
          },
          null,
          2,
        ),
        'utf-8',
      )
      // Lazy rename migration: drop the legacy spec.json + refresh the static
      // rules pointer (deterministic from the home path — no dynamic state
      // needed, so an unconditional rewrite is always safe). context.md is
      // refreshed by the chat route every turn (routes/clone writeContextFile),
      // so it self-heals without help from here.
      const legacy = path.join(home, LEGACY_SPEC_FILENAME)
      if (fs.existsSync(legacy)) {
        try {
          fs.rmSync(legacy)
          this.writeTaskContextRule(taskId)
        } catch {
          // non-fatal — stale pointer heals via ensureRulesFile's marker check
        }
      }
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.warn(
        `[task-home] writeManifestFile for ${taskId} failed (non-fatal):`,
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
        '- 产物写入 `artifacts/` 后会自动出现在产出清单中；如需补充标题/说明/分组，再在 `artifacts.json` 登记增强条目',
        '- 外部资源（不在工作目录内）必须用绝对路径并在 `artifacts.json` 登记 `external: true`，否则无法读取',
        '',
        '## 违反后果',
        '',
        '写入工作目录之外的文件会被系统 **强制阻止**（hook 拦截）。',
        '不要尝试写入 — 会被拒绝并浪费你的 turn。',
        '',
        '## 工作上下文',
        '',
        '- 当前工作上下文（org、项目、技能组）见 `context.md`',
        '- 当前规格快照（format / phases / decisions）见 `manifest.json`（每次 spec-field 保存后由 server 重写；权威本地快照，不必 curl API）',
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

  /** Ensure `.claude/rules/task-context.md` is present AND current. Backfills
   *  when missing; self-heals when stale (pre-rename homes still point the
   *  agent at spec.json — one content scan per chat turn, cheap). Also runs
   *  the lazy spec.json→manifest.json rename so an old home's snapshot survives
   *  under the new name even before its first snapshot write. Called from the
   *  chat route (per-turn backfill for homes predating the rules feature). */
  ensureRulesFile(taskId: string): void {
    const home = this.homePath(taskId)
    if (!fs.existsSync(home)) return
    const rulePath = path.join(home, RULES_DIR, RULES_FILENAME)
    if (fs.existsSync(rulePath)) {
      let stale = false
      try {
        stale = fs.readFileSync(rulePath, "utf-8").includes(LEGACY_SPEC_FILENAME)
      } catch {
        stale = false
      }
      if (!stale) return
    }
    fs.mkdirSync(path.join(home, RULES_DIR), { recursive: true })
    // Rename-migration BEFORE the rewrite: preserve the snapshot content.
    try {
      const legacy = path.join(home, LEGACY_SPEC_FILENAME)
      const manifest = path.join(home, MANIFEST_FILENAME)
      if (fs.existsSync(legacy) && !fs.existsSync(manifest)) {
        fs.renameSync(legacy, manifest)
      }
    } catch {
      // non-fatal — GET /context's read fallback still serves the legacy file
    }
    this.writeTaskContextRule(taskId)
  }

  /** Read the task's artifact index — the answer to "what did this task produce".
   *  SCAN-FIRST (bugfix redesign 2026-08-26): the filesystem is the source of
   *  truth. Every file under `artifacts/` is a deliverable; artifacts.json is an
   *  optional ENRICHMENT layer that overlays by/title on matching files and
   *  carries external=true entries (absolute paths OUTSIDE the dir — 登记不搬迁,
   *  ADR-0011), which a scan can't see. Internal index entries whose file is
   *  gone are dropped (deleted = gone). There is no schema drift possible — an
   *  LLM session can write files without a valid index and they still show up. */
  readArtifacts(taskId: string): ArtifactIndexEntry[] {
    const dir = this.artifactsDir(taskId)

    // 1. Filesystem truth: recursively list every real file under artifacts/.
    const scanned = this.scanArtifactDir(dir)

    // 2. Index enrichment (tolerant read — both flat-array and LLM grouped-
    //    object forms). by/title overlay on matching files; external entries
    //    are appended since they live outside the dir.
    const indexEntries = this.readArtifactsIndex(taskId)

    const merged: ArtifactIndexEntry[] = []
    const seen = new Set<string>()

    for (const fileEntry of scanned) {
      const indexHit = indexEntries.find((ie) => !ie.external && ie.path === fileEntry.path)
      merged.push(
        indexHit
          ? { ...fileEntry, by: indexHit.by, title: indexHit.title }
          : fileEntry,
      )
      seen.add(fileEntry.path)
    }

    for (const ie of indexEntries) {
      if (!ie.external || seen.has(ie.path)) continue
      seen.add(ie.path)
      merged.push(ie)
    }

    return merged
  }

  /** Recursively list every real file under the artifacts dir (the index file
   *  itself excluded) as an ArtifactIndexEntry-shaped candidate: relative path,
   *  basename title, filesystem attribution, mtime as updated_at. This is the
   *  scan-first base — the index only enriches it. Unreadable subdirs are
   *  skipped (SW-BP12 defense-in-depth). */
  private scanArtifactDir(dir: string): ArtifactIndexEntry[] {
    if (!fs.existsSync(dir)) return []
    const out: ArtifactIndexEntry[] = []
    const walk = (rel: string): void => {
      let dirents: fs.Dirent[]
      try {
        dirents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
      } catch {
        return // unreadable — skip (SW-BP12: don't let one bad dir break GET)
      }
      for (const ent of dirents) {
        const child = rel ? path.join(rel, ent.name) : ent.name
        if (ent.isDirectory()) {
          walk(child)
          continue
        }
        if (child === ARTIFACTS_JSON) continue // the index itself isn't an artifact
        let mtime: string
        try {
          mtime = fs.statSync(path.join(dir, child)).mtime.toISOString()
        } catch {
          mtime = new Date(0).toISOString()
        }
        out.push({
          path: child.split(path.sep).join("/"), // normalise separators (path contract)
          by: "filesystem",
          title: path.basename(child),
          external: false,
          updated_at: mtime,
        })
      }
    }
    walk("")
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return out
  }

  /** Tolerant read of artifacts.json only (the ENRICHMENT layer). Missing file
   *  → []. Corrupted JSON → [] + warn (SW-BP12). Accepts BOTH index shapes
   *  producers write:
   *    - the flat ARRAY of ArtifactIndexEntry (official writer — writeArtifactEntry);
   *    - a grouped OBJECT `{ task_id?, <group>: [entries], external?: [...] }`
   *      that LLM sessions write directly (e.g. the `grill-aftermath` register).
   *      Array-valued keys are entry groups; the `external` group marks
   *      absolute-path (external) entries.
   *  Loose entries (`{ path, kind, desc }`) are normalized into the contract
   *  shape (by/title/external/updated_at defaults). Per-entry invalid rows are
   *  dropped (defense-in-depth — a bad row must not break GET). */
  private readArtifactsIndex(taskId: string): ArtifactIndexEntry[] {
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

    const candidates = this.collectArtifactCandidates(parsed, taskId)

    const valid: ArtifactIndexEntry[] = []
    for (const candidate of candidates) {
      const normalized = this.normalizeArtifactEntry(candidate, taskId)
      if (!normalized) continue
      // Dedupe by path — the merged layer keyed on path assumes unique entries
      // (flat-array upsert keeps the latest, but a hand-written index may dup).
      if (valid.some((existing) => existing.path === normalized.path)) continue
      valid.push(normalized)
    }
    return valid
  }

  /** Flatten the parsed index file into candidate entry objects. Flat-array
   *  form → entries as-is. Grouped-object form → entries of every array-valued
   *  key; the `external` group marks absolute-path entries (`external: true`
   *  unless the entry already carries its own flag). An unusable shape (not an
   *  array, no array-valued group) → warn + []. */
  private collectArtifactCandidates(
    parsed: unknown,
    taskId: string,
  ): Array<Record<string, unknown>> {
    if (Array.isArray(parsed)) {
      return parsed
        .filter((e): e is Record<string, unknown> =>
          !!e && typeof e === "object" && !Array.isArray(e))
        .map((e) => ({ ...e }))
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>
      const out: Array<Record<string, unknown>> = []
      for (const [key, value] of Object.entries(obj)) {
        if (!Array.isArray(value)) continue
        for (const e of value) {
          if (!e || typeof e !== "object" || Array.isArray(e)) continue
          const entry = { ...(e as Record<string, unknown>) }
          if (entry.external === undefined && key === "external") entry.external = true
          out.push(entry)
        }
      }
      if (out.length > 0) return out
      // eslint-disable-next-line no-console
      console.warn(
        `[task-home] artifacts.json for ${taskId} is not an array and has no group lists — returning [].`,
      )
      return []
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[task-home] artifacts.json for ${taskId} is not an array — returning [].`,
    )
    return []
  }

  /** Coerce a candidate into the ArtifactIndexEntry contract, filling
   *  best-effort defaults for loose LLM-written entries (`{path, kind, desc}`):
   *  by="task-author", title=desc ?? basename(path), external from group/field,
   *  updated_at = the artifact file's mtime (epoch when the file is missing). */
  private normalizeArtifactEntry(
    candidate: Record<string, unknown>,
    taskId: string,
  ): ArtifactIndexEntry | null {
    const direct = artifactIndexEntrySchema.safeParse(candidate)
    if (direct.success) return direct.data

    const rawPath = candidate.path
    if (typeof rawPath !== "string" || rawPath.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[task-home] artifacts.json entry for ${taskId} has no path — dropped.`,
      )
      return null
    }
    const external = typeof candidate.external === "boolean" ? candidate.external : false
    const listedTitle =
      (typeof candidate.title === "string" && candidate.title)
        ? candidate.title
        : (typeof candidate.desc === "string" && candidate.desc)
          ? candidate.desc
          : undefined
    const entry: unknown = {
      path: rawPath,
      by: typeof candidate.by === "string" && candidate.by ? candidate.by : "task-author",
      title: listedTitle ?? path.basename(rawPath),
      external,
      updated_at:
        typeof candidate.updated_at === "string" && candidate.updated_at
          ? candidate.updated_at
          : this.artifactMtime(taskId, rawPath, external) ?? new Date(0).toISOString(),
    }
    if (!artifactIndexEntrySchema.safeParse(entry).success) {
      // Unreachable in practice (path/by/title/external/updated_at all filled)
      // — keep the parse as the last gate (no second writer of bad rows).
      // eslint-disable-next-line no-console
      console.warn(
        `[task-home] artifacts.json entry for ${taskId} could not be normalized — dropped.`,
      )
      return null
    }
    return entry as ArtifactIndexEntry
  }

  /** Best-effort mtime of the artifact file (mtime → updated_at fallback for
   *  loose entries). Missing file → null (caller falls back to epoch). */
  private artifactMtime(taskId: string, relOrAbs: string, external: boolean): string | null {
    try {
      const abs = external ? relOrAbs : path.join(this.artifactsDir(taskId), relOrAbs)
      const st = fs.statSync(abs)
      return st.mtime.toISOString()
    } catch {
      // eslint-disable-next-line no-console
      return null
    }
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

  // ── Home-file read/write (契约修复: v4 phase spec.md 审阅/编辑面) ─────────
  //
  // The kanban's PhaseListEditor needs to VIEW and EDIT a phase's spec.md
  // (`./.scratch/<YYYYMMDD>/<slug>/spec.md`, home-relative — the SKILL batch
  // convention). readArtifactContent can't serve it: relative paths there
  // resolve against artifacts/, so a `.scratch/...` path would `..`-escape → 403.
  // These two methods share its guard idiom (null bytes / resolve+relative
  // no-escape / ArtifactAccessError FORBIDDEN|NOT_FOUND) but base at the home
  // root, narrowed to the batch area only:
  //   • first segment must be `.scratch`  — context.md/manifest.json already have
  //     GET /:id/context, artifacts/ has its own endpoint, skills/ + .claude/
  //     are system-managed. Nothing legitimately editable lives elsewhere.
  //   • `.md` suffix (read AND write)     — spec.md/brief.md/issues/*.md are
  //     all markdown; no executables land through this door.
  //   • absolute paths rejected outright  — gateV4 accepts absolute specPaths
  //     (agent direct-writes), but the UI editor only serves home-relative.
  // Write creates parents (mkdir -p) so a UI-added phase row can seed its spec
  // skeleton before enqueue; overwrite-style, idempotent (no version column
  // involved — file content is not the task row).

  /** Guard shared by readHomeFile/writeHomeFile. Returns the resolved absolute
   *  path, or throws ArtifactAccessError (FORBIDDEN) on any rule violation. */
  private resolveHomeFile(taskId: string, requestedPath: string): string {
    if (requestedPath.includes("\0")) {
      throw new ArtifactAccessError(
        "home-file path must not contain null bytes",
        "FORBIDDEN",
      )
    }
    if (path.isAbsolute(requestedPath)) {
      throw new ArtifactAccessError(
        `absolute paths are not served by home-file (relative to the task home only): ${requestedPath}`,
        "FORBIDDEN",
      )
    }
    const home = this.homePath(taskId)
    const resolved = path.resolve(home, requestedPath)
    const rel = path.relative(home, resolved)
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ArtifactAccessError(
        `path escapes the task home: ${requestedPath}`,
        "FORBIDDEN",
      )
    }
    // rel uses platform separators; normalize for the segment/suffix checks.
    const posixRel = rel.split(path.sep).join("/")
    if (!posixRel.startsWith(`${BATCH_AREA_PREFIX}/`)) {
      throw new ArtifactAccessError(
        `path not whitelisted: ${requestedPath} (only ${BATCH_AREA_PREFIX}/** is editable here)`,
        "FORBIDDEN",
      )
    }
    if (!posixRel.toLowerCase().endsWith(".md")) {
      throw new ArtifactAccessError(
        `path not whitelisted: ${requestedPath} (only .md files are editable here)`,
        "FORBIDDEN",
      )
    }
    return resolved
  }

  /** Read a `.scratch/**.md` file relative to the task home. NOT_FOUND (404)
   *  when the whitelisted path is missing — the UI maps that to its "create
   *  skeleton" empty state. */
  readHomeFile(taskId: string, requestedPath: string): { path: string; content: string } {
    const resolved = this.resolveHomeFile(taskId, requestedPath)
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new ArtifactAccessError(
        `batch file not found: ${requestedPath}`,
        "NOT_FOUND",
      )
    }
    const content = fs.readFileSync(resolved, "utf-8")
    return { path: requestedPath, content }
  }

  /** Write (create or overwrite) a `.scratch/**.md` file under the task home,
   *  creating parent dirs on the way. Returns the byte count written. */
  writeHomeFile(taskId: string, requestedPath: string, content: string): { path: string; bytes: number } {
    const resolved = this.resolveHomeFile(taskId, requestedPath)
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    fs.writeFileSync(resolved, content, "utf-8")
    return { path: requestedPath, bytes: Buffer.byteLength(content, "utf-8") }
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
