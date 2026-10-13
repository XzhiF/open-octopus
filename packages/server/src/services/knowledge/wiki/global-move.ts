import type Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import crypto from "crypto"
import { copyDirSync } from "@octopus/shared"
import { spawnGit } from "./wiki-git"
import { hasWikiContent } from "./paths"
import { GLOBAL_WIKI_ORG, resolveGlobalKnowledgeRoot } from "../global-paths"

/**
 * wiki 全局化搬家迁移（知识中心票03，D6①④）— 单入口幂等命令，spec §迁移与幂等顺序的前两步：
 *   1. 全局搬家：orgs/<org>/knowledge/wiki（含 .git，史不断）→ knowledge/wiki/（copy→验证→删源）
 *   2. DB re-key：wiki_articles.org 全部钉 'global'（schema 不动）+ wiki_fts 重建——
 *      蓝绿表重建（tasks_v40_rebuild / experiences_fts_v2 先例），前后行数对账不丢行
 *   3. user_preference：各 org 原件复制 _archive/ 归档区（归档先于任何删除动作），
 *      现行版（preferenceSourceOrg，缺省 xzf-dev）另拷知识根人工文件区。本票不删原件。
 *
 * 幂等：重跑时旧 org wiki 不存在/空 ⇒ skip-empty；全局根已有内容 ⇒ 旧根不再读（搬家窗口
 * 语义收口），已迁移源二次运行零动作零 diff。re-key 已全 'global' 时整体跳过重建。
 * 归档目标逐字节比对同内容 ⇒ skip-identical。
 *
 * 真数据纪律（铁律）：本模块只被显式调用（POST /api/knowledge/wiki/global-move）；
 * 默认 dry-run 只读列计划，`apply=true` 才动手；apply 前主控先备份 DB——
 * 精确命令见报告 backupHint（sqlite3 "<db>" "VACUUM INTO …"）。
 * 本票范围外：写通道服务仍按 org 落行（全局写队列属后续票）；org knowledge 其余目录
 * 归档与删除属票04（_archive/org-knowledge-{date}）。
 */

export interface GlobalMoveOptions {
  db: Database.Database
  /** false（默认）= dry-run 纯只读列计划；true = 执行写操作 */
  apply?: boolean
  /** ~/.octopus/orgs 覆盖（测试注入 tmpdir fixture；缺省 os.homedir() 真路径） */
  orgsBaseDir?: string
  /** 全局知识根覆盖（缺省 resolveGlobalKnowledgeRoot()） */
  knowledgeRoot?: string
  /** 知识根现行版偏好的来源 org（缺省 "xzf-dev"，spec D6③ 现行版另拷知识根） */
  preferenceSourceOrg?: string
}

export type WikiMoveAction = "move" | "skip-empty" | "skip-conflict"

export interface WikiMoveEntry {
  org: string
  from: string
  to: string
  action: WikiMoveAction
  /** 旧根 git 全量 commit 数（无 .git 为 0）——干跑即报，搬后必须仍等于此数 */
  commits: number
  reason?: string
}

export type PreferenceArchiveAction = "copy" | "skip-identical"
export type PreferenceRootAction = "none" | "copy-to-root" | "skip-identical-root" | "keep-existing-root"

export interface PreferenceEntry {
  org: string
  source: string
  /** _archive/user_preference/{org}.md（本票只归档偏好原件；org knowledge 全量归档属票04） */
  archivePath: string
  archiveAction: PreferenceArchiveAction
  rootAction: PreferenceRootAction
}

export interface RekeyReport {
  beforeTotal: number
  beforeByOrg: Record<string, number>
  /** 按 id 去重后的应存行数（跨 org 同 id 合并取 updated_at 最新） */
  projectedTotal: number
  /** beforeTotal - projectedTotal：被合并的同 id 行数（真实数据应为 0） */
  collisions: number
  applied: boolean
  afterTotal?: number
  afterByOrg?: Record<string, number>
  reason?: string
}

