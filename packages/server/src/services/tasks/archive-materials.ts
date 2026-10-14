// packages/server/src/services/tasks/archive-materials.ts
//
// 归档素材提取器 — P3 票02 六件一手素材的「组包」面（spec §素材包 摘录纪律）。
//
// 纪律（票面第 2 行 / 故事7）：
//  * 执行 JSONL = **关键事件提取**（error/tool_error/retry/fix-commit 关联行），非全量拷贝；
//    每件带 exec 指针可回源全量（exec id + 日志目录指针）。
//  * **冻结发生在归档当下**——执行日志在 workspace/worktree 路径（票02 勘探 §11：worktree
//    会被删），摘录此刻进包，不留指针到将删目录之外的活引用。
//  * PR diff = `--stat` 级 + 关键 hunk（top 变更文件），全量指回 git（区间锚原样列出）。
//  * matt 产物 = 仓库内路径**指针**（已随 phase PR 持久），不拷正文。
//  * best-effort 逐件独立：单件源缺失/读失败 ⇒ 该件以「诚实缺席说明」落 payload，
//    **永不抛穿** ingestTask 的失败语义（任何失败不阻塞 done）。
//
// git diff 面复用 gitOps（与 round-evidence 实物区间同口径：executions 行的
// start_commit_id/end_commit_id JSON map {projectsDirName: sha}，任务级取累计区间）。

import fs from "fs"
import path from "path"
import type Database from "better-sqlite3"
import { AcceptanceDAO } from "../../db/dao"
import type { gitOps } from "../git-ops"
import type { TaskHomeService } from "./task-home-service"
import type { MaterialItemKind } from "../knowledge/material-pack"

type GitLike = Pick<typeof gitOps, "diffStat" | "diffPatchFor" | "countCommits">

export interface ExtractedMaterial {
  fileName: string
  kind: MaterialItemKind
  name: string
  origin: string
  title: string
  payload: string
}

export interface ArchiveMaterialDeps {
  db: Database.Database
  taskHomeService: TaskHomeService
  now?: () => Date
  /** git 面注入（缺省 = 真 gitOps；测试可用假实现避开 git 依赖） */
  git?: GitLike
}

/** 摘录上限（素材包不失控膨胀——spec Out of Scope「全量永远回源取」）。 */
const JSONL_KEY_EVENT_CAP = 200
const JSONL_EVENT_LINE_CAP = 400
const DIFF_FILE_ROWS_CAP = 40
const DIFF_HUNK_FILES = 3
const DIFF_HUNK_LINE_CAP = 60

// ── 件规格（编号序 = 包内文件序；archive-ingest 与测试按值消费）────────

export const MATERIAL_FILE_NAMES: Record<MaterialItemKind, string> = {
  "acceptance-ledger": "01-acceptance-ledger.md",
  "phase-rejections": "02-phase-rejections.md",
  "exec-jsonl-excerpt": "03-exec-jsonl-excerpt.md",
  "pr-diff": "04-pr-diff.md",
  "matt-artifacts": "05-matt-artifacts.md",
  "adr-context-notes": "06-adr-context-notes.md",
}
export const ARCHIVE_SUMMARY_FILE_NAME = "07-archive-summary.md"

export const MATERIAL_ITEM_NAMES: Record<MaterialItemKind, string> = {
  "acceptance-ledger": "验收台账",
  "phase-rejections": "phase 打回记录",
  "exec-jsonl-excerpt": "执行 JSONL 关键事件摘录",
  "pr-diff": "PR diff（stat + 关键 hunk）",
  "matt-artifacts": "matt 产物指针",
  "adr-context-notes": "ADR · context-notes",
}

// ── 小工具 ────────────────────────────────────────────────────────────

function parseJSONSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

function parseCommitMap(v: string | null | undefined): Record<string, string> {
  const rec = parseJSONSafe<Record<string, unknown>>(v ?? null, {})
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(rec)) if (typeof x === "string" && x) out[k] = x
  return out
}

