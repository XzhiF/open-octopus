import type Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { STALE_REF_PREFIX, WIKI_REFS_KEY } from "@octopus/shared"
import { KnowledgeEffectivenessDAO } from "../../db/dao/knowledge-effectiveness-dao"
import { resolveKnowledgeRoot, WIKI_PAGE_DIRS } from "./global-paths"
import { pageLedgerStem } from "./page-stem"
import { ruleLinesForFormCheck } from "./wiki/lint"

/**
 * EffectivenessLedgerService — P4 票06「effectiveness 记账解析器」（spec 故事 1/6/7）。
 *
 * 服务端**离线增量**解析执行产物 → knowledge_effectiveness 记账（引用计数/最近引用
 * 时间；helpful/not_helpful 由 blocker↔锚点 LLM 关联判定落账，见 judge 段）。
 * agent 运行时零感知（spec 故事 7）：本服务只读 executions 表/fs 日志，不经也不改
 * engine/prompt/VarPool 执行链路——旧 effectiveness.ts「上游寄生运行时即蒸发」教训
 * （git 史 cc6b2d4b）的反面定形。
 *
 * 输入三面（数据权威制式对齐 patrol ②查 / wiki-refs-persistence 先例）：
 *  ① wiki_refs 引用记账：DB `executions.var_pool` 的 `wiki_refs` 数组逐条归一记账
 *     （权威=DB，非 JSONL 文本面——`页id#锚点`→锚点键（锚点全库唯一，SCHEMA.md
 *     命名法）、裸 `oct-XXX`→锚点键、`页id/页路径`→页键；`stale:` 前缀项剥前缀后
 *     同键并入——上报 stale 也是对该锚点的一次真实消费）。
 *  ② 页级查阅记账：执行 JSONL `{wsPath}/logs/{execId}/*.jsonl` 的 tool_call/Read 行
 *     （行形 = logger.ts:110，input 为 JSON 字符串）——file_path 落知识根 wiki 的
 *     内容目录（entities/concepts/topics/cases，与 patrol CONTENT_TYPES 同面）才算，
 *     INDEX.md/回执页 sources/仓外文件不计；页键=文件名 stem（实证 == front-matter id）。
 *  ③ blocker 输入契约（**spec-现实偏差裁定**，P3 先例记账）：票面「review 节点
 *     blocker」在现行运行时无结构化信道（实探：真 review 节点 JSONL 只有自由文本、
 *     var_pool `review_blockers` 存量 0 行、唯一残留消费方 archive.ts:58-63 读已死
 *     state 文件）。裁定 = 与 wiki_refs 同款 **DB 权威键面**：`executions.var_pool.
 *     review_blockers`，双形读取（native 字符串数组 ∨ JSON 字符串化的数组；坏形条目
 *     诚实弃）。agent 侧上报纪律（review 节点经 vars_update 写该键）属 octo-wiki
 *     skill 引用纪律面演进，**不在本票**（本票执行链路零改动）。
 *
 * 幂等（红线6）：游标持久记至 execution（effectiveness_cursors，PK=execution_id）；
 * 一执行至多解析一次，重跑零重复记账。同执行内同键并集去重（一次执行 = 一次消费
 * 信号，vars_update 里的重复罗列不虚增计数）。记账时刻 = 执行落库时刻
 * （completed_at∨updated_at∨created_at），非挂钟 ⇒ 离线重放确定。
 *
 * 副作用面：只写 knowledge_effectiveness + effectiveness_cursors 两表；wiki/fs/git
 * 零触碰、不经写队列（票06 写面只有 DB 记账；confidence 刷页通道属票07）。
 */

/** 内容目录 = 可被「消费」的规则页所在面（WIKI_PAGE_DIRS 单源减去 sources 回执页——
 *  回执页不是规则载体，patrol「sources 不算入链方」同律）。 */
const LEDGER_CONTENT_DIRS: ReadonlySet<string> = new Set(WIKI_PAGE_DIRS.filter(d => d !== "sources"))