export interface GlobalMoveReport {
  dryRun: boolean
  wikiMoves: WikiMoveEntry[]
  rekey: RekeyReport
  preferences: PreferenceEntry[]
  backupHint: string
}

function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

/** 真源 wiki_articles DDL 复刻（schema 不动铁律：列/默认/PK 与 schema.sql L1066 逐字一致）。 */
const WIKI_ARTICLES_REBUILD_DDL = `
CREATE TABLE wiki_articles_rekey (
  org TEXT NOT NULL,
  id TEXT NOT NULL,
  domain TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  topics TEXT NOT NULL DEFAULT '[]',
  stability TEXT NOT NULL DEFAULT 'stable',
  last_compiled TEXT NOT NULL DEFAULT '',
  sources TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  body TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org, id)
)`

/** wiki_fts 复刻（external-content-less，列序与 schema.sql 一致；rowid 手工对齐纪律不变）。 */
const WIKI_FTS_REBUILD_DDL = `
CREATE VIRTUAL TABLE wiki_fts_rekey USING fts5(
  id UNINDEXED,
  domain UNINDEXED,
  title,
  summary,
  topics,
  body
)`

export class WikiGlobalMigrator {
  private readonly apply: boolean
  private readonly orgsBase: string
  private readonly knowledgeRoot: string
  private readonly globalWiki: string
  private readonly preferenceSourceOrg: string
  private readonly db: Database.Database

  constructor(opts: GlobalMoveOptions) {
    this.db = opts.db
    this.apply = opts.apply ?? false
    const base = opts.orgsBaseDir ?? path.join(os.homedir(), ".octopus", "orgs")
    this.orgsBase = base
    this.knowledgeRoot = opts.knowledgeRoot ?? resolveGlobalKnowledgeRoot()
    this.globalWiki = path.join(this.knowledgeRoot, "wiki")
    this.preferenceSourceOrg = opts.preferenceSourceOrg ?? "xzf-dev"
  }

  async run(): Promise<GlobalMoveReport> {
    const report: GlobalMoveReport = {
      dryRun: !this.apply,
      wikiMoves: this.planWikiMoves(),
      rekey: this.planRekey(),
      preferences: this.planPreferences(),
      backupHint: this.backupHint(),
    }
    if (!this.apply) return report

    // 执行序 = spec §迁移与幂等：全局搬家 → DB re-key → 偏好归档/迁入
    this.executeWikiMoves(report.wikiMoves)
    this.executeRekey(report.rekey)
    this.executePreferences(report.preferences)
    return report
  }

  /** 真跑前置备份提示（由主控执行；better-sqlite3 无 VACUUM INTO 包装，给精确命令）。 */
  private backupHint(): string {
    let dbFile = ""
    try {
      const list = this.db.pragma("database_list") as Array<{ file: string }>
      dbFile = list[0]?.file ?? ""
    } catch { /* 匿名库（内存）时无路径 */ }
    const target = dbFile || "~/.octopus/db/octopus.db"
    return `写操作前必备份（主控执行）：sqlite3 "${target}" "VACUUM INTO '${target}.pre-global-move.bak'"（wiki 搬家与 re-key 各自 git/备份可回滚）`
  }

  private listOrgs(): string[] {
    try {
      return fs
        .readdirSync(this.orgsBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort()
    } catch {
      return [] // orgs 根不存在（测试半边 fixture / 新机）⇒ 无可迁对象
    }
  }

  // ── 1. wiki 搬家 ────────────────────────────────────────────

  /** 全局 git commit hash 集合（史连续断言的独立测量口径；无 .git ⇒ []）。 */
  private commitHashes(root: string): string[] {
    if (!fs.existsSync(path.join(root, ".git"))) return []
    const r = spawnGit(root).run(["rev-list", "--all"])
    if (r.status !== 0) return []
    return r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).sort()
  }