/** task home docs/adr 草稿件（自 archive-ingest-service 迁入，两读面共用）。 */
export function walkAdrFiles(adrRoot: string): Array<{ file: string; content: string }> {
  const out: Array<{ file: string; content: string }> = []
  if (!fs.existsSync(adrRoot)) return out
  const walk = (dir: string, prefix: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(abs, rel)
      else if (/\.md$/i.test(ent.name) && !/^(index|readme)\.md$/i.test(ent.name)) {
        out.push({ file: rel, content: fs.readFileSync(abs, "utf-8") })
      }
    }
  }
  walk(adrRoot, "")
  return out.slice(0, 20)
}

/** 任务级执行行（与 ExecutionDAO 任务实例谓词同律：根行或带 phase 的行）。 */
function taskExecutions(db: Database.Database, taskId: string): Array<{ id: string; workspace_id: string; phase_index: number | null; round_index: number | null; start_commit_id: string | null; end_commit_id: string | null }> {
  return db.prepare(
    `SELECT id, workspace_id, phase_index, round_index, start_commit_id, end_commit_id FROM executions
     WHERE task_id = ? AND (parent_id = '0' OR phase_index IS NOT NULL)
     ORDER BY created_at ASC`,
  ).all(taskId) as Array<{ id: string; workspace_id: string; phase_index: number | null; round_index: number | null; start_commit_id: string | null; end_commit_id: string | null }>
}

function workspacePath(db: Database.Database, workspaceId: string): string | null {
  const row = db.prepare("SELECT path FROM workspaces WHERE id = ?").get(workspaceId) as { path?: string } | undefined
  return row?.path ?? null
}

// ── JSONL 关键事件提取 ────────────────────────────────────────────────

/** JSONL 关键事件判据（票面逐字：error/tool_error/retry/fix-commit 关联行）。 */
export function isKeyEventLine(line: Record<string, unknown>): boolean {
  const event = String(line.event ?? "")
  if (["error", "failed", "checkpoint_error", "bash_stderr", "python_stderr", "on_node_failure"].includes(event)) return true
  // 工具失败：tool_call（压缩形）带 isError / agent_event 的 tool_result is_error
  if (event === "tool_call" && (line.isError === true || line.is_error === true)) return true
  if (event === "agent_event") {
    const data = line.event_data as Record<string, unknown> | undefined
    if (data?.subtype === "tool_result" && (data.is_error === true || data.isError === true)) return true
  }
  // 重试：引擎重试记账行
  if (event === "retry" || Number(line.retryCount ?? 0) > 0) return true
  // fix-commit 关联：bash_log 里 git commit 且带修复语义
  if (event === "bash_log") {
    const text = `${line.output ?? line.content ?? line.stdout ?? ""}`
    if (/git\s+commit/i.test(text) && /fix|修复|quick-edit/i.test(text)) return true
  }
  return false
}

function renderKeyEvent(line: Record<string, unknown>): string {
  const ts = String(line.timestamp ?? "")
  const node = String(line.nodeId ?? line.node_id ?? "?")
  const event = String(line.event ?? "?")
  const rest = { ...line }
  delete rest.timestamp; delete rest.nodeId; delete rest.node_id; delete rest.event
  let detail = ""
  try { detail = JSON.stringify(rest) } catch { detail = "{…}" }
  if (detail.length > JSONL_EVENT_LINE_CAP) detail = `${detail.slice(0, JSONL_EVENT_LINE_CAP)}…（截断）`
  return `- [${ts}] ${node} · ${event} :: ${detail}`
}

/** 多轮 start 的同节点 = 重试痕迹（JSONL 里重试无独立事件，勘探 §11 实相）。 */
function retryNodes(lines: Record<string, unknown>[]): Set<string> {
  const starts = new Map<string, number>()
  for (const l of lines) {
    if (String(l.event) === "start") {
      const n = String(l.nodeId ?? l.node_id ?? "?")
      starts.set(n, (starts.get(n) ?? 0) + 1)
    }
  }
  return new Set([...starts].filter(([, c]) => c > 1).map(([n]) => n))
}