/** 裸锚点 token（SCHEMA.md 命名法 oct-NNN 族；与 patrol ②查的锚点归属同判据）。 */
const BARE_ANCHOR_RE = /^oct-[0-9A-Za-z]+$/

/**
 * blocker 信道键（头注裁定③单源）：vars_update → VarPool 通道的 DB 权威键，
 * 与 WIKI_REFS_KEY 同族制式；旧消费方 archive.ts:58-63 读 state 文件已死面。
 */
export const REVIEW_BLOCKERS_KEY = "review_blockers"

export interface LedgerReport {
  /** 本轮新解析的执行数 */
  scanned: number
  /** 落账的引用条数（去重后的 键×执行 对） */
  citations: number
  helpful: number
  notHelpful: number
  /** 关联判定诚实缺席码族计数（no_llm/empty/bad_json/error…） */
  linkSkips: Record<string, number>
  warnings: string[]
  /** 本轮最后处理的 execution id（游标可查面；"解析至最新"的观测量） */
  lastCursor: string | null
}

interface PendingExecution {
  id: string
  var_pool: string | null
  ws_path: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface EffectivenessLedgerDeps {
  db: Database.Database
  /** 知识根覆盖（测试注入 tmpdir；缺省 resolveKnowledgeRoot()——patrol 同款缝） */
  root?: string
  /** blocker↔锚点关联判定 LLM seam（缺席 ⇒ 诚实跳过，引用账照常落） */
  llm?: (prompt: string) => Promise<string>
  /** 时钟注入（游标 parsed_at；红线6——判据不用 sleep） */
  now?: () => Date
}

export class EffectivenessLedgerService {
  private readonly db: Database.Database
  private readonly dao: KnowledgeEffectivenessDAO
  readonly root: string
  private readonly wikiRoot: string
  private readonly llm?: (prompt: string) => Promise<string>
  private readonly now: () => Date

  constructor(deps: EffectivenessLedgerDeps) {
    this.db = deps.db
    this.dao = new KnowledgeEffectivenessDAO(deps.db)
    this.root = resolveKnowledgeRoot(deps.root)
    this.wikiRoot = path.join(this.root, "wiki")
    this.llm = deps.llm
    this.now = deps.now ?? (() => new Date())
  }

  /** 解析所有未记账执行（增量至最新）；返回本轮报告。触发面：夜巡腿 + 手动端点。 */
  async parse(): Promise<LedgerReport> {
    const report: LedgerReport = { scanned: 0, citations: 0, helpful: 0, notHelpful: 0, linkSkips: {}, warnings: [], lastCursor: null }
    const pending = this.db
      .prepare(
        `SELECT e.id, e.var_pool, e.created_at, e.updated_at, e.completed_at, w.path AS ws_path
         FROM executions e
         LEFT JOIN workspaces w ON w.id = e.workspace_id
         WHERE NOT EXISTS (SELECT 1 FROM effectiveness_cursors c WHERE c.execution_id = e.id)
         ORDER BY e.created_at ASC, e.id ASC`,
      )
      .all() as PendingExecution[]

    // 锚点→规则原文索引（判 prompt 的证据面；盘读一轮，缺页诚实无文本不炸）
    const anchorIndex = pending.length > 0 ? this.scanAnchorRules() : new Map<string, { page: string; text: string }>()
    for (const exec of pending) {
      await this.parseOne(exec, report, anchorIndex)
    }
    return report
  }

