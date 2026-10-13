import type Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import crypto from "crypto"
import { resolveGlobalKnowledgeRoot } from "./global-paths"

/**
 * 旧世界归档删除（知识中心票09，spec §「注入链与旧库硬废」数据归档段 +
 * 过闸文书 §5 归档不删纪律）。单入口幂等命令，真数据唯一执行面：
 *
 *   1. 各 org 的 `~/.octopus/orgs/<org>/knowledge/` 整树（projects/workflows/
 *      user_preference 原件/index.md/剩余 wiki 空壳）
 *      → `<知识根>/_archive/org-knowledge-{date}/orgs/<org>/` 后删源目录；
 *   2. 全局知识根下的旧语料 `projects/`、`workflows/`、`index.md`
 *      → `_archive/org-knowledge-{date}/global/` 后删除——**新世界文件
 *      （wiki/、raw/、SCHEMA.md、user_preference.md、_archive/）零触碰**；
 *   3. `experiences` 表全量导出 JSON + CSV
 *      → `_archive/org-knowledge-{date}/experiences/` **后** drop 表（含
 *      experiences_fts；行数对账进 dry-run 报告）。schema.sql 的 CREATE 与
 *      evolution/harness 管线测试的退役**不在本票面**（「经验管线代码删除属
 *      票10，别抢；DAO 僵尸引用交主控收敛」）——drop 后若服务重启会重建空表，
 *      数据已归档无损，终态收口在主控（票10 合并后单：DDL 移除 + 消费面降级）。
 *
 * 顺序铁律（S1）：一切「归档 + 校验」先行，「删除」全部押后——归档冲突/导出
 * 失败即抛错，此时零删除发生；修复后重跑从断点续到终态（幂等：源不在 ⇒ skip-absent，
 * 归档已在且逐字节一致 ⇒ skip-copy，表不在 ⇒ skip-absent）。
 *
 * 真数据纪律（铁律，同票03 WikiGlobalMigrator 先例）：只被显式调用
 * （scripts/kc-old-world-archive.ts CLI）；默认 dry-run 只读列计划，
 * `apply=true` 才动手；apply 前主控先备份 DB——精确命令见报告 backupHint。
 *
 * agent 记忆系统（daily/long-term/session——sessions/messages/session_memory_fts
 * 表 + clone memory 文件层）零触碰：本模块不读写任何记忆路径，报告含
 * memoryTablesBefore/After 对账（票面 AC4 断言源）。
 */

/** 票面 AC4 零触碰回归的独立真相源（schema.sql Agent Tables 段，非本模块产物）。 */
export const MEMORY_DOMAIN_TABLES = [
  "sessions",
  "messages",
  "session_memory_fts",
  "chat_sessions",
  "chat_messages",
] as const

export interface TeardownOptions {
  db: Database.Database
  /** false（默认）= dry-run 只读列计划；true = 执行归档+删除 */
  apply?: boolean
  /** orgs 根覆盖（测试注入 tmpdir；缺省 ~/.octopus/orgs，$OCTOPUS_HOME 钩子同 file-ops） */
  orgsBaseDir?: string
  /** 全局知识根覆盖（缺省 resolveGlobalKnowledgeRoot()；归档区 _archive/ 落其下） */
  knowledgeRoot?: string
  /** 归档批次日期标记（缺省今天 UTC YYYYMMDD；测试钉值） */
  dateTag?: string
}

export type TeardownAction = "archive+delete" | "skip-absent"

export interface OrgDirEntry {
  org: string
  from: string
  to: string
  files: number
  bytes: number
  action: TeardownAction
}

export interface GlobalLegacyEntry {
  name: string
  from: string
  to: string
  files: number
  bytes: number
  action: TeardownAction
}

export type ExperiencesAction = "export+drop" | "drop-verified-export" | "skip-absent"

export interface ExperiencesPlan {
  present: boolean
  rows: number
  ftsRows: number
  jsonPath: string
  csvPath: string
  action: ExperiencesAction
}