function extractJsonlExcerpt(deps: ArchiveMaterialDeps, taskId: string): string {
  const lines: string[] = []
  lines.push("# 执行 JSONL 关键事件摘录")
  lines.push("")
  lines.push("（提取纪律：error/tool_error/retry/fix-commit 关联行，**非全量拷贝**；全量按 exec 指针回源。）")
  lines.push("")
  const execs = taskExecutions(deps.db, taskId)
  if (execs.length === 0) {
    lines.push("## 执行记录")
    lines.push("")
    lines.push("- （本任务无执行记录行——task_id 下 executions 为空）")
    return lines.join("\n")
  }
  let totalKept = 0
  for (const exec of execs) {
    const wsPath = workspacePath(deps.db, exec.workspace_id)
    const logDir = wsPath ? path.join(wsPath, "logs", exec.id) : null
    lines.push(`## exec ${exec.id}（phase ${exec.phase_index ?? "?"} · round ${exec.round_index ?? "?"}）`)
    lines.push("")
    lines.push(`- 全量回源指针：${logDir ?? `（workspace ${exec.workspace_id} 不在册）`}/ · executions.id=${exec.id}`)
    if (!logDir || !fs.existsSync(logDir)) {
      lines.push("- 摘录：（日志目录缺席——归档时已不可读，exec 指针保留可追溯）")
      lines.push("")
      continue
    }
    let kept: string[] = []
    const allLines: Record<string, unknown>[] = []
    for (const name of fs.readdirSync(logDir).filter(n => n.endsWith(".jsonl")).sort()) {
      try {
        const text = fs.readFileSync(path.join(logDir, name), "utf-8")
        for (const raw of text.split("\n")) {
          if (!raw.trim()) continue
          let line: Record<string, unknown>
          try { line = JSON.parse(raw) as Record<string, unknown> } catch { continue }
          allLines.push(line)
        }
      } catch { /* 单文件读失败 = 该文件缺席，诚实继续 */ }
    }
    const retried = retryNodes(allLines)
    if (retried.size > 0) lines.push(`- 重试痕迹节点：${[...retried].join(", ")}`)
    for (const line of allLines) {
      if (totalKept >= JSONL_KEY_EVENT_CAP) break
      const isRetryNode = retried.has(String(line.nodeId ?? line.node_id ?? "?")) && ["start", "end", "error"].includes(String(line.event))
      if (!isKeyEventLine(line) && !isRetryNode) continue
      kept.push(renderKeyEvent(line))
      totalKept++
    }
    if (kept.length === 0) {
      lines.push("- 摘录：（本次执行无关键事件——干净跑完）")
    } else {
      lines.push(...kept)
    }
    lines.push("")
    if (totalKept >= JSONL_KEY_EVENT_CAP) {
      lines.push(`（摘录触上限 ${JSONL_KEY_EVENT_CAP} 行，后续 exec 以指针为准）`)
      break
    }
    kept = []
  }
  return lines.join("\n")
}

// ── PR diff（stat + 关键 hunk，全量指回 git）─────────────────────────