  private async parseOne(
    exec: PendingExecution,
    report: LedgerReport,
    anchorIndex: Map<string, { page: string; text: string }>,
  ): Promise<void> {
    const at = exec.completed_at ?? exec.updated_at ?? exec.created_at

    let pool: Record<string, unknown> = {}
    let poolBad = false
    try {
      const raw = JSON.parse(exec.var_pool ?? "{}") as unknown
      if (raw && typeof raw === "object" && !Array.isArray(raw)) pool = raw as Record<string, unknown>
      else poolBad = true
    } catch {
      poolBad = true
    }

    const cited = new Map<string, boolean>() // key → isAnchor
    if (!poolBad) {
      for (const entry of stringArray(pool[WIKI_REFS_KEY])) {
        const norm = normalizeRefEntry(entry)
        if (norm) cited.set(norm.key, norm.isAnchor)
      }
      // 两通道同池去重（set 天然并集）：页级 Read 键不覆盖已入列锚点键（键面不交）
      for (const key of this.readPageKeys(exec)) if (!cited.has(key)) cited.set(key, false)
    } else {
      report.warnings.push(`var_pool 坏形，引用面跳过：${exec.id}`)
    }

    // —— 关联判定（红线3：唯一判道 = LLM seam；seam 缺席/空/坏形/抛=诚实缺席不毁记账）。
    // blockers 契约见头注裁定③：var_pool.review_blockers（DB 权威，双形读取）。
    const blockers = poolBad ? [] : stringArray(pool[REVIEW_BLOCKERS_KEY])
    const anchorKeys = [...cited.entries()].filter(([, isAnchor]) => isAnchor).map(([k]) => k)

    type Relation = "helpful" | "not_helpful" | "unrelated"
    let verdicts: Array<{ anchor: string; relation: Relation }> = []
    let linkStatus = ""
    if (blockers.length > 0 && anchorKeys.length > 0) {
      if (!this.llm) {
        linkStatus = "skipped:no_llm"
      } else {
        try {
          const resp = await this.llm(buildLinkJudgePrompt(anchorKeys, blockers, anchorIndex))
          if (!resp || resp.trim() === "") linkStatus = "skipped:empty"
          else {
            const parsed = parseLinkVerdicts(resp)
            if (parsed === null) linkStatus = "skipped:bad_json"
            else {
              linkStatus = "judged"
              // 越权防御：判定只吃本执行引用的锚点（LLM 幻觉 token 一律忽略）
              const allowed = new Set(anchorKeys)
              const seen = new Set<string>()
              verdicts = parsed.filter(v => allowed.has(v.anchor) && !seen.has(v.anchor) && (seen.add(v.anchor) || true))
            }
          }
        } catch {
          linkStatus = "skipped:error"
        }
      }
      if (linkStatus.startsWith("skipped:")) {
        const code = linkStatus.slice("skipped:".length)
        report.linkSkips[code] = (report.linkSkips[code] ?? 0) + 1
      }
    }

    const tx = this.db.transaction(() => {
      let cites = 0
      for (const [key] of cited) {
        this.dao.incrementCited(key, at)
        cites++
      }
      let helpful = 0
      let notHelpful = 0
      for (const v of verdicts) {
        if (v.relation === "helpful") {
          this.dao.incrementHelpful(v.anchor)
          helpful++
        } else if (v.relation === "not_helpful") {
          this.dao.incrementNotHelpful(v.anchor)
          notHelpful++
        }
      }
      this.db
        .prepare(
          `INSERT INTO effectiveness_cursors (execution_id, parsed_at, citations, helpful, not_helpful, link_status)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(exec.id, this.now().toISOString(), cites, helpful, notHelpful, linkStatus)
      report.scanned++
      report.citations += cites
      report.helpful += helpful
      report.notHelpful += notHelpful
      report.lastCursor = exec.id
    })
    tx()
  }

  /** 盘扫内容目录建 锚点→{页,规则原文} 索引（取数口=wiki/lint.ts ruleLinesForFormCheck 同族）。 */
  private scanAnchorRules(): Map<string, { page: string; text: string }> {
    const out = new Map<string, { page: string; text: string }>()
    for (const dir of WIKI_PAGE_DIRS) {
      if (dir === "sources") continue // 回执页非规则载体
      const abs = path.join(this.wikiRoot, dir)
      let names: fs.Dirent[]
      try {
        names = fs.readdirSync(abs, { withFileTypes: true })
      } catch {
        continue // 目录尚未创建（裸知识根）
      }
      const queue = names.filter(d => d.isFile() && d.name.endsWith(".md")).map(d => [dir, d.name] as [string, string])
      for (const d of names) {
        if (!d.isDirectory()) continue
        try {
          for (const sub of fs.readdirSync(path.join(abs, d.name)).filter(n => n.endsWith(".md"))) {
            queue.push([`${dir}/${d.name}`, sub])
          }
        } catch { /* 坏目录跳过 */ }
      }
      for (const [relDir, file] of queue) {
        let text: string
        try {
          text = fs.readFileSync(path.join(this.wikiRoot, relDir, file), "utf-8")
        } catch {
          continue
        }
        for (const rule of ruleLinesForFormCheck(text)) {
          if (!out.has(rule.anchor)) out.set(rule.anchor, { page: `${relDir}/${file.replace(/\.md$/i, "")}`, text: rule.text })
        }
      }
    }
    return out
  }

  /** 执行 JSONL 里的 wiki 内容页 Read 命中（页键集合）。日志目录缺席 ⇒ 诚实空面。 */
  private readPageKeys(exec: PendingExecution): string[] {
    if (!exec.ws_path) return []
    const wsPath = exec.ws_path.replace(/^~/, os.homedir())
    const logDir = path.join(wsPath, "logs", exec.id)
    let files: string[]
    try {
      files = fs.readdirSync(logDir).filter(f => f.endsWith(".jsonl"))
    } catch {
      return []
    }
    const out: string[] = []
    for (const f of files) {
      let text: string
      try {
        text = fs.readFileSync(path.join(logDir, f), "utf-8")
      } catch {
        continue
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue
        let entry: Record<string, unknown>
        try {
          entry = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue // 坏行跳过（logger 合并写盘尾行可能是半截——防御性）
        }
        if (entry.event !== "tool_call" || entry.toolName !== "Read") continue
        const key = this.pageKeyFromReadInput(entry.input)
        if (key) out.push(key)
      }
    }
    return out
  }

  /** Read input（JSON 字符串形制，logger.ts:380-393）→ file_path → wiki 内容页键。 */
  private pageKeyFromReadInput(input: unknown): string | null {
    if (typeof input !== "string") return null
    let parsed: unknown
    try {
      parsed = JSON.parse(input)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== "object") return null
    const fp = (parsed as Record<string, unknown>).file_path
    if (typeof fp !== "string" || !fp.toLowerCase().endsWith(".md")) return null
    const norm = (p: string) => path.resolve(p).replace(/\\/g, "/").toLowerCase()
    const file = norm(fp)
    const root = norm(this.wikiRoot)
    if (!file.startsWith(root + "/")) return null
    const rel = file.slice(root.length + 1).split("/")
    if (rel.length < 2) return null // wiki 根直属文件（INDEX.md 等）不算页消费
    if (!LEDGER_CONTENT_DIRS.has(rel[0])) return null
    const stem = rel[rel.length - 1].replace(/\.md$/, "")
    return stem && stem !== "index" ? stem : null
  }
}

/** pool 值 → 字符串数组宽容读（native 数组过滤 string；JSON 字符串化数组解一道；余者空）。 */
function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === "string")
  if (typeof value === "string") {
    try {
      const arr = JSON.parse(value)
      if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === "string")
    } catch {
      // 非数组字符串 = 坏形，诚实弃
    }
  }
  return []
}

/** wiki_refs 条目 → 记账键（三形态 + stale 前缀；规则见头注①）。 */
export function normalizeRefEntry(entry: string): { key: string; isAnchor: boolean } | null {
  let e = entry.trim()
  if (!e) return null
  if (e.startsWith(STALE_REF_PREFIX)) {
    const target = e.slice(STALE_REF_PREFIX.length).trim().split(/\s+/)[0] ?? ""
    if (!target) return null
    e = target
  }
  const hash = e.indexOf("#")
  if (hash !== -1) {
    const anchor = e.slice(hash + 1).trim()
    return anchor ? { key: anchor, isAnchor: true } : null
  }
  if (BARE_ANCHOR_RE.test(e)) return { key: e, isAnchor: true }
  // 页键 stem 归一单源=page-stem.ts（aa-fix 项②2——与 auto-retire pageLedgerKey/patrol 解析键三份合一）
  const stem = pageLedgerStem(e)
  return stem ? { key: stem, isAnchor: false } : null
}

/**
 * blocker↔锚点关联判定 prompt（**契约面**——票06 报告与 S1 测试共钉此形）：
 * 输入 = 本执行引用的锚点 token + 页/规则原文（盘扫所得）+ blocker 原文清单；
 * 输出契约 = `{"verdicts":[{"anchor":…,"relation":"helpful"|"not_helpful"|"unrelated"}]}`。
 * 语义 = spec 故事 2：同类 blocker 再现（规则没挡住坑）⇒ not_helpful；话题域零再现
 * ⇒ helpful；判不动 ⇒ unrelated（零计数）。判定权全在 LLM——本函数**零词面启发式**
 * （红线3：勿复活旧 effectiveness.ts 关键词重叠率近似，其教训=「规则越切题越被记无用」）。
 */
export function buildLinkJudgePrompt(
  anchorKeys: string[],
  blockers: string[],
  anchorIndex: Map<string, { page: string; text: string }>,
): string {
  const anchorLines = anchorKeys.map(k => {
    const hit = anchorIndex.get(k)
    return hit ? `- ${k} (页 ${hit.page})：${hit.text}` : `- ${k}（规则原文未在盘——按 token 话题域判）`
  })
  const blockerLines = blockers.map((b, i) => `${i + 1}. ${b}`)
  return `# effectiveness 关联判定（票06：同类 blocker 是否再现于被引锚点的话题域）

你是编译型知识库的实效审计员。下面这次执行查阅了若干规则锚点（topic 页「## 硬约束」带 \`<!--#锚点-->\` 的行），随后其 review 上报了 blocker 清单。对**每个锚点**判定其规则话题域与 blocker 的关系：

- "not_helpful"：某 blocker 与该锚点规则话题**同类坑再现**——规则被引用了却没挡住这个问题。
- "helpful"：blocker 清单中与该锚点话题域同类者**零再现**——规则话题未再犯。
- "unrelated"：信息不足以下判断——不硬判，零计数。

## 被引锚点

${anchorLines.join("\n")}

## blocker 清单

${blockerLines.join("\n")}

## 输出契约

只输出一个 JSON 对象（可 \`\`\`json 围栏），不给解释：

{"verdicts":[{"anchor":"<锚点 token，只取上方列表内的值>","relation":"helpful|not_helpful|unrelated"}]}

每个被引锚点至多一条 verdict；列表外 token 会被忽略。`
}

/**
 * 应答解析（JSON 提取制式 = findings.ts:382-389 semanticRevision 同款：首 { 到末 }）。
 * 坏形 ⇒ null（诚实缺席）；条目缺 anchor/relation 或非三值 ⇒ 逐条丢弃。
 */
export function parseLinkVerdicts(resp: string): Array<{ anchor: string; relation: "helpful" | "not_helpful" | "unrelated" }> | null {
  const start = resp.indexOf("{")
  const end = resp.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(resp.slice(start, end + 1))
  } catch {
    return null
  }
  if (!raw || typeof raw !== "object") return null
  const verdicts = (raw as Record<string, unknown>).verdicts
  if (!Array.isArray(verdicts)) return null
  const out: Array<{ anchor: string; relation: "helpful" | "not_helpful" | "unrelated" }> = []
  for (const v of verdicts) {
    if (!v || typeof v !== "object") continue
    const anchor = (v as Record<string, unknown>).anchor
    const relation = (v as Record<string, unknown>).relation
    if (typeof anchor !== "string" || !anchor) continue
    if (relation !== "helpful" && relation !== "not_helpful" && relation !== "unrelated") continue
    out.push({ anchor, relation })
  }
  return out
}
