import type Database from "better-sqlite3"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import type { WikiPageFrontmatter, WikiCaseFrontmatter, KcCardEvent, KcCompileDiffCardData } from "@octopus/shared"
import { applySchema } from "../../db/schema"
import { FindingsDAO, type FindingRow, type FindingStatus } from "../../db/dao/findings-dao"
import { GLOBAL_WIKI_ORG, resolveKnowledgeRoot } from "./global-paths"
import { scanWikiEntries, WikiCompileService, nextRuleAnchor, type BatchPageInput } from "./wiki/compile"
import { parseWikiFile, parseCaseMarkdown, serializeCaseMarkdown, serializePageMarkdown, extractRuleAnchors, pageDirForType } from "./wiki/format"
import { parseCaseSections } from "./case-extract-service"
import { buildProceduralJudgePrompt, parseProceduralJudgment } from "./skill-detect"
import type { GitRunner } from "./wiki/wiki-git"
import { CompileQueue, type WriteQueue } from "./wiki/compile-queue"
import { findingCardData } from "./patrol-job"
import type { LLMCall } from "./llm"

/**
 * FindingOpsService — finding 卡三钮的服务端（知识中心票13 AC2/AC5，spec 质控⑤出口）。
 *
 * 三钮语义：
 * - [采纳修订] `adopt(id)`：服务端生成修订稿（contradiction/stale 走 LLM seam；
 *   missing-xref/orphan/missing-page 走确定性图编辑），**经票06 全局队列
 *   opKind="finding-fix" 入唯一写闸编译**（旁路写 wiki = 违规）；成功 → git commit +
 *   finding → resolved + Lane A 回执（compile-diff 卡跟随）。
 * - [忽略] `ignore(id)`：记录在案（ignored 持久），巡检幂等不再重报（patrol 面）。
 * - [讨论]：零状态变更（纯对话续流），服务端无动作——由 S4 卡面与 AC 钉。
 *
 * 修订稿纪律（与票05 编译闸同族）：LLM 只出正文，front-matter 服务端保形
 * （锚点原样保留 = wiki_refs 不断链的硬约束；丢锚点 ⇒ FINDING_ANCHOR_LOST 任务失败、
 * 库零动、finding 留 open——宁可失败显形，不可静默断链）。
 * registry 形态与 CuratorTaskService/RevertTaskService 同律（进程内、容量逐出、
 * 真相面 = git commit + LOG 行；队列侧 failed 读时对账）。
 */

export class FindingOpsError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(`${code}: ${message}`)
    this.name = "FindingOpsError"
  }
}

export type FixTaskStatus = "queued" | "running" | "committed" | "failed"

export interface FixTaskResult {
  commit: string | null
  changed: boolean
  touched: Array<{ path: string; type: string; created: boolean }>
  warnings: string[]
}

export interface FixTaskRecord {
  id: string
  findingId: string
  kind: string
  status: FixTaskStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  result?: FixTaskResult
  error?: { code: string; message: string }
}

export interface FindingOpsDeps {
  db: Database.Database
  /** 知识根（测试注入 tmpdir；缺省 resolveKnowledgeRoot()） */
  root?: string
  /** 全局写串行队列（票06）。缺省=私有 FIFO；生产注入全局单例（带 wiki 根锁） */
  queue?: WriteQueue
  /** 修订稿 LLM seam（curator 同款注入纪律；缺省无 = 语义面 LLM_UNAVAILABLE） */
  llm?: LLMCall
  git?: GitRunner
  now?: () => Date
  capacity?: number
  /** Lane A 回执投递（生产=知识中心会话 append；测试=捕获数组） */
  reportReceipt?: (events: KcCardEvent[], finding: FindingRow) => void
}

interface PageWork {
  relPath: string
  fileName: string
  meta: WikiPageFrontmatter
  body: string
  created: boolean
}

const TERMINAL: FixTaskStatus[] = ["committed", "failed"]

