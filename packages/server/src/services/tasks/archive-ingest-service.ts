// packages/server/src/services/tasks/archive-ingest-service.ts
//
// 归档自动投喂 — 知识中心票10（spec §「注入链与旧库硬废」轻量版段，替代旧三级提炼）。
//
// 语义：task 进入 archiving 态时一次 LLM 调用产出完整总结（验收台账/关键决策/
// 踩坑/产出指针四段）→ `raw/archives/task-{id}-summary.md`（票02 同契约冻结 + hash，
// 钉名幂等）→ 异步入全局串行队列编译（`enqueue("archive-compile")` 包 curator
// compileRaw，票06 唯一写闸通道）。
//
// 失败语义（AC2/K11 零触碰的结构性保证）：
//  * 本服务**永不向调用方抛错**——summarize 抛错/空响应（离线闸）= 跳过投喂，
//    归档照常；编译在队列内失败 = 队列记 failed，不回滚 K11、不触碰 done。
//  * done 的唯一写者仍是 tasks-service.endArchiving（archiving-service onComplete），
//    本模块与 archiving 编排完全解耦（beginArchiving 侧 fire-and-forget 钩子挂载）。
//
// 幂等（AC1 尾注）：同任务重归档 = 先看钉名位是否已冻结——已存在即回指针、
// 不再调 LLM、不再入队（队列 id `arc-{taskId}` 确定性，双入队必撞 id，先查跳过）。

import fs from "fs"
import path from "path"
import type Database from "better-sqlite3"
import { AcceptanceDAO, TaskDAO } from "../../db/dao"
import type { TaskHomeService } from "./task-home-service"
import type { RawIngestService, RawPointer } from "../knowledge/raw"
import type { WriteQueue } from "../knowledge/wiki/compile-queue"
import { getRawDir } from "../knowledge/global-paths"
import type { LLMCall } from "../knowledge/llm"

/**
 * ArchiveSummarizer — 归档总结 LLM seam（生产适配器 createProductionArchiveSummarizer；
 * 测试一律 fixture mock 捕获 prompt，spec Testing Decisions「provider 请求捕获」）。
 * 入参是完整总结提示词，返回 markdown 文本；空串 = 无响应（离线/禁用/失败）。
 */
export type ArchiveSummarizer = LLMCall

// ── 命名契约（单源，测试/路由/票12 UI 按值消费）─────────────────────

/** 归档编译队列任务 id 前缀 — GET /api/knowledge/wiki/queue/task/arc-{taskId} 可查面。 */
export const ARCHIVE_QUEUE_TASK_ID_PREFIX = "arc-"

/** 编译任务状态可查的最小面（AC2）：octopus taskId → 队列任务 id 的确定性映射。 */
export function archiveCompileTaskId(taskId: string): string {
  return `${ARCHIVE_QUEUE_TASK_ID_PREFIX}${taskId}`
}

/** 归档总结钉名（spec 契约名 `task-{id}-summary.md`，无日期前缀 = 重归档幂等）。 */
export function archiveSummaryFileName(taskId: string): string {
  return `task-${taskId}-summary.md`
}

/** 钉名合法任务 id 字符面（UUID/kebab 均可）；不匹配 = 跳过投喂（文件名注入零容忍）。 */
const TASK_ID_RE = /^[A-Za-z0-9._-]+$/

// ── Deps & outcome ───────────────────────────────────────────────────

export interface ArchiveIngestDeps {
  db: Database.Database
  taskHomeService: TaskHomeService
  /** 票02 raw 冻结服务（同 root 装配） */
  rawIngest: RawIngestService
  /** 票06 全局写串行队列（生产 = wikiWriteQueue 单例；kind 单源 archive-compile） */
  queue: WriteQueue
  /** 单次编译原子入口（票05 CuratorCompileService.compileRaw 整包） */
  compile: (raw: RawPointer) => Promise<unknown>
  /** 一次 LLM 总结 seam */
  summarize: ArchiveSummarizer
  now?: () => Date
}

export type ArchiveIngestStatus = "ingested" | "deduped" | "skipped"