export interface OldWorldTeardownReport {
  dryRun: boolean
  dateTag: string
  archiveRoot: string
  orgDirs: OrgDirEntry[]
  globalLegacy: GlobalLegacyEntry[]
  experiences: ExperiencesPlan
  memoryTablesBefore: string[]
  memoryTablesAfter: string[]
  backupHint: string
}

function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

function todayTag(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "")
}

/** octopus home（口径同 global-paths.octopusHome：$OCTOPUS_HOME > ~/.octopus）。 */
function octopusHome(): string {
  return process.env.OCTOPUS_HOME ?? path.join(os.homedir(), ".octopus")
}

/** 递归列出 root 下全部文件的相对 POSIX 路径（root 不存在 ⇒ []）。 */
function listFilesRel(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else out.push(r)
    }
  }
  if (fs.existsSync(root)) walk(root, "")
  return out.sort()
}

/** CSV 单元转义（RFC4180 形态：含逗号/引号/换行加引号，引号翻倍；null ⇒ 空）。 */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ""
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export class OldWorldTeardownMigrator {
  private readonly apply: boolean
  private readonly orgsBase: string
  private readonly knowledgeRoot: string
  private readonly dateTag: string
  private readonly archiveRoot: string
  private readonly db: Database.Database

  constructor(opts: TeardownOptions) {
    this.db = opts.db
    this.apply = opts.apply ?? false
    this.orgsBase = opts.orgsBaseDir ?? path.join(octopusHome(), "orgs")
    this.knowledgeRoot = opts.knowledgeRoot ?? resolveGlobalKnowledgeRoot()
    this.dateTag = opts.dateTag ?? todayTag()
    this.archiveRoot = path.join(this.knowledgeRoot, "_archive", `org-knowledge-${this.dateTag}`)
  }

  async run(): Promise<OldWorldTeardownReport> {
    const orgDirs = this.planOrgDirs()
    const globalLegacy = this.planGlobalLegacy()
    const experiences = this.planExperiences()
    const memoryTablesBefore = this.memoryTables()

    const report: OldWorldTeardownReport = {
      dryRun: !this.apply,
      dateTag: this.dateTag,
      archiveRoot: this.archiveRoot,
      orgDirs,
      globalLegacy,
      experiences,
      memoryTablesBefore,
      memoryTablesAfter: memoryTablesBefore,
      backupHint: this.backupHint(),
    }
    if (!this.apply) return report

    // ── 阶段 A：归档 + 校验（先于一切删除；失败 ⇒ 零删除） ──
    this.archivePhase(orgDirs, globalLegacy, experiences)

    // ── 阶段 B：删除（目录 + 表；此刻归档物已全部落位并验过） ──
    this.deletePhase(orgDirs, globalLegacy, experiences)

    report.memoryTablesAfter = this.memoryTables()
    return report
  }

  // ── 计划 ────────────────────────────────────────────────

  private listOrgs(): string[] {
    try {
      return fs
        .readdirSync(this.orgsBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort()
    } catch {
      return [] // orgs 根不存在 ⇒ 无可归档对象（新机/测试半边 fixture）
    }
  }

  private planOrgDirs(): OrgDirEntry[] {
    const entries: OrgDirEntry[] = []
    for (const org of this.listOrgs()) {
      const from = path.join(this.orgsBase, org, "knowledge")
      const to = path.join(this.archiveRoot, "orgs", org)
      if (!fs.existsSync(from)) {
        entries.push({ org, from, to, files: 0, bytes: 0, action: "skip-absent" })
        continue
      }
      const files = listFilesRel(from)
      const bytes = files.reduce((s, f) => s + fs.statSync(path.join(from, f)).size, 0)
      entries.push({ org, from, to, files: files.length, bytes, action: "archive+delete" })
    }
    return entries
  }

  /** 旧知识目录三元面（file-ops 契约）：projects/ workflows/ index.md。 */
  private static readonly GLOBAL_LEGACY_TARGETS = ["projects", "workflows", "index.md"] as const

  private planGlobalLegacy(): GlobalLegacyEntry[] {
    const entries: GlobalLegacyEntry[] = []
    for (const name of OldWorldTeardownMigrator.GLOBAL_LEGACY_TARGETS) {
      const from = path.join(this.knowledgeRoot, name)
      const to = path.join(this.archiveRoot, "global", name)
      if (!fs.existsSync(from)) {
        entries.push({ name, from, to, files: 0, bytes: 0, action: "skip-absent" })
        continue
      }
      const files = fs.statSync(from).isDirectory() ? listFilesRel(from) : [name]
      const bytes = files.reduce((s, f) => s + fs.statSync(path.join(from, f)).size, 0)
      entries.push({ name, from, to, files: files.length, bytes, action: "archive+delete" })
    }
    return entries
  }

  private tablePresent(name: string): boolean {
    return (this.db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ? AND type IN ('table','view')",
    ).get(name) as { n: number }).n > 0
  }

  private planExperiences(): ExperiencesPlan {
    const jsonPath = path.join(this.archiveRoot, "experiences", "experiences.json")
    const csvPath = path.join(this.archiveRoot, "experiences", "experiences.csv")
    const present = this.tablePresent("experiences")
    if (!present) {
      return { present, rows: 0, ftsRows: 0, jsonPath, csvPath, action: "skip-absent" }
    }
    const rows = (this.db.prepare("SELECT COUNT(*) AS n FROM experiences").get() as { n: number }).n
    const ftsRows = this.tablePresent("experiences_fts")
      ? (this.db.prepare("SELECT COUNT(*) AS n FROM experiences_fts").get() as { n: number }).n
      : 0
    const alreadyExported = fs.existsSync(jsonPath)
    return {
      present,
      rows,
      ftsRows,
      jsonPath,
      csvPath,
      action: alreadyExported ? "drop-verified-export" : "export+drop",
    }
  }

  private memoryTables(): string[] {
    return MEMORY_DOMAIN_TABLES.filter(t => this.tablePresent(t))
  }

  private backupHint(): string {
    let dbFile = ""
    try {
      const list = this.db.pragma("database_list") as Array<{ file: string }>
      dbFile = list[0]?.file ?? ""
    } catch { /* 匿名库（内存）时无路径 */ }
    const target = dbFile || "~/.octopus/db/octopus.db"
    return `写操作前必备份（主控执行）：sqlite3 "${target}" "VACUUM INTO '${target}.pre-old-world-teardown.bak'"（目录归档可逆——删源前逐文件 hash 已验；表 drop 可逆——导出 JSON/CSV + VACUUM 备份双保险；重跑幂等）`
  }

  // ── 阶段 A：归档 + 校验 ─────────────────────────────────

  /**
   * 把 srcDir 整树复制到 dstDir；目标已存在的文件必须逐字节一致
   * （否则 ARCHIVE_CONFLICT 停手交主控）。复制后逐文件对拍复核防半写。
   */
  private copyTreeVerified(srcDir: string, dstDir: string): void {
    const rels = listFilesRel(srcDir)
    for (const rel of rels) {
      const src = path.join(srcDir, rel)
      const dst = path.join(dstDir, rel)
      if (fs.existsSync(dst)) {
        if (sha256File(dst) !== sha256File(src)) {
          throw new Error(`ARCHIVE_CONFLICT: ${dst} 与源 ${src} 内容不一致——归档区已有人工改写，停手交主控裁决（此刻零删除已发生）`)
        }
        continue // 已归档且一致 ⇒ skip-copy（幂等重跑）
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(src, dst)
    }
    for (const rel of rels) {
      if (sha256File(path.join(dstDir, rel)) !== sha256File(path.join(srcDir, rel))) {
        throw new Error(`ARCHIVE_CONFLICT: 校验复核不一致 ${path.join(dstDir, rel)}（零删除已发生，可排查重跑）`)
      }
    }
  }

  private archiveFileVerified(srcFile: string, dstFile: string): void {
    if (fs.existsSync(dstFile)) {
      if (sha256File(dstFile) !== sha256File(srcFile)) {
        throw new Error(`ARCHIVE_CONFLICT: ${dstFile} 与源 ${srcFile} 不一致（零删除已发生）`)
      }
      return
    }
    fs.mkdirSync(path.dirname(dstFile), { recursive: true })
    fs.copyFileSync(srcFile, dstFile)
    if (sha256File(dstFile) !== sha256File(srcFile)) {
      throw new Error(`ARCHIVE_CONFLICT: 校验复核不一致 ${dstFile}（零删除已发生）`)
    }
  }

  private archivePhase(
    orgDirs: OrgDirEntry[],
    globalLegacy: GlobalLegacyEntry[],
    experiences: ExperiencesPlan,
  ): void {
    for (const e of orgDirs) {
      if (e.action !== "archive+delete") continue
      this.copyTreeVerified(e.from, e.to)
    }
    for (const g of globalLegacy) {
      if (g.action !== "archive+delete") continue
      if (fs.statSync(g.from).isDirectory()) this.copyTreeVerified(g.from, g.to)
      else this.archiveFileVerified(g.from, g.to)
    }

    if (!experiences.present) return
    const cols = (this.db.prepare("PRAGMA table_info(experiences)").all() as Array<{ name: string }>).map(c => c.name)
    const rows = this.db.prepare("SELECT * FROM experiences ORDER BY id").all() as Array<Record<string, unknown>>
    if (experiences.action === "export+drop") {
      try {
        fs.mkdirSync(path.dirname(experiences.jsonPath), { recursive: true })
        fs.writeFileSync(experiences.jsonPath, JSON.stringify(rows, null, 2), "utf-8")
        const csv = [
          cols.join(","),
          ...rows.map(r => cols.map(c => csvCell(r[c])).join(",")),
        ].join("\n")
        fs.writeFileSync(experiences.csvPath, csv + "\n", "utf-8")
      } catch (err) {
        throw new Error(`EXPORT_FAILED: experiences 导出受阻（${err instanceof Error ? err.message : String(err)}）——删除阶段整体未执行`)
      }
    }

    // 导出复核（新导出或续跑复用既有导出都过此闸）：JSON 可解析且行数 = drop 前行数
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(experiences.jsonPath, "utf-8"))
    } catch {
      throw new Error(`EXPORT_FAILED: 导出文件不可读/解析（${experiences.jsonPath}）——删除阶段整体未执行`)
    }
    if (!Array.isArray(parsed) || parsed.length !== rows.length) {
      throw new Error(
        `EXPORT_FAILED: 导出行数对账不符（应 ${rows.length} 实 ${Array.isArray(parsed) ? parsed.length : "?"}）——删除阶段整体未执行`,
      )
    }
  }

  // ── 阶段 B：删除 ────────────────────────────────────────

  private deletePhase(
    orgDirs: OrgDirEntry[],
    globalLegacy: GlobalLegacyEntry[],
    experiences: ExperiencesPlan,
  ): void {
    for (const e of orgDirs) {
      if (e.action !== "archive+delete") continue
      fs.rmSync(e.from, { recursive: true, force: true })
    }
    for (const g of globalLegacy) {
      if (g.action !== "archive+delete") continue
      fs.rmSync(g.from, { recursive: true, force: true })
    }
    if (experiences.present) {
      // drop 序：FTS 先、本体后；单事务（better-sqlite3 同步事务原子）。
      this.db.transaction(() => {
        this.db.exec("DROP TABLE IF EXISTS experiences_fts")
        this.db.exec("DROP TABLE IF EXISTS experiences")
      })()
    }
  }
}