export class FindingOpsService {
  private readonly dao: FindingsDAO
  private readonly tasks = new Map<string, FixTaskRecord>()
  private seq = 0
  readonly root: string
  readonly wikiRoot: string
  private readonly db: Database.Database
  private readonly queue: WriteQueue
  private readonly llm?: LLMCall
  private readonly git?: GitRunner
  private readonly now: () => Date
  private readonly capacity: number
  private readonly reportReceipt?: (events: KcCardEvent[], finding: FindingRow) => void

  constructor(deps: FindingOpsDeps) {
    this.db = deps.db
    applySchema(this.db)
    this.dao = new FindingsDAO(this.db)
    this.root = resolveKnowledgeRoot(deps.root)
    this.wikiRoot = path.join(this.root, "wiki")
    this.queue = deps.queue ?? new CompileQueue()
    this.llm = deps.llm
    this.git = deps.git
    this.now = deps.now ?? (() => new Date())
    this.capacity = deps.capacity ?? 200
    if (deps.reportReceipt) this.reportReceipt = deps.reportReceipt
  }

  // ── 读面（列表/计数；路由与 S2 消费）──
  list(status?: FindingStatus): FindingRow[] { return this.dao.list(status) }
  get(id: string): FindingRow | undefined { return this.dao.getById(id) }
  countOpen(): number { return this.dao.countOpen() }

  /** [忽略]：记录在案不再扰（同步状态迁移，零编译）。 */
  ignore(id: string): FindingRow {
    const row = this.requireOpen(id)
    this.dao.updateStatus(id, "ignored")
    return { ...row, status: "ignored" }
  }

  /** [采纳修订]：校验 → 建任务 → 入全局队列，立即返回 queued 回执。 */
  adopt(id: string): FixTaskRecord {
    const row = this.requireOpen(id)
    const id0 = `fft-${this.now().toISOString().replace(/[-:]/g, "").slice(0, 13)}-${String(++this.seq).padStart(3, "0")}`
    const rec: FixTaskRecord = {
      id: id0,
      findingId: row.id,
      kind: row.kind,
      status: "queued",
      createdAt: this.now().toISOString(),
    }
    this.tasks.set(id0, rec)
    this.evict()
    this.queue.enqueue("finding-fix", async () => {
      await this.start(id0)
      const done = this.tasks.get(id0)
      if (done?.status === "failed") {
        const code = done.error?.code ?? "FINDING_FIX_FAILED"
        throw Object.assign(new Error(`${code}: ${done.error?.message ?? "修订失败"}`), { code })
      }
    }, { taskId: id0, label: `${row.kind}:${row.id}` })
    return rec
  }

  /** 任务读面：未终态时与队列对账（锁占用等队列侧失败也能显形，revert 同律）。 */
  getTask(id: string): FixTaskRecord | undefined {
    const rec = this.tasks.get(id)
    if (!rec) return undefined
    if (rec.status === "queued" || rec.status === "running") {
      const q = this.queue.get(id)
      if (q?.state === "failed") {
        rec.status = "failed"
        rec.error = q.error ?? { code: "QUEUE_OP_FAILED", message: "队列任务失败（无错误详情）" }
        rec.startedAt = q.startedAt
        rec.finishedAt = q.finishedAt ?? this.now().toISOString()
      }
    }
    return rec
  }

  listTasks(): FixTaskRecord[] { return [...this.tasks.values()].reverse() }

  private requireOpen(id: string): FindingRow {
    const row = this.dao.getById(id)
    if (!row) throw new FindingOpsError("NOT_FOUND", `finding 不存在：${id}`, 404)
    if (row.status !== "open") {
      throw new FindingOpsError("FINDING_ALREADY_ADJUDICATED", `finding 已裁决（${row.status}），不再重复处置：${id}`, 409)
    }
    return row
  }

