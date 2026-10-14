// packages/server/src/services/tasks/archive-ingest-service.ts
//
// 归档自动投喂 — 知识中心票10 建链，P3 票02 升级为**素材包链**。
//
// 语义（spec §Implementation Decisions「素材包」链序逐字）：task 进入 archiving 态 ⇒
//   ① 素材包落盘（先）：六类一手素材（验收台账/phase 打回/执行 JSONL 关键事件摘录/
//      PR diff/matt 产物指针/ADR·context-notes）逐件冻结进 `raw/archives/task-{id}/` +
//      manifest（每件 kind/origin/path/bytes/sha256——件级 hash 冻结契约与单文件 raw 一致）；
//   ② 总结生成（读包）：一次 LLM 调用，素材取自刚落盘的包（manifest 清单进 prompt）；
//   ③ 总结降级为包内第七件（archive-summary），manifest 追加；
//   ④ 入队编译（读包）：`enqueue("archive-compile")` 整包 compilePack——编译侧
//      manifest 先行、按需下钻单件（token 预算纪律）。
//   历史兼容：旧单文件 `task-{id}-summary.md` 归档兼容读，不迁移不报错；compileRaw
//   单文件通道保留（投喂路由/旧任务重试照走）。
//
// 失败语义（AC2/K11 零触碰的结构性保证，不变）：
//  * 本服务**永不向调用方抛错**——组包/落盘/总结任一失败 = 跳过（已冻结件保留，
//    不产半成品总结），归档照常；编译在队列内失败 = 队列记 failed，不阻塞 done。
//  * done 的唯一写者仍是 tasks-service.endArchiving，本模块与 archiving 编排解耦。
//
// 幂等：同任务重归档 = 先看包 manifest 位（再兜旧单文件位）——已冻结即回指针、
// 不调 LLM、不再入队（队列 id `arc-{taskId}` 确定性，双入队必撞 id）。

import fs from "fs"
import path from "path"
import type Database from "better-sqlite3"
import { AcceptanceDAO, TaskDAO } from "../../db/dao"
import type { TaskHomeService } from "./task-home-service"
import type { RawIngestService } from "../knowledge/raw"
import { stripRawFrontMatter } from "../knowledge/raw"
import type { WriteQueue } from "../knowledge/wiki/compile-queue"
import { getRawDir } from "../knowledge/global-paths"
import type { LLMCall } from "../knowledge/llm"
import {
  ARCHIVE_SUMMARY_KIND,
  freezePackItem,
  packDirRel,
  packItemsForCard,
  packManifestRel,
  readPackManifest,
  writePackManifest,
  type MaterialPackManifest,
} from "../knowledge/material-pack"
import type { KcCardEvent } from "@octopus/shared"
import {
  ARCHIVE_SUMMARY_FILE_NAME,
  buildArchiveMaterials,
  walkAdrFiles,
  type ArchiveSpecLite,
} from "./archive-materials"

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

export interface PackCompileOpts {
  /** 对话重编译焦点指令（票02 故事4：「重点看 phase-2 打回那段」原样进编译 prompt） */
  focus?: string
}

export interface ArchiveIngestDeps {
  db: Database.Database
  taskHomeService: TaskHomeService
  /** 票02 raw 冻结服务（同 root 装配；素材件复用其 root 与 front-matter 契约） */
  rawIngest: RawIngestService
  /** 票06 全局写串行队列（生产 = wikiWriteQueue 单例；kind 单源 archive-compile） */
  queue: WriteQueue
  /** P3 票02：编译读包入口（票05 CuratorCompileService.compilePack 整包——manifest 先行按需下钻） */
  compilePack: (taskId: string, opts?: PackCompileOpts) => Promise<unknown>
  /** 一次 LLM 总结 seam */
  summarize: ArchiveSummarizer
  /**
   * P3 票02 素材包卡 Lane A 生产者（index.ts 接 appendKnowledgeSessionCards——
   * patrol-job 先例同律：无知识中心会话诚实降级）。缺省不产卡；抛错吞进 stderr，
   * 永不毁投喂回执（失败语义不破）。
   */
  announcePack?: (event: KcCardEvent) => void
  /**
   * P3 票03 判例提取接位（同 hook 链第⑤步，入队编译之后）：index.ts 接
   * CaseExtractService.extractAndEnqueue——读刚落盘的素材包（exec-jsonl-excerpt +
   * phase-rejections）产五段草案，经 case-archive 队列 opKind 入档。
   * 缺省不提取；抛错/失败一律吞进 stderr——提取失败不产假判例、零落盘零入队由
   * CaseExtractService 自守，本钩子层再保「不阻塞投喂回执/done」。
   */
  extractCases?: (taskId: string) => Promise<unknown>
  now?: () => Date
}

export type ArchiveIngestStatus = "ingested" | "deduped" | "skipped"