  private planWikiMoves(): WikiMoveEntry[] {
    const globalHasContent = hasWikiContent(this.globalWiki)
    const moves: WikiMoveEntry[] = []
    for (const org of this.listOrgs()) {
      const from = path.join(this.orgsBase, org, "knowledge", "wiki")
      if (!hasWikiContent(from)) {
        moves.push({ org, from, to: this.globalWiki, action: "skip-empty", commits: 0 })
        continue
      }
      const commits = this.commitHashes(from).length
      if (globalHasContent) {
        // 全局根已有内容：绝不覆盖合并（双非空 = 异常态，交主控裁决；真实数据不出现）
        moves.push({ org, from, to: this.globalWiki, action: "skip-conflict", commits, reason: "全局 wiki 根已有内容，旧 org wiki 不覆盖不合并" })
        continue
      }
      moves.push({ org, from, to: this.globalWiki, action: "move", commits })
    }
    return moves
  }

  private executeWikiMoves(moves: WikiMoveEntry[]): void {
    for (const m of moves) {
      if (m.action !== "move") continue
      const hashesBefore = this.commitHashes(m.from)
      copyDirSync(m.from, m.to) // copyDirSync（非 fs.cpSync）：非 ASCII 路径下 cpSync 会 abort 进程（org.ts L55 先例）
      const hashesAfter = this.commitHashes(m.to)
      if (hashesBefore.length !== m.commits || hashesAfter.join("\n") !== hashesBefore.join("\n")) {
        throw new Error(
          `MOVE_VERIFY_FAILED: ${m.org} wiki 搬家后 git 史不一致（迁前 ${hashesBefore.length} commits，迁后 ${hashesAfter.length} commits）——旧源目录未删，可排查后重跑`,
        )
      }
      // 验证通过才删源（搬 = 复制+校验+删源；真数据回滚 = 备份 + git 库已在目标可逆）
      fs.rmSync(m.from, { recursive: true, force: true })
    }
  }

  // ── 2. DB re-key（蓝绿重建）────────────────────────────────

  private countByOrg(): Record<string, number> {
    const rows = this.db.prepare("SELECT org, COUNT(*) AS n FROM wiki_articles GROUP BY org").all() as Array<{ org: string; n: number }>
    return Object.fromEntries(rows.map(r => [r.org, r.n]))
  }

  private planRekey(): RekeyReport {
    const beforeByOrg = this.countByOrg()
    const beforeTotal = Object.values(beforeByOrg).reduce((s, n) => s + n, 0)
    const uniqueIds = (this.db.prepare("SELECT COUNT(DISTINCT id) AS n FROM wiki_articles").get() as { n: number }).n
    const onlyGlobal = beforeTotal > 0 && Object.keys(beforeByOrg).length === 1 && beforeByOrg[GLOBAL_WIKI_ORG] === beforeTotal
    return {
      beforeTotal,
      beforeByOrg,
      projectedTotal: uniqueIds,
      collisions: beforeTotal - uniqueIds,
      applied: false,
      reason: onlyGlobal ? "全部行已钉 global，跳过重建" : undefined,
    }
  }