  private async start(taskId: string): Promise<void> {
    const rec = this.tasks.get(taskId)
    if (!rec || rec.status !== "queued") return
    rec.status = "running"
    rec.startedAt = this.now().toISOString()
    try {
      const row = this.dao.getById(rec.findingId)
      if (!row) throw new FindingOpsError("NOT_FOUND", `执行时 finding 已不在：${rec.findingId}`, 404)
      rec.result = await this.execute(row, rec)
      this.dao.updateStatus(row.id, "resolved")
      rec.status = "committed"
      // Lane A 回执：裁决即编译的持久形态（diff 卡跟随 + finding 终态卡）
      if (this.reportReceipt && rec.result) {
        const diffData: KcCompileDiffCardData = {
          taskId: rec.id,
          status: "committed",
          commit: rec.result.commit ?? undefined,
          touched: rec.result.touched.map(t => ({ path: t.path, type: t.type, created: t.created })),
          created: rec.result.touched.filter(t => t.created).length,
          updated: rec.result.touched.filter(t => !t.created).length,
          ftsOk: rec.result.warnings.length === 0,
        }
        const ts = this.now().toISOString()
        const resolvedCard = findingCardData(row)
        this.reportReceipt([
          { id: `dif-${rec.id}`, kind: "compile-diff", ts, data: diffData },
          { id: row.id, kind: "finding", ts, data: { ...resolvedCard, status: "resolved", fix: { taskId: rec.id, status: "committed", commit: rec.result.commit ?? undefined } } },
        ], row)
      }
    } catch (err) {
      const code = err instanceof FindingOpsError ? err.code : "FINDING_FIX_FAILED"
      const message = err instanceof Error ? err.message : String(err)
      rec.error = { code, message: message.replace(new RegExp(`^${code}: `), "") }
      rec.status = "failed"
      process.stderr.write(`[finding-fix] ${taskId} failed: ${message}\n`)
    } finally {
      rec.finishedAt = this.now().toISOString()
    }
  }