export interface ArchiveIngestOutcome {
  status: ArchiveIngestStatus
  /** skipped 的原因码（稳定词，进 stderr/测试断言；成功路径缺省） */
  reason?: string
  /** 总结件的知识根相对路径（包内第七件；deduped 命中旧单文件时为旧路径） */
  rawPath?: string
  rawHash?: string
  /** 素材包目录（raw/archives/task-{id}） */
  packPath?: string
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

/** 读包素材（票02「总结生成改读包」）：manifest 清单 + 落盘件正文回读（预算截断）。 */
export interface PackSummaryMaterial {
  manifestRel: string
  items: Array<{ kind: string; name: string; path: string; bytes: number; content: string }>
}

export function buildArchiveSummaryPrompt(f: ArchiveSummaryFacts, pack?: PackSummaryMaterial): string {
  const ledgerLines = f.ledger.length > 0
    ? f.ledger.map((r) => `- phase ${r.phase_index} round ${r.round_index}: ${r.decision}${r.feedback ? ` — 反馈「${r.feedback}」` : ""} (${r.decided_at})`).join("\n")
    : "- （账本为空）"
  const adrBlock = f.adrs.length > 0
    ? f.adrs.map((a) => `### ${a.file}\n\n${a.content}`).join("\n---\n\n")
    : "（本任务无 ADR 草稿件）"
  const packBlock = pack
    ? [
        "## 素材包（一手素材已冻结于此，读包提炼；每件带 hash 可对质）",
        "",
        `- manifest: ${pack.manifestRel}`,
        ...pack.items.map((i) => `  - ${i.name}（${i.kind}）· ${i.path} · ${i.bytes} B`),
        "",
        ...pack.items.map((i) => `### 包件正文 · ${i.name}（${i.kind}）\n\n${truncatePayload(i.content)}`),
      ].join("\n")
    : ""
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
${pack ? `\n${packBlock}\n` : ""}`
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

/** 总结 prompt 的单件正文预算（摘录纪律已把件本身压小，此处是 prompt 面的二次护栏）。 */
const SUMMARY_ITEM_CAP = 8_000
function truncatePayload(text: string): string {
  return Buffer.byteLength(text, "utf-8") <= SUMMARY_ITEM_CAP ? text : `${text.slice(0, SUMMARY_ITEM_CAP)}\n…（截断，全文见包内件）`
}

/** 包件正文回读（读盘 = 真·读包；front-matter 剥除后正文与冻结时逐字一致）。 */
function readPackItemContent(root: string, itemPath: string): string {
  const abs = path.join(root, ...itemPath.split("/"))
  return stripRawFrontMatter(fs.readFileSync(abs, "utf-8"))
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
   * 链序（票02）：素材包落盘（先）→ 总结读包生成 → 总结入包 → 入队编译读包。
   */
  async ingestTask(taskId: string): Promise<ArchiveIngestOutcome> {
    if (!TASK_ID_RE.test(taskId)) return this.skip("INVALID_TASK_ID", `taskId 含钉名非法字符: ${taskId}`)

    const row = this.taskDAO.getById(taskId)
    if (!row) return this.skip("TASK_NOT_FOUND", `任务不存在: ${taskId}`)
    const spec = parseJSONSafe<{ format?: string; goal?: string; ac?: string[]; phases?: Array<{ index: number; name?: string }>; decisions?: string[]; branch?: string; slug?: string }>(row.task_spec, {})
    if (spec.format !== "v4") return this.skip("NOT_V4", `任务非 v4 (format='${spec.format ?? ""}')`)

    const root = this.deps.rawIngest.root

    // 幂等闸①：包 manifest 已冻结 ⇒ 回指针即止（不调 LLM、不入队）。
    const existing = readPackManifest(root, taskId)
    if (existing) {
      const summary = existing.items.find(i => i.kind === ARCHIVE_SUMMARY_KIND && !i.excluded)
      return {
        status: "deduped",
        rawPath: summary?.path ?? packManifestRel(taskId),
        ...(summary ? { rawHash: summary.sha256 } : {}),
        packPath: packDirRel(taskId),
      }
    }
    // 幂等闸②（历史兼容）：旧单文件总结位已存在 ⇒ deduped 回旧路径（不迁移不报错）。
    const legacyFileName = archiveSummaryFileName(taskId)
    const legacyAbs = path.join(getRawDir(root, "archives"), legacyFileName)
    if (fs.existsSync(legacyAbs)) {
      return { status: "deduped", rawPath: `raw/archives/${legacyFileName}` }
    }

    // ── ① 素材包落盘（先）：六件逐件冻结 + manifest ──────────────────
    let materials: Awaited<ReturnType<typeof buildArchiveMaterials>>
    try {
      materials = await buildArchiveMaterials(
        { db: this.deps.db, taskHomeService: this.deps.taskHomeService, now: this.now },
        row,
        spec as ArchiveSpecLite,
      )
    } catch (err) {
      return this.skip("MATERIAL_EXTRACT_FAILED", err instanceof Error ? err.message : String(err))
    }
    const ingestedAt = this.now().toISOString()
    const manifest: MaterialPackManifest = {
      v: 1,
      taskId,
      createdAt: ingestedAt,
      items: [],
      recompiles: [],
    }
    try {
      for (const m of materials) {
        manifest.items.push(freezePackItem(root, taskId, {
          fileName: m.fileName,
          kind: m.kind,
          name: m.name,
          origin: m.origin,
          title: m.title,
          payload: m.payload,
          ingestedAt,
        }))
      }
      writePackManifest(root, taskId, manifest)
    } catch (err) {
      return this.skip("PACK_FREEZE_FAILED", err instanceof Error ? err.message : String(err))
    }

    // ── ② 总结生成（读包）：manifest 清单 + 件正文回读进 prompt ──────
    const facts = this.buildFacts(row, spec)
    const packMaterial: PackSummaryMaterial = {
      manifestRel: packManifestRel(taskId),
      items: manifest.items.map((item) => ({
        kind: item.kind,
        name: item.name,
        path: item.path,
        bytes: item.bytes,
        content: readPackItemContent(root, item.path),
      })),
    }
    const prompt = buildArchiveSummaryPrompt(facts, packMaterial)

    let text = ""
    try {
      text = await this.deps.summarize(prompt)
    } catch (err) {
      return this.skip("SUMMARIZE_FAILED", err instanceof Error ? err.message : String(err))
    }
    if (!text || text.trim() === "") return this.skip("SUMMARIZE_EMPTY", "总结 LLM 无响应（缺席或被禁用）")

    // ── ③ 总结降级为包内一件（冻结 + manifest 追加）──────────────────
    let summaryItem
    try {
      summaryItem = freezePackItem(root, taskId, {
        fileName: ARCHIVE_SUMMARY_FILE_NAME,
        kind: ARCHIVE_SUMMARY_KIND,
        name: "归档总结",
        origin: `task-archive:${taskId}`,
        title: `${row.name} — 归档总结`,
        payload: text,
        ingestedAt: this.now().toISOString(),
      })
      const current = readPackManifest(root, taskId) ?? manifest
      current.items = [...current.items.filter(i => i.kind !== ARCHIVE_SUMMARY_KIND), summaryItem]
      current.updatedAt = this.now().toISOString()
      writePackManifest(root, taskId, current)
    } catch (err) {
      return this.skip("SUMMARY_FREEZE_FAILED", err instanceof Error ? err.message : String(err))
    }

    // 票06 (语义摘要进任务板): 归档总结的独立字段（多面摘要：干了什么/关键决策/踩坑/
    // 产出指针——即整份 text，非首段截断）写入 tasks.semantic_summary，供任务板搜索 LIKE
    // 命中（故事 25-26）。这是本票在该文件里唯一的一小段接线（素材包改造属票02）。
    // 纪律：fire-and-forget 尽力而为——写失败只 stderr，绝不抛（永不参与 done 判定、
    // K11 零触碰、done 唯一写者不变；setSemanticSummary 定向 UPDATE 不碰 status/version）。
    try {
      this.taskDAO.setSemanticSummary(taskId, text.trim())
    } catch (err) {
      process.stderr.write(`[archive-ingest] semantic_summary write failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}\n`)
    }

    // ── ④ 异步编译入队（读包）：全局串行；执行在队列内，失败只记 failed 态 ──
    const queueTaskId = archiveCompileTaskId(taskId)
    try {
      this.deps.queue.enqueue("archive-compile", () => this.deps.compilePack(taskId), {
        taskId: queueTaskId,
        label: packManifestRel(taskId),
      })
    } catch (err) {
      // 同 id 在队（进程内重触发竞态）——投喂本身已成功，编译以既有任务为准。
      process.stderr.write(`[archive-ingest] enqueue failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}\n`)
    }

    // ── ⑤ 判例提取（P3 票03 同 hook 链：入队编译之后）：读刚落盘的素材包产五段草案，
    // 经 case-archive 队列 opKind 入档（唯一写通道，红线2）+ 判例卡 Lane A 先存后知。
    // 失败全吞进 stderr——不产假判例、不阻塞投喂回执、不参与 done 判定（票面第 6 行）。
    if (this.deps.extractCases) {
      try {
        await this.deps.extractCases(taskId)
      } catch (err) {
        process.stderr.write(`[archive-ingest] case extraction failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }

    // ── 素材包卡（票面第 4 行：件清单入对话流；Lane A 生产者接位，失败语义不破）──
    if (this.deps.announcePack) {
      try {
        const fresh = readPackManifest(root, taskId) ?? manifest
        const event: KcCardEvent = {
          id: `mdp-${taskId}`,
          kind: "material-pack",
          ts: this.now().toISOString(),
          data: {
            taskId,
            packPath: packDirRel(taskId),
            items: packItemsForCard(fresh),
            summaryIncluded: true,
            queueTaskId,
          },
        }
        this.deps.announcePack(event)
      } catch (err) {
        process.stderr.write(`[archive-ingest] announce failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }

    return { status: "ingested", rawPath: summaryItem.path, rawHash: summaryItem.sha256, packPath: packDirRel(taskId), queueTaskId }
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