async function extractPrDiff(deps: ArchiveMaterialDeps, taskId: string, branch: string | null): Promise<string> {
  const git = deps.git ?? (await import("../git-ops")).gitOps
  const lines: string[] = []
  lines.push("# PR diff（stat 级 + 关键 hunk）")
  lines.push("")
  lines.push(`- 执行分支：${branch ?? "（未显式设定）"}`)
  lines.push("- 全量指回 git：区间锚逐仓列于下文，`git diff start..end` 可复现（素材包不存全量——Out of Scope 逐字）。")
  lines.push("")
  const execs = taskExecutions(deps.db, taskId)
  if (execs.length === 0) {
    lines.push("## 执行区间")
    lines.push("")
    lines.push("- （本任务无执行记录，无实物区间）")
    return lines.join("\n")
  }
  // 任务级累计区间：首行 start 锚 → 末行 end 锚（与 round-evidence cumulative 口径同律）
  const starts = parseCommitMap(execs[0]!.start_commit_id)
  const ends = parseCommitMap(execs[execs.length - 1]!.end_commit_id)
  const names = [...new Set([...Object.keys(starts), ...Object.keys(ends)])]
  if (names.length === 0) {
    lines.push("## 执行区间")
    lines.push("")
    lines.push("- （executions 未携带 commit 锚——无 git 级实物变更可摘）")
    return lines.join("\n")
  }
  const wsPath = workspacePath(deps.db, execs[execs.length - 1]!.workspace_id)
  let any = false
  for (const name of names) {
    const start = starts[name]
    const end = ends[name]
    if (!start || !end) { lines.push(`- ${name}：锚不齐（start=${start ?? "—"} end=${end ?? "—"}），跳过`); continue }
    const dir = wsPath ? path.join(wsPath, "projects", name) : null
    if (!dir || !fs.existsSync(path.join(dir, ".git"))) {
      lines.push(`- ${name}：worktree 不在盘${dir ? `（${dir}）` : ""}，区间锚=${start.slice(0, 7)}..${end.slice(0, 7)}（全量回源 git）`)
      continue
    }
    any = true
    lines.push("")
    lines.push(`## 仓 ${name}（${start}..${end}）`)
    lines.push("")
    try {
      const commits = await git.countCommits(dir, start, end)
      const stat = await git.diffStat(dir, start, end)
      let adds = 0
      let dels = 0
      for (const f of stat.files) { adds += f.adds; dels += f.dels }
      lines.push(`- commits=${commits} files=${stat.files.length}${stat.truncated ? "（截断）" : ""} +${adds}/-${dels}`)
      for (const f of stat.files.slice(0, DIFF_FILE_ROWS_CAP)) {
        lines.push(`  - ${f.status} ${f.path} +${f.adds}/-${f.dels}`)
      }
      if (stat.files.length > DIFF_FILE_ROWS_CAP) lines.push(`  - …（其余 ${stat.files.length - DIFF_FILE_ROWS_CAP} 文件看 stat 汇总）`)
      // 关键 hunk：变更量 top 文件的 patch 头部
      const top = stat.files.filter(f => !f.binary).sort((a, b) => (b.adds + b.dels) - (a.adds + a.dels)).slice(0, DIFF_HUNK_FILES)
      for (const f of top) {
        try {
          const { patch } = await git.diffPatchFor(dir, start, end, f.path)
          const head = patch.split("\n").slice(0, DIFF_HUNK_LINE_CAP).join("\n")
          lines.push("")
          lines.push(`### hunk: ${f.path}`)
          lines.push("```diff")
          lines.push(head)
          lines.push("```")
        } catch { /* 单文件 patch 失败不影响 stat 面 */ }
      }
    } catch (err) {
      lines.push(`- git 读失败（best-effort 缺席）：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (!any && names.length > 0 && !lines.some(l => l.startsWith("## 仓"))) {
    lines.push("")
    lines.push("（本次归档未能读到 git 实物区间——锚/仓缺席面上已逐仓显形。）")
  }
  return lines.join("\n")
}

// ── matt 产物指针 / 台账 / 打回 / ADR 三件（纯 fs/db 读）───────────────

function extractMattArtifacts(home: string): string {
  const lines: string[] = []
  lines.push("# matt 产物指针（仓库内路径；已随 phase PR 持久，此处不拷正文）")
  lines.push("")
  const scratch = path.join(home, ".scratch")
  let count = 0
  if (fs.existsSync(scratch)) {
    const walk = (dir: string, prefix: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name
        const abs = path.join(dir, ent.name)
        if (ent.isDirectory()) { walk(abs, rel); continue }
        if (!/\.(md|json|html)$/i.test(ent.name)) continue
        if (count >= 200) return
        const bytes = fs.statSync(abs).size
        lines.push(`- ${rel}（${bytes} B）`)
        count++
      }
    }
    walk(scratch, ".scratch")
  }
  if (count === 0) lines.push("- （task home .scratch 无产物——无批目录）")
  lines.push("")
  lines.push(`- task home：${home}`)
  return lines.join("\n")
}

// ── 组包入口 ──────────────────────────────────────────────────────────

export interface ArchiveSpecLite {
  branch?: string
  goal?: string
  phases?: Array<{ index: number; name?: string; slug?: string }>
}

/** 六件素材组包（async：git 面；逐件 best-effort，永不抛穿的缺席见 extract*）。 */
export async function buildArchiveMaterials(
  deps: ArchiveMaterialDeps,
  row: { id: string; name: string; task_spec: string | null },
  spec: ArchiveSpecLite,
): Promise<ExtractedMaterial[]> {
  const now = deps.now ?? (() => new Date())
  const home = deps.taskHomeService.homePath(row.id)
  const taskId = row.id

  const ledger = new AcceptanceDAO(deps.db).listByTask(taskId)
  const ledgerLines: string[] = []
  ledgerLines.push(`# 验收台账（task ${taskId} · ${row.name}）`)
  ledgerLines.push("")
  ledgerLines.push(`- 归档组包时刻：${now().toISOString()}`)
  ledgerLines.push("")
  if (ledger.length === 0) {
    ledgerLines.push("（账本为空）")
  } else {
    for (const r of ledger) {
      ledgerLines.push(`- phase ${r.phase_index} round ${r.round_index}: ${r.decision}${r.feedback ? ` — 反馈「${r.feedback}」` : ""} (${r.decided_at})`)
    }
  }

  const rejected = ledger.filter(r => r.decision === "rejected")
  const rejLines: string[] = []
  rejLines.push(`# phase 打回记录（task ${taskId}）`)
  rejLines.push("")
  if (rejected.length === 0) {
    rejLines.push("（无打回轮次——账本里 decision=rejected 为空）")
  } else {
    for (const r of rejected) {
      rejLines.push(`## phase ${r.phase_index} round ${r.round_index} 打回（${r.decided_at}）`)
      rejLines.push("")
      rejLines.push(`- owner 反馈：${r.feedback ?? "（无反馈文本）"}`)
      rejLines.push("")
    }
  }

  const adrs = walkAdrFiles(path.join(home, "docs", "adr"))
  const notesAbs = path.join(home, "context-notes.md")
  const adrLines: string[] = []
  adrLines.push(`# ADR · context-notes（task home 一手件 · task ${taskId}）`)
  adrLines.push("")
  if (adrs.length === 0) adrLines.push("（docs/adr 无草稿件）")
  for (const a of adrs) {
    adrLines.push(`## ADR: ${a.file}`)
    adrLines.push("")
    adrLines.push(a.content)
    adrLines.push("")
  }
  adrLines.push("## context-notes")
  adrLines.push("")
  if (fs.existsSync(notesAbs)) adrLines.push(fs.readFileSync(notesAbs, "utf-8"))
  else adrLines.push("（无 context-notes.md）")

  const jsonl = extractJsonlExcerpt(deps, taskId)
  const diff = await extractPrDiff(deps, taskId, spec.branch ?? null)
  const matt = extractMattArtifacts(home)

  return [
    { fileName: MATERIAL_FILE_NAMES["acceptance-ledger"], kind: "acceptance-ledger", name: MATERIAL_ITEM_NAMES["acceptance-ledger"], origin: `db:task_phase_acceptances:${taskId}`, title: `验收台账 task-${taskId}`, payload: ledgerLines.join("\n") },
    { fileName: MATERIAL_FILE_NAMES["phase-rejections"], kind: "phase-rejections", name: MATERIAL_ITEM_NAMES["phase-rejections"], origin: `db:task_phase_acceptances:${taskId}#rejected`, title: `phase 打回记录 task-${taskId}`, payload: rejLines.join("\n") },
    { fileName: MATERIAL_FILE_NAMES["exec-jsonl-excerpt"], kind: "exec-jsonl-excerpt", name: MATERIAL_ITEM_NAMES["exec-jsonl-excerpt"], origin: `exec:${taskId}`, title: `执行 JSONL 关键事件摘录 task-${taskId}`, payload: jsonl },
    { fileName: MATERIAL_FILE_NAMES["pr-diff"], kind: "pr-diff", name: MATERIAL_ITEM_NAMES["pr-diff"], origin: `git:${taskId}`, title: `PR diff task-${taskId}`, payload: diff },
    { fileName: MATERIAL_FILE_NAMES["matt-artifacts"], kind: "matt-artifacts", name: MATERIAL_ITEM_NAMES["matt-artifacts"], origin: `task-home:${taskId}`, title: `matt 产物指针 task-${taskId}`, payload: matt },
    { fileName: MATERIAL_FILE_NAMES["adr-context-notes"], kind: "adr-context-notes", name: MATERIAL_ITEM_NAMES["adr-context-notes"], origin: `task-home:${taskId}/docs/adr`, title: `ADR·context-notes task-${taskId}`, payload: adrLines.join("\n") },
  ]
}