  /** 队列执行体（已持串行位）：按 kind 生成修订稿 → 唯一写闸编译（lint 闸照过）。 */
  private async execute(row: FindingRow, rec: FixTaskRecord): Promise<FixTaskResult> {
    const detail = safeParse(row.detail) as Record<string, unknown>
    const pages = safeParse(row.pages) as string[]
    const scanned = scanWikiEntries(this.wikiRoot)
    const today = this.now().toISOString().slice(0, 10)

    /** 现库 v3 页 → 工作面（v2/判例目标拒收：修订只走 v3 形态，同票05 先例）。 */
    const loadWork = (relPath: string): PageWork => {
      const entry = scanned.find(e => e.relPath === relPath)
      if (!entry) throw new FindingOpsError("FINDING_TARGET_MISSING", `涉事页不在盘：${relPath}`, 409)
      const parsed = parseWikiFile(fs.readFileSync(path.join(this.wikiRoot, relPath), "utf-8"))
      if (parsed.kind !== "page") {
        throw new FindingOpsError("FINDING_TARGET_LEGACY", `页 ${relPath} 非 v3 形态，修订通道只接 v3 页（重蒸馏属票07）`, 409)
      }
      return {
        relPath,
        fileName: relPath.split("/").pop() ?? `${parsed.meta.id}.md`,
        meta: { ...parsed.meta, last_compiled: today },
        body: parsed.body,
        created: false,
      }
    }

    const works: PageWork[] = []
    let fixNote = `finding 采纳修订 ${row.kind} · 裁决即编译（票13）`
    switch (row.kind) {
      case "missing-xref": {
        const a = String(detail.a ?? pages[0] ?? "")
        const b = String(detail.b ?? pages[1] ?? "")
        if (!a || !b) throw new FindingOpsError("FINDING_TARGET_MISSING", "缺互链 finding 缺少 a/b 页", 409)
        const wa = loadWork(a)
        const wb = loadWork(b)
        wa.meta = { ...wa.meta, links: [...new Set([...wa.meta.links, wb.meta.id])] }
        wb.meta = { ...wb.meta, links: [...new Set([...wb.meta.links, wa.meta.id])] }
        works.push(wa, wb)
        break
      }
      case "orphan": {
        const page = String(detail.page ?? pages[0] ?? "")
        const work = loadWork(page)
        // 入链宿主 = 与本共享 topic 的内容页（字典序首位）；没有 ⇒ 无法机械补链，响亮失败
        const host = scanned
          .filter(e => e.relPath !== work.relPath && (e.type === "entity" || e.type === "concept" || e.type === "topic"))
          .filter(e => work.meta.topics.some(t => e.meta.topics.includes(t)))
          .sort((x, y) => x.relPath.localeCompare(y.relPath))[0]
        if (!host) {
          throw new FindingOpsError("FINDING_FIX_NO_RELATED", `孤儿页 ${page} 无同 topic 内容页可挂链——改对话让策展人充实内容或退役（[讨论]）`, 409)
        }
        const wh = loadWork(host.relPath)
        wh.meta = { ...wh.meta, links: [...new Set([...wh.meta.links, work.meta.id])] }
        wh.body = appendSeeAlso(wh.body, work.meta.id)
        works.push(wh)
        break
      }
      case "missing-page": {
        const target = String(detail.target ?? "")
        if (!target) throw new FindingOpsError("FINDING_TARGET_MISSING", "缺页 finding 缺少 target", 409)
        const id = pageIdForTarget(target)
        const type = id.startsWith("ent-") ? "entity" as const : id.startsWith("top-") ? "topic" as const : "concept" as const
        const hostRefs = (Array.isArray(detail.hosts) ? detail.hosts as string[] : pages)
          .map(p => p.split("/").pop()?.replace(/\.md$/, "") ?? p)
        const stubMeta: WikiPageFrontmatter = {
          id,
          type,
          title: target,
          summary: `缺页建档（巡检 finding 采纳）：被 ${hostRefs.length} 页引用而实体页缺席，内容待策展人对话充实`,
          topics: [],
          aliases: [],
          links: [...new Set(hostRefs)],
          last_compiled: today,
          sources: [],
        }
        works.push({
          relPath: `${pageDirForType(type)}/${id}.md`,
          fileName: `${id}.md`,
          meta: stubMeta,
          body: `## 定义\n\n本${type === "topic" ? "主题" : type === "entity" ? "实体" : "概念"}页由巡检 finding 采纳自动建档：\`[[${target}]]\` 被引用但缺页。定义与断言待策展人经对话充实（回填通道 [编进 wiki]）。\n`,
          created: true,
        })
        break
      }
      case "contradiction": {
        // 票04·故事26（D-aa16-3 清偿）：对手页已退役 ⇒ 单侧降级，不 failed。
        // 判据严格：scan 缺席 **且** `_retired/<relPath>` 在盘才算退役（真缺席 ghost 不降级，
        // 响亮 FINDING_TARGET_MISSING 照旧）；LLM 修订语义要求双方原文在场，单侧无生成面，
        // 处置=清除本页标记行 + LOG 注记（退役执行体已摘 [[链接]]，矛盾事实面随之收敛）。
        const retired = pages.filter(
          p => !scanned.some(e => e.relPath === p) && fs.existsSync(path.join(this.wikiRoot, "_retired", p)),
        )
        if (retired.length > 0) {
          const live = pages.filter(p => !retired.includes(p))
          if (live.length === 0) {
            // 双页皆退役：活页面无标记可清 ⇒ 空转闭环（裁决归档，不再恒 failed）
            return {
              commit: null, changed: false, touched: [],
              warnings: [`矛盾归档：涉事 ${pages.length} 页均已退役 _retired/，活页无标记需清除`],
            }
          }
          works.push(...live.map(p => {
            const w = loadWork(p)
            return { ...w, body: stripFindingMarkers(w.body, row.id) }
          }))
          fixNote = `finding 采纳修订 contradiction · 单侧裁决（对手已退役：${retired.join(", ")}）· 标记清除（票04）`
          break
        }
        const revise = await this.semanticRevision(row, detail, pages, scanned, loadWork)
        works.push(...revise)
        break
      }
      case "stale": {
        const revise = await this.semanticRevision(row, detail, pages, scanned, loadWork)
        works.push(...revise)
        break
      }
      case "case-backlog": {
        // P3 票03 六查采纳：判例蒸馏=确定性编译（不走 LLM——规则文本机械提纯自判例
        // 五段），产物 topics 硬约束 + 判例↔规则互指。独立成对写（topic 批通道 +
        // case 单页通道），自返结果绕开通用 works/tail。
        return await this.distillCase(row, detail, pages)
      }
      case "index-budget": {
        // 票03 AC3「采纳『移 Optional』则重编译 INDEX」：经本 finding-fix 队列串行位
        // 重建确定性 INDEX（红线1——一切 wiki 根写经队列，rebuildIndex 禁队外直调）。
        // 在盘 INDEX 已是收敛态 ⇒ 空转成功零写（distillCase 空转先例同形态，裁决按闭环）。
        const compiler = new WikiCompileService({
          db: this.db, org: GLOBAL_WIKI_ORG, rootDir: this.wikiRoot,
          ...(this.git ? { git: this.git } : {}),
        })
        const res = await compiler.rebuildIndex({
          entry: `INDEX.md ← ${row.id}`,
          note: "预算预警采纳：INDEX 恒见段重建（裁决即编译 · 票03）",
          source: "compile",
          reviewer: "owner",
        })
        return {
          commit: res.commit,
          changed: res.changed,
          touched: [{ path: "INDEX.md", type: "index", created: false }],
          warnings: res.changed ? [] : ["在盘 INDEX 已是确定性重建收敛态，空转零写（裁决按闭环处理）"],
        }
      }
      default:
        throw new FindingOpsError("FINDING_FIX_UNSUPPORTED_KIND", `本通道不接 kind='${row.kind}'`, 400)
    }

    const batch: BatchPageInput[] = works.map(w => ({ content: serializePageMarkdown(w.meta, w.body), fileName: w.fileName }))
    const compiler = new WikiCompileService({
      db: this.db, org: GLOBAL_WIKI_ORG, rootDir: this.wikiRoot,
      ...(this.git ? { git: this.git } : {}),
    })
    const res = await compiler.compilePages(batch, {
      action: "compile",
      entry: row.title,
      note: fixNote,
      source: row.raw_ref || "patrol",
      reviewer: "owner",
    })
    return {
      commit: res.commit,
      changed: res.changed,
      touched: res.pages.map(p => ({ path: p.path, type: p.type, created: p.created })),
      warnings: res.pages.flatMap(p => p.warnings),
    }
  }