  private executeRekey(rekey: RekeyReport): void {
    if (rekey.beforeTotal === 0) {
      rekey.applied = false
      rekey.afterTotal = 0
      rekey.afterByOrg = {}
      if (!rekey.reason) rekey.reason = "wiki_articles 为空，无需 re-key"
      return
    }
    if (rekey.reason === "全部行已钉 global，跳过重建") {
      rekey.applied = false
      rekey.afterTotal = rekey.beforeTotal
      rekey.afterByOrg = rekey.beforeByOrg
      return
    }

    // 蓝绿：建表 → 灌数（org 钉 global，跨 org 同 id 取 updated_at 最新者，平局 org 名序小者胜）
    // → drop+rename → 索引/FTS 重建（wiki_fts rowid 与新表手工对齐）。单事务，失败整体回滚。
    this.db.transaction(() => {
      this.db.exec("DROP TABLE IF EXISTS wiki_articles_rekey")
      this.db.exec(WIKI_ARTICLES_REBUILD_DDL)
      this.db.exec(`
        INSERT INTO wiki_articles_rekey (org, id, domain, title, summary, topics, stability, last_compiled, sources, confidence, body, path, updated_at)
        SELECT '${GLOBAL_WIKI_ORG}', a.id, a.domain, a.title, a.summary, a.topics, a.stability, a.last_compiled, a.sources, a.confidence, a.body, a.path, a.updated_at
        FROM wiki_articles a
        WHERE NOT EXISTS (
          SELECT 1 FROM wiki_articles b
          WHERE b.id = a.id AND (b.updated_at > a.updated_at OR (b.updated_at = a.updated_at AND b.org < a.org))
        )
      `)
      this.db.exec("DROP TABLE wiki_articles")
      this.db.exec("ALTER TABLE wiki_articles_rekey RENAME TO wiki_articles")
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_wiki_articles_org_domain ON wiki_articles(org, domain)")

      this.db.exec("DROP TABLE IF EXISTS wiki_fts_rekey")
      this.db.exec(WIKI_FTS_REBUILD_DDL)
      this.db.exec(`
        INSERT INTO wiki_fts_rekey (rowid, id, domain, title, summary, topics, body)
        SELECT rowid, id, domain, title, summary, topics, body FROM wiki_articles
      `)
      this.db.exec("DROP TABLE wiki_fts")
      this.db.exec("ALTER TABLE wiki_fts_rekey RENAME TO wiki_fts")
    })()

    rekey.applied = true
    rekey.afterTotal = (this.db.prepare("SELECT COUNT(*) AS n FROM wiki_articles").get() as { n: number }).n
    rekey.afterByOrg = this.countByOrg()
    if (rekey.afterTotal !== rekey.projectedTotal) {
      throw new Error(`REKEY_VERIFY_FAILED: 行数对账不符（应 ${rekey.projectedTotal} 实 ${rekey.afterTotal}）`)
    }
  }

  // ── 3. user_preference 归档 + 知识根迁入 ────────────────────

  private prefSourceOf(org: string): string {
    return path.join(this.orgsBase, org, "knowledge", "user_preference.md")
  }

  private archivePathOf(org: string): string {
    return path.join(this.knowledgeRoot, "_archive", "user_preference", `${org}.md`)
  }

  private planPreferences(): PreferenceEntry[] {
    const globalPref = path.join(this.knowledgeRoot, "user_preference.md")
    const orgs = this.listOrgs().filter(o => fs.existsSync(this.prefSourceOf(o)))
    const chosen = orgs.includes(this.preferenceSourceOrg) ? this.preferenceSourceOrg : (orgs[0] ?? null)
    const entries: PreferenceEntry[] = []
    for (const org of orgs) {
      const source = this.prefSourceOf(org)
      const archivePath = this.archivePathOf(org)
      const archiveAction: PreferenceArchiveAction =
        fs.existsSync(archivePath) && sha256File(archivePath) === sha256File(source) ? "skip-identical" : "copy"
      let rootAction: PreferenceRootAction = "none"
      if (org === chosen) {
        if (!fs.existsSync(globalPref)) rootAction = "copy-to-root"
        else if (sha256File(globalPref) === sha256File(source)) rootAction = "skip-identical-root"
        else rootAction = "keep-existing-root" // 人工文件区已有现行版：程序永不改写（D6③ 写保护继承）
      }
      entries.push({ org, source, archivePath, archiveAction, rootAction })
    }
    return entries
  }

  private executePreferences(prefs: PreferenceEntry[]): void {
    for (const p of prefs) {
      // 归档先于任何后续动作（红线）；原件本票不删
      if (p.archiveAction === "copy") {
        fs.mkdirSync(path.dirname(p.archivePath), { recursive: true })
        fs.copyFileSync(p.source, p.archivePath)
      }
      if (p.rootAction === "copy-to-root") {
        fs.mkdirSync(this.knowledgeRoot, { recursive: true })
        fs.copyFileSync(p.source, path.join(this.knowledgeRoot, "user_preference.md"))
      }
    }
  }
}
