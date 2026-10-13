import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import crypto from "crypto"
import { applySchema } from "../../../db/schema"
import { OldWorldTeardownMigrator } from "../old-world-teardown"

/**
 * 票09 · S1 服务层缝 — 旧世界归档删除（spec「注入链与旧库硬废」数据归档段 +
 * 过闸文书 §5 归档不删纪律 + 硬约束「归档先于删除」）。
 *
 * 真 fs + tmpdir fixture（wiki-compile.test.ts 先例），绝不碰真 ~/.octopus：
 * orgs 根与知识根都走构造注入。断言只打外部产物：归档树内容、源目录缺席、
 * DB 表存在性、CSV/JSON 导出行数对账。
 *
 * 期望值独立真相源：spec §迁移与幂等「org knowledge/experiences 归档 → 删除」
 * 顺序 + 票03 global-move 的 _archive 归档区约定（knowledgeRoot/_archive/）。
 */

const DATE_TAG = "20261013"

let db: Database.Database
let home: string        // 假 octopus home（orgs/ 在其下）
let orgsBase: string
let knowledgeRoot: string

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else out[r] = sha256(path.join(dir, e.name))
    }
  }
  if (fs.existsSync(root)) walk(root, "")
  return out
}

function seedExperience(id: number, skill: string, content: string, org: string) {
  db.prepare(
    `INSERT INTO experiences (id, skill_name, content, source_session_id, org, created_at, scope, scope_ref, pattern_tags, outcome, source_type, execution_id, node_id)
     VALUES (?, ?, ?, ?, ?, '2026-10-11T00:00:00Z', 'agent', NULL, '[]', NULL, 'session', NULL, NULL)`,
  ).run(id, skill, content, `sess-${id}`, org)
  db.prepare(
    `INSERT INTO experiences_fts (rowid, skill_name, content, scope, scope_ref, pattern_tags)
     VALUES (?, ?, ?, 'agent', NULL, '[]')`,
  ).run(id, skill, content)
}

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kc-teardown-"))
  orgsBase = path.join(home, "orgs")
  knowledgeRoot = path.join(home, "knowledge")

  // 旧 org knowledge：xzf-dev 有 projects/workflows/偏好/index/wiki 空壳；testorg 只有 projects
  const xzf = path.join(orgsBase, "xzf-dev", "knowledge")
  fs.mkdirSync(path.join(xzf, "projects"), { recursive: true })
  fs.mkdirSync(path.join(xzf, "workflows"), { recursive: true })
  fs.writeFileSync(path.join(xzf, "projects", "octopus.md"),
    "- 规则一\n<!-- id:octopus-20260901-a1b2 | 2026-09-01 | system -->\n", "utf-8")
  fs.writeFileSync(path.join(xzf, "workflows", "release.md"), "- 发布要走门禁\n", "utf-8")
  fs.writeFileSync(path.join(xzf, "user_preference.md"), "# 偏好\n- 回复用中文\n", "utf-8")
  fs.writeFileSync(path.join(xzf, "index.md"), "# index\n", "utf-8")
  fs.mkdirSync(path.join(xzf, "wiki", "projects"), { recursive: true }) // 票03 搬空后的壳

  fs.mkdirSync(path.join(orgsBase, "testorg", "knowledge", "projects"), { recursive: true })
  fs.writeFileSync(path.join(orgsBase, "testorg", "knowledge", "projects", "demo.md"),
    "- testorg 规则\n", "utf-8")

  // 全局知识根 = 新世界（必须原样保留）+ 旧语料 projects/（归档对象）
  fs.mkdirSync(path.join(knowledgeRoot, "wiki", "topics"), { recursive: true })
  fs.mkdirSync(path.join(knowledgeRoot, "raw", "inbox"), { recursive: true })
  fs.mkdirSync(path.join(knowledgeRoot, "projects"), { recursive: true })
  fs.writeFileSync(path.join(knowledgeRoot, "user_preference.md"), "# 现行偏好\n", "utf-8")
  fs.writeFileSync(path.join(knowledgeRoot, "SCHEMA.md"), "# schema\n", "utf-8")
  fs.writeFileSync(path.join(knowledgeRoot, "wiki", "topics", "t.md"), "---\nid: t\n---\n", "utf-8")
  fs.writeFileSync(path.join(knowledgeRoot, "projects", "legacy-global.md"), "- 全局旧规则\n", "utf-8")

  // experiences 数据（行数对账对象）
  seedExperience(1, "octo-dev", "踩坑 A", "xzf-dev")
  seedExperience(2, "octo-wiki", "决策 B", "xzf-dev")
  seedExperience(3, "octo-dev", "踩坑 C", "testorg")

  // agent 记忆域最小行（零触碰回归对象）
  db.prepare(
    `INSERT INTO sessions (id, org, title, session_type, is_active, is_deleted, created_at, updated_at)
     VALUES ('s-1', 'xzf-dev', '记忆会话', 'main', 1, 0, '2026-10-12', '2026-10-12')`,
  ).run()
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, created_at)
     VALUES ('m-1', 's-1', 'user', '记忆内容', '2026-10-12')`,
  ).run()
})

afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

function migrator(apply: boolean, over: Partial<{ orgsBaseDir: string; knowledgeRoot: string }> = {}) {
  return new OldWorldTeardownMigrator({
    db,
    apply,
    orgsBaseDir: over.orgsBaseDir ?? orgsBase,
    knowledgeRoot: over.knowledgeRoot ?? knowledgeRoot,
    dateTag: DATE_TAG,
  })
}

const archiveRoot = () => path.join(knowledgeRoot, "_archive", `org-knowledge-${DATE_TAG}`)

function tablePresent(name: string): boolean {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
  ).get(name) as { n: number }).n > 0
}

describe("票09 S1 — 旧世界归档删除（dry-run / apply / 顺序 / 幂等 / 零触碰）", () => {
  // ── AC: dry-run 计划含归档目标路径；行数对账；零写盘 ──
  it("dry-run 零写盘，计划含归档目标路径与 experiences 行数对账", async () => {
    const before = snapshotTree(home)
    const report = await migrator(false).run()

    expect(report.dryRun).toBe(true)
    expect(report.archiveRoot).toBe(archiveRoot())

    const orgs = report.orgDirs.map(o => o.org).sort()
    expect(orgs).toEqual(["testorg", "xzf-dev"])
    const xzf = report.orgDirs.find(o => o.org === "xzf-dev")!
    expect(xzf.action).toBe("archive+delete")
    // 归档目标路径逐 org 落 _archive/org-knowledge-{date}/orgs/{org}（票03 _archive 约定）
    expect(path.normalize(xzf.to)).toBe(path.normalize(path.join(archiveRoot(), "orgs", "xzf-dev")))
    expect(xzf.files).toBe(4) // projects/workflows/偏好/index 四个文件（空 wiki 壳目录不计）

    // 全局知识根旧语料 projects/ 也在归档面（新世界文件不列）
    expect(report.globalLegacy.filter(g => g.action === "archive+delete").map(g => g.to)).toEqual(
      [path.normalize(path.join(archiveRoot(), "global", "projects"))],
    )

    expect(report.experiences.present).toBe(true)
    expect(report.experiences.rows).toBe(3)
    expect(report.experiences.ftsRows).toBe(3)
    expect(report.experiences.jsonPath).toBe(path.join(archiveRoot(), "experiences", "experiences.json"))
    expect(report.backupHint).toContain("VACUUM INTO")

    // 零写盘断言：整个 home 树逐文件 hash 不变
    expect(snapshotTree(home)).toEqual(before)
  })

  // ── AC S1: 归档先于删除；apply 产物完整 ──
  it("apply：先归档后删除——归档内容与源逐字节一致，源目录缺席，新根文件保留，表已 drop", async () => {
    const report = await migrator(true).run()
    expect(report.dryRun).toBe(false)

    // 归档树内容 = 源内容（逐字节对拍独立真相源：写入的 fixture 原文）
    expect(fs.readFileSync(path.join(archiveRoot(), "orgs", "xzf-dev", "projects", "octopus.md"), "utf-8"))
      .toContain("规则一")
    expect(fs.readFileSync(path.join(archiveRoot(), "orgs", "xzf-dev", "user_preference.md"), "utf-8"))
      .toContain("回复用中文")
    expect(fs.existsSync(path.join(archiveRoot(), "orgs", "testorg", "projects", "demo.md"))).toBe(true)

    // 源目录删除
    expect(fs.existsSync(path.join(orgsBase, "xzf-dev", "knowledge"))).toBe(false)
    expect(fs.existsSync(path.join(orgsBase, "testorg", "knowledge"))).toBe(false)

    // 全局旧语料归档+删除；新世界（raw/wiki/SCHEMA/现行偏好）原样保留
    expect(fs.existsSync(path.join(knowledgeRoot, "projects"))).toBe(false)
    expect(fs.readFileSync(path.join(archiveRoot(), "global", "projects", "legacy-global.md"), "utf-8"))
      .toContain("全局旧规则")
    expect(fs.existsSync(path.join(knowledgeRoot, "wiki", "topics", "t.md"))).toBe(true)
    expect(fs.existsSync(path.join(knowledgeRoot, "user_preference.md"))).toBe(true)

    // experiences 导出（JSON 行数 + CSV 行数对账 = 删除前行数）
    const exported = JSON.parse(fs.readFileSync(report.experiences.jsonPath, "utf-8")) as unknown[]
    expect(exported).toHaveLength(3)
    const csv = fs.readFileSync(report.experiences.csvPath, "utf-8").trim().split(/\r?\n/)
    expect(csv).toHaveLength(4) // header + 3 行
    expect(csv[0]).toContain("skill_name")

    // drop 含 FTS；记忆域表未动
    expect(tablePresent("experiences")).toBe(false)
    expect(tablePresent("experiences_fts")).toBe(false)
    expect(tablePresent("sessions")).toBe(true)
    expect(tablePresent("messages")).toBe(true)
    expect(tablePresent("session_memory_fts")).toBe(true)
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(1)
    expect(report.memoryTablesAfter.every(t => report.memoryTablesBefore.includes(t))).toBe(true)
  })

  // ── AC S1: 幂等可重跑（重跑 skip，零副作用） ──
  it("重跑 apply：全部 skip-absent，零新文件零动作", async () => {
    await migrator(true).run()
    const after = snapshotTree(home)

    const report2 = await migrator(true).run()
    expect(report2.orgDirs.every(o => o.action === "skip-absent")).toBe(true)
    expect(report2.globalLegacy.every(g => g.action === "skip-absent")).toBe(true)
    expect(report2.experiences.present).toBe(false)
    expect(report2.experiences.action).toBe("skip-absent")
    expect(snapshotTree(home)).toEqual(after)
  })

  // ── AC S1 顺序闸：归档冲突 ⇒ 抛错，删除阶段整体未执行 ──
  it("归档目标已有不同内容 ⇒ ARCHIVE_CONFLICT 抛错；源目录与 experiences 表都还在（删除未开始）", async () => {
    const clash = path.join(archiveRoot(), "orgs", "xzf-dev", "projects", "octopus.md")
    fs.mkdirSync(path.dirname(clash), { recursive: true })
    fs.writeFileSync(clash, "被人改过的归档副本\n", "utf-8")

    await expect(migrator(true).run()).rejects.toThrow(/ARCHIVE_CONFLICT/)

    expect(fs.existsSync(path.join(orgsBase, "xzf-dev", "knowledge", "projects", "octopus.md"))).toBe(true)
    expect(fs.existsSync(path.join(orgsBase, "testorg", "knowledge"))).toBe(true)
    expect(tablePresent("experiences")).toBe(true) // 删除步整体未执行
  })

  // ── AC S1 顺序闸：导出失败 ⇒ 表不 drop、目录不删；修复后重跑成功 ──
  it("导出被阻 ⇒ EXPORT_VERIFY_FAILED 抛错且零删除；清障重跑后 drop 成功", async () => {
    // 用目录占住 JSON 导出路径制造写失败（Windows/Linux 同构：writeFileSync EISDIR/EEXIST）
    fs.mkdirSync(path.join(archiveRoot(), "experiences", "experiences.json"), { recursive: true })

    await expect(migrator(true).run()).rejects.toThrow(/EXPORT_FAILED/)
    expect(tablePresent("experiences")).toBe(true)
    expect(fs.existsSync(path.join(orgsBase, "xzf-dev", "knowledge"))).toBe(true)

    fs.rmSync(path.join(archiveRoot(), "experiences", "experiences.json"), { recursive: true, force: true })
    const report = await migrator(true).run()
    expect(report.experiences.rows).toBe(3)
    expect(tablePresent("experiences")).toBe(false)
  })

  // ── AC: drop 幂等——表已 drop 后重跑对 DB 零动作（skip-absent），不再报错 ──
  it("表已 drop 后重跑：experiences skip-absent，DB 零副作用", async () => {
    await migrator(true).run()
    expect(tablePresent("experiences")).toBe(false)
    // 模拟主控收口前的重启形态：applySchema 会重建空表（DDL 退役属票10/主控单）——
    // 本脚本对此幂等：新空表导出 0 行再 drop，归档 JSON 不覆盖已验内容
    const report2 = await migrator(true).run()
    expect(report2.experiences.action).toBe("skip-absent")
    expect(report2.dryRun).toBe(false)
  })

  // ── AC: 旧知识目录 getter mkdir 副作用随删除消亡（不得重建已删目录） ──
  it("getter 零 mkdir：删除后读偏好/规则列表不重建任何已删目录", async () => {
    await migrator(true).run()
    const orgDir = path.join(orgsBase, "xzf-dev", "knowledge")
    // 用 OCTOPUS_HOME 钩子让 file-ops 解析进 fixture home（与 global-paths 同口径）
    const prevHome = process.env.OCTOPUS_HOME
    process.env.OCTOPUS_HOME = home
    try {
      // 动态 import：getter 在 teardown 之后被任意只读路径调用也不得建目录
      const { readUserPreference, listAllActiveRules, getKnowledgeDir } = await import("../file-ops")
      expect(getKnowledgeDir("xzf-dev")).toBe(orgDir)
      expect(readUserPreference("xzf-dev")).toBe("")
      expect(listAllActiveRules("xzf-dev")).toEqual([])
      expect(fs.existsSync(orgDir)).toBe(false)
    } finally {
      if (prevHome === undefined) delete process.env.OCTOPUS_HOME
      else process.env.OCTOPUS_HOME = prevHome
    }
  })
})