export interface ArchiveIngestOutcome {
  status: ArchiveIngestStatus
  /** skipped 的原因码（稳定词，进 stderr/测试断言；成功路径缺省） */
  reason?: string
  /** 知识根相对 raw 指针路径（raw/archives/task-…-summary.md） */
  rawPath?: string
  rawHash?: string
  /** 编译队列任务 id（arc-{taskId}）——状态经 GET /queue/task/:id 可查 */
  queueTaskId?: string
}

// ── Facts + prompt（纯函数，可独立断言）──────────────────────────────

export interface ArchiveSummaryFacts {
  taskId: string
  taskName: string
  org: string
  date: string
  goal: string
  ac: string[]
  phases: Array<{ index: number; name: string }>
  ledger: Array<{ phase_index: number; round_index: number; decision: string; feedback: string | null; decided_at: string }>
  decisions: string[]
  /** home docs/adr 草稿件（关键决策一手材料） */
  adrs: Array<{ file: string; content: string }>
  contextNotes: string | null
  /** 产出指针素材 */
  projects: string[]
  branch: string | null
  workspaceId: string | null
  homePath: string
}

export function buildArchiveSummaryPrompt(f: ArchiveSummaryFacts): string {
  const ledgerLines = f.ledger.length > 0
    ? f.ledger.map((r) => `- phase ${r.phase_index} round ${r.round_index}: ${r.decision}${r.feedback ? ` — 反馈「${r.feedback}」` : ""} (${r.decided_at})`).join("\n")
    : "- （账本为空）"
  const adrBlock = f.adrs.length > 0
    ? f.adrs.map((a) => `### ${a.file}\n\n${a.content}`).join("\n---\n\n")
    : "（本任务无 ADR 草稿件）"
  return `# 任务归档总结（Archive Summary）

你是任务归档策展助手。为下面这个已进入归档（archiving）态的任务产出**一份完整总结**，
它将作为不可变 raw 源投喂进知识库（raw/archives/）。只输出 markdown 正文，
不要任何代码围栏之外的解释。必须包含且仅包含以下四个二级小节：

## 验收台账
（逐 phase 逐轮：通过/打回与轮次结果，依据下方账本实录归纳，不得虚构）

## 关键决策
（ADR 草稿与 spec.decisions 的实质决定点）

## 踩坑
（打回反馈、返工原因、故障教训——账本与 notes 里真实发生过的事）

## 产出指针
（分支、涉及项目、task home 路径、ADR/notes 件——指路不贴全文）

# 任务素材（一手数据，如实归纳）

- task id: ${f.taskId}
- 名称: ${f.taskName}
- org: ${f.org}
- 归档日期: ${f.date}
- goal: ${f.goal}
- 验收条件 ac:
${f.ac.map((a) => `  - ${a}`).join("\n") || "  - （无）"}
- phases:
${f.phases.map((p) => `  - phase ${p.index} ${p.name}`).join("\n") || "  - （无）"}

## 验收账本（逐行实录）

${ledgerLines}

## spec.decisions

${f.decisions.map((d) => `- ${d}`).join("\n") || "- （无）"}

## ADR 草稿（task home docs/adr）

${adrBlock}

## context-notes（术语/背景素材）

${f.contextNotes ?? "（无 context-notes.md）"}

## 产出指针素材

- 执行分支: ${f.branch ?? "（未显式设定）"}
- 项目: ${f.projects.join(", ") || "（无）"}
- workspace id: ${f.workspaceId ?? "（无）"}
- task home: ${f.homePath}
`
}

// ── Service ──────────────────────────────────────────────────────────

function parseJSONSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function walkAdrFiles(adrRoot: string): Array<{ file: string; content: string }> {
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

export class ArchiveIngestService {
  private readonly deps: ArchiveIngestDeps
  private readonly taskDAO: TaskDAO
  private readonly acceptanceDAO: AcceptanceDAO
  private readonly now: () => Date

  constructor(deps: ArchiveIngestDeps) {
    this.deps = deps
    this.taskDAO = new TaskDAO(deps.db)
    this.acceptanceDAO = new AcceptanceDAO(deps.db)
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * 归档投喂入口（beginArchiving fire-and-forget 钩子消费）。**永不抛错**——
   * 一切失败收敛为 {status:"skipped", reason}，归档状态机（K11/done 判定）零感知。
   */
  async ingestTask(taskId: string): Promise<ArchiveIngestOutcome> {
    if (!TASK_ID_RE.test(taskId)) return this.skip("INVALID_TASK_ID", `taskId 含钉名非法字符: ${taskId}`)

    const row = this.taskDAO.getById(taskId)
    if (!row) return this.skip("TASK_NOT_FOUND", `任务不存在: ${taskId}`)
    const spec = parseJSONSafe<{ format?: string; goal?: string; ac?: string[]; phases?: Array<{ index: number; name?: string }>; decisions?: string[]; branch?: string; slug?: string }>(row.task_spec, {})
    if (spec.format !== "v4") return this.skip("NOT_V4", `任务非 v4 (format='${spec.format ?? ""}')`)

    // 幂等闸：钉名位已冻结 ⇒ 回指针即止（不调 LLM、不入队）。
    const fileName = archiveSummaryFileName(taskId)
    const pinnedAbs = path.join(getRawDir(this.deps.rawIngest.root, "archives"), fileName)
    if (fs.existsSync(pinnedAbs)) {
      return { status: "deduped", rawPath: `raw/archives/${fileName}` }
    }

    const facts = this.buildFacts(row, spec)
    const prompt = buildArchiveSummaryPrompt(facts)

    // 一次 LLM 调用（离线闸/异常 ⇒ 跳过投喂，归档照常）。
    let text = ""
    try {
      text = await this.deps.summarize(prompt)
    } catch (err) {
      return this.skip("SUMMARIZE_FAILED", err instanceof Error ? err.message : String(err))
    }
    if (!text || text.trim() === "") return this.skip("SUMMARIZE_EMPTY", "总结 LLM 无响应（缺席或被禁用）")

    // raw 冻结（票02 同契约；IngestError ⇒ 跳过，不落半成品）。
    let rawPath = ""
    let rawHash = ""
    let pointer: RawPointer | null = null
    try {
      const result = this.deps.rawIngest.ingestText({
        text,
        title: `${row.name} — 归档总结`,
        dir: "archives",
        fileName,
        origin: `task-archive:${taskId}`,
      })
      pointer = result.raw
      rawPath = result.raw.path
      rawHash = result.raw.hash
    } catch (err) {
      return this.skip("RAW_FREEZE_FAILED", err instanceof Error ? err.message : String(err))
    }

    // 异步编译入队（票06 全局串行；执行在队列内，编译失败只记 failed 态）。
    const queueTaskId = archiveCompileTaskId(taskId)
    let queueEnqueued = false
    if (pointer) {
      try {
        this.deps.queue.enqueue("archive-compile", () => this.deps.compile(pointer as RawPointer), {
          taskId: queueTaskId,
          label: rawPath,
        })
        queueEnqueued = true
      } catch (err) {
        // 同 id 在队（进程内重触发竞态）——投喂本身已成功，编译以既有任务为准。
        process.stderr.write(`[archive-ingest] enqueue failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
    void queueEnqueued

    return { status: "ingested", rawPath, rawHash, queueTaskId }
  }

  private skip(reason: string, detail: string): ArchiveIngestOutcome {
    process.stderr.write(`[archive-ingest] skipped: ${reason} — ${detail}\n`)
    return { status: "skipped", reason }
  }

  private buildFacts(
    row: ReturnType<TaskDAO["getById"]> & object,
    spec: { goal?: string; ac?: string[]; phases?: Array<{ index: number; name?: string }>; decisions?: string[]; branch?: string },
  ): ArchiveSummaryFacts {
    const home = this.deps.taskHomeService.homePath(row.id)
    const notesAbs = path.join(home, "context-notes.md")
    return {
      taskId: row.id,
      taskName: row.name,
      org: row.org,
      date: this.now().toISOString().slice(0, 10),
      goal: spec.goal ?? "",
      ac: spec.ac ?? [],
      phases: (spec.phases ?? []).map((p) => ({ index: p.index, name: p.name ?? "" })),
      ledger: this.acceptanceDAO.listByTask(row.id),
      decisions: spec.decisions ?? [],
      adrs: walkAdrFiles(path.join(home, "docs", "adr")),
      contextNotes: fs.existsSync(notesAbs) ? fs.readFileSync(notesAbs, "utf-8") : null,
      projects: parseJSONSafe<string[]>(row.project_ids, []),
      branch: spec.branch ?? null,
      workspaceId: row.workspace_id ?? null,
      homePath: home,
    }
  }
}