  /** contradiction/stale 共用的 LLM 修订稿面：捕获 prompt=证据；输出 pages[] 全覆盖 + 锚点守门。 */
  private async semanticRevision(
    row: FindingRow,
    detail: Record<string, unknown>,
    pages: string[],
    scanned: ReturnType<typeof scanWikiEntries>,
    loadWork: (relPath: string) => PageWork,
  ): Promise<PageWork[]> {
    if (!this.llm) {
      throw new FindingOpsError("LLM_UNAVAILABLE", "修订稿需要策展 LLM（未注入/被禁用）；finding 保持 open，可改 [讨论] 或启用 provider 后重试", 503)
    }
    const works = pages.map(p => loadWork(p))
    const schemaPath = path.join(this.root, "SCHEMA.md")
    const schemaText = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, "utf-8") : "（SCHEMA.md 缺席——按页格式 v3 常识执行）"
    const context = works.map(w => `### ${w.relPath}\n\n${serializePageMarkdown(w.meta, w.body)}`).join("\n---\n\n")
    const evidence = row.kind === "contradiction"
      ? `旧断言：「${String(detail.old_claim ?? "")}」\n新断言：「${String(detail.new_claim ?? "")}」\n处置：旧断言所在页改写为**历史沿革**口吻（保留信息、指明已废止），新断言页维持现说。`
      : `消费侧 stale 上报：目标 ${String(detail.anchor ?? detail.target ?? "")}，说明「${String(detail.note ?? "")}」。处置：按上报把涉事规则行改到与现场一致，**锚点注释 <!--#oct-…--> 原位保留**。`
    const prompt = `# finding 修订稿任务（${row.kind}｜${row.title}）

你是策展人。对下面 finding 涉及的页生成修订稿。必读 SCHEMA.md 约定：

${schemaText}

## 涉事页现文

${context}

## 证据与处置

${evidence}

## 输出契约

只输出一个 JSON 对象（可 \`\`\`json 围栏）：
{"pages":[{"relPath":"<涉事页相对路径，须全覆盖>","body":"<修订后正文，无 front-matter>"}]}

硬性纪律：
1. 正文原有锚点注释（<!--#oct-NNN-->）**逐条原样保留、位置随句**——锚点丢失=修订作废。
2. 正文零日期；不新增 front-matter 字段；[[链接]] 目标必须存在。
3. 裁决人=owner（本 finding 已被采纳），把裁决结果落成页文，不要输出讨论过程。`
    const resp = await this.llm(prompt)
    if (!resp || resp.trim() === "") {
      throw new FindingOpsError("LLM_UNAVAILABLE", "策展 LLM 无响应，修订未开始、零副作用", 503)
    }
    const start = resp.indexOf("{")
    const end = resp.lastIndexOf("}")
    let plan: { pages?: Array<{ relPath?: unknown; body?: unknown }> }
    try {
      plan = JSON.parse(resp.slice(start, end + 1))
    } catch {
      throw new FindingOpsError("FINDING_LLM_JSON", "修订稿不是可读 JSON", 502)
    }
    const out = new Map<string, string>()
    for (const p of plan.pages ?? []) {
      if (typeof p.relPath === "string" && typeof p.body === "string") out.set(p.relPath, p.body)
    }
    const today = this.now().toISOString().slice(0, 10)
    const revised: PageWork[] = []
    for (const w of works) {
      const newBody = out.get(w.relPath)
      if (newBody === undefined) {
        throw new FindingOpsError("FINDING_LLM_PLAN", `修订稿未覆盖涉事页：${w.relPath}`, 502)
      }
      // 锚点守门：在盘锚点一条不能少（wiki_refs 不断链的硬约束，curator 同款）
      const oldAnchors = new Set(scanned.find(e => e.relPath === w.relPath)?.anchors ?? extractRuleAnchors(w.body))
      const kept = extractRuleAnchors(newBody)
      const lost = [...oldAnchors].filter(a => !kept.includes(a))
      if (lost.length > 0) {
        throw new FindingOpsError("FINDING_ANCHOR_LOST", `修订丢失在盘锚点 ${lost.join(", ")}——锚点不可删改，任务终止库未动`, 409)
      }
      revised.push({
        ...w,
        meta: { ...w.meta, last_compiled: today },
        // 服务端剥除本 finding 标记行（裁决落地=待裁决标记退役；不依赖模型自觉）
        body: stripFindingMarkers(newBody, row.id),
      })
    }
    // 涉事页集合已含全部标记宿主（patrol 的 pages 由标记扫集而来），逐页净洗即可
    return revised
  }

  /**
   * P3 票03 case-backlog 采纳：判例 → topics 硬约束页（蒸馏本体确定性；spec 故事 13）。
   * - 产物互指：topic 正文 [[case-id]]（入链=孤儿判据解除）+ case.rule_ref=新发锚点
   *   （patrol 六查据此出列；孤儿面认 rule_ref 边）。
   * - 判例面只翻可变面 status=distilled + rule_ref [+ procedural]，正文逐字回写
   *   （append-only 天然同文 ⇒ compileCase 走固定字段/正文逐字校验通过，仅状态更新留 LOG 行）。
   * - aa-fix 项8（三路之b 写侧）：LLM seam 按五段内容判「流程型」打标——可选装饰面，
   *   seam 缺席/坏形/抛错=零标记（诚实缺席），b 路检测降级词表兜底；蒸馏决定面不依赖 LLM。
   * - 竞态幂等：目标已非 open/已带 rule_ref ⇒ 空转成功零写（finding 仍 resolved）。
   * - 蒸馏文本净洗：判例教训/修复段里的日期形态一律剥除（topic 页 L5 零日期闸不豁免——
   *   判例豁免半衰期是因历史绑定，蒸馏产物是常青规则）。
   */
  private async distillCase(row: FindingRow, detail: Record<string, unknown>, pages: string[]): Promise<FixTaskResult> {
    const caseRel = String(detail.case ?? pages[0] ?? "")
    if (!caseRel) throw new FindingOpsError("FINDING_TARGET_MISSING", "判例积压 finding 缺少 case 路径", 409)
    const abs = path.join(this.wikiRoot, caseRel)
    if (!fs.existsSync(abs)) throw new FindingOpsError("FINDING_TARGET_MISSING", `判例页不在盘：${caseRel}`, 409)
    const parsed = parseCaseMarkdown(fs.readFileSync(abs, "utf-8"))
    const meta = parsed.meta
    const body = parsed.body
    if (meta.status !== "open" || meta.rule_ref !== undefined) {
      return {
        commit: null, changed: false,
        touched: [{ path: caseRel, type: "case", created: false }],
        warnings: [`判例 '${meta.id}' 现为 ${meta.status}${meta.rule_ref ? `（rule_ref=${meta.rule_ref}）` : ""}，蒸馏空转（裁决按闭环处理）`],
      }
    }

    const compiler = new WikiCompileService({
      db: this.db, org: GLOBAL_WIKI_ORG, rootDir: this.wikiRoot,
      ...(this.git ? { git: this.git } : {}),
    })
    // aa-fix 项8（spec 三路之b 写侧契约）：蒸馏产物生成处按五段内容跑 LLM seam
    // 判「流程型」打标。**标记失败不毁裁决链**：seam 缺席/抛错/坏形 ⇒ 零标记位
    // （诚实缺席=判例面不写 procedural，b 路检测降级词表兜底），蒸馏本体照 committed。
    const procedural = await this.judgeProcedural(meta, body)
    const anchor = nextRuleAnchor(this.wikiRoot)
    const topicId = `top-${meta.id}`
    const lesson = scrubDates(caseSectionText(body, "教训") || caseSectionText(body, "根因") || meta.symptom)
    const fixNote = scrubDates(caseSectionText(body, "修复") || "命中该症状时先复查判例五段")
    const today = this.now().toISOString().slice(0, 10)
    const topicMeta: WikiPageFrontmatter = {
      id: topicId, type: "topic",
      title: `判例蒸馏：${scrubDates(meta.symptom)}`.slice(0, 80),
      summary: `巡检六查「判例积压」采纳蒸馏：${scrubDates(meta.symptom)}（${meta.occurrences} 次命中，判例 ${meta.id}）`.slice(0, 120),
      topics: meta.tags.length > 0 ? meta.tags : [meta.id],
      aliases: [], links: [meta.id],
      last_compiled: today, sources: [meta.source],
    }
    const topicBody = [
      `## 硬约束`,
      ``,
      `- 命中「${scrubDates(meta.symptom)}」时：${lesson} <!--#${anchor}-->`,
      ``,
      `## 处置参考`,
      ``,
      `- ${fixNote}`,
      ``,
      `## 判例`,
      ``,
      `- [[${meta.id}]]（${meta.occurrences} 次命中 · ${meta.source}）`,
      ``,
    ].join("\n")

    const topicRes = await compiler.compilePages(
      [{ content: serializePageMarkdown(topicMeta, topicBody), fileName: `${topicId}.md` }],
      {
        action: "compile", entry: row.title,
        note: `判例蒸馏 ${meta.id} → ${topicId}（六查采纳 · 裁决即编译）`,
        source: caseRel, reviewer: "owner",
      },
    )
    const caseRes = await compiler.compileEntry({
      content: serializeCaseMarkdown(
        { ...meta, status: "distilled", rule_ref: anchor, ...(procedural !== undefined ? { procedural } : {}) },
        body,
      ),
      fileName: caseRel.split("/").pop() ?? `${meta.id}.md`,
      source: caseRel, reviewer: "owner",
      note: `判例蒸馏 status=distilled rule_ref=${anchor}${procedural !== undefined ? ` procedural=${procedural}` : ""}`,
    })
    const warnings = [...topicRes.pages.flatMap(p => p.warnings), ...caseRes.warnings]
    return {
      commit: caseRes.commit ?? topicRes.commit,
      changed: topicRes.changed || caseRes.changed,
      touched: [
        ...topicRes.pages.map(p => ({ path: p.path, type: p.type, created: p.created })),
        { path: caseRes.path, type: "case", created: false },
      ],
      warnings,
    }
  }

  /**
   * 「流程型」seam 判定（aa-fix 项8·三路之b 写侧）。三态归一：
   * - llm 缺席（注入面未接）⇒ undefined=诚实缺席；
   * - seam 抛错/坏形/空响应 ⇒ undefined（stderr 记账，蒸馏不折戟）；
   * - 契约 JSON ⇒ true/false 显式标记。
   * prompt/解析单源=skill-detect.ts（S1 断言入口同缝）。
   */
  private async judgeProcedural(meta: WikiCaseFrontmatter, body: string): Promise<boolean | undefined> {
    if (!this.llm) return undefined
    try {
      const resp = await this.llm(buildProceduralJudgePrompt({ symptom: meta.symptom, sections: parseCaseSections(body) }))
      return parseProceduralJudgment(resp)
    } catch (err) {
      process.stderr.write(`[findings] procedural judge failed for ${meta.id}: ${err instanceof Error ? err.message : String(err)}\n`)
      return undefined
    }
  }

  private evict(): void {
    if (this.tasks.size <= this.capacity) return
    for (const [id, rec] of this.tasks) {
      if (TERMINAL.includes(rec.status)) {
        this.tasks.delete(id)
        if (this.tasks.size <= this.capacity) return
      }
    }
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** 判例正文取指定段文本（## 段名 到下个 ## 前）；缺席 = 空串。 */
function caseSectionText(body: string, name: string): string {
  const lines = body.split("\n")
  const start = lines.findIndex(l => l.startsWith(`## ${name}`))
  if (start === -1) return ""
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) break
    out.push(lines[i]!)
  }
  return out.join("\n").trim()
}

/** 蒸馏净洗：剥除 findDateOccurrences 同族日期形态（常青规则页不背历史时间戳）+ 压空白。 */
export function scrubDates(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}|\d{4}\/\d{1,2}\/\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日/g, "")
    .replace(/[（(]\s*[）)]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
}

/** 剥除本 finding 的「冲突待裁决」标记行；小节被剥空则连小节题一并去。 */
export function stripFindingMarkers(body: string, findingId: string): string {
  const esc = findingId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  let out = body.replace(new RegExp(`^>[^\n]*【${esc}】[^\n]*\n`, "gm"), "")
  const SECTION = "## 冲突待裁决"
  if (out.includes(SECTION)) {
    const idx = out.indexOf(SECTION)
    const next = out.indexOf("\n", idx)
    const after = next === -1 ? "" : out.slice(next + 1)
    if (!/^>\s*【fnd-/.test(after.replace(/^\s+/, ""))) {
      out = out.slice(0, idx) + after.replace(/^\s*\n/, "\n")
      out = out.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "\n")
    }
  }
  return out
}

/** 缺页建档的目标 → 页 id（kebab 闸保底；CJK 目标走哈希址，title 保留原词）。 */
export function pageIdForTarget(target: string): string {
  const base = (target.split("/").pop() ?? target).replace(/\.md$/, "").trim()
  const cleaned = base
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (/^(ent|con|top)-[a-z0-9-]+$/.test(cleaned)) return cleaned
  if (/^[a-z][a-z0-9-]*$/.test(cleaned)) return `con-${cleaned}`
  return `con-${crypto.createHash("sha256").update(base, "utf-8").digest("hex").slice(0, 8)}`
}

/** 在宿主页尾挂「## 相关」互链（orphan 采纳的确定性补链面）。 */
function appendSeeAlso(body: string, targetId: string): string {
  const line = `- [[${targetId}]]`
  if (body.includes(line)) return body
  if (body.includes("## 相关")) {
    return body.replace("## 相关\n", `## 相关\n${line}\n`)
  }
  return `${body.replace(/\s+$/, "")}\n\n## 相关\n${line}\n`
}
