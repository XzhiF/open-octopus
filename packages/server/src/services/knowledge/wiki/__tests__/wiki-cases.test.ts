import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../../db/schema"
import { WikiCompileService, type GitRunner } from "../compile"
import { spawnGit } from "../wiki-git"
import { ensureWikiSkeleton } from "../paths"

/**
 * 票04 · S1 缝（spec §Testing Decisions 行 120「cases 判例域」）：判例入库环级测试。
 * 真 fs tmpdir + in-memory DB + 真 git（wiki-compile.test.ts 同款 harness）。
 * fixture 与 expected 逐字来自 prototype.md Tab③ lines 514-528（独立真相源，禁 Tautological）。
 */

const CASE_LOCKFILE = `---
id: case-2026-003
symptom: CI 报 LOCKFILE_CONFIG_MISMATCH
tags: [ci, pnpm, lockfile]
severity: blocker
occurrences: 2
rule_ref: oct-013
source: task-207 / exec-9f31
status: distilled
---
## 现场  pnpm 9 的 CI 读 v10 lockfile…
## 诊断  overrides 住在 pnpm-workspace.yaml…
## 根因  lockfile 格式版本与 CLI 版本错配
## 修复  CI 升 pnpm 10（commit 82d96372）
## 教训  工具链大版本升级先查配置文件归属变化
`

const CASE_ACTUATOR = `---
id: case-2026-004
symptom: 恢复状态误判 stale
tags: [actuator, stale]
severity: major
occurrences: 1
rule_ref: oct-008
source: exec-7b12
status: distilled
---
## 现场  doctor 把仍在跑的执行报成 stale…
## 诊断  检测读了 started_at…
## 根因  长任务 started_at 不更新
## 修复  改用 updated_at
## 教训  时间戳字段要选“最后活动”而非“开始”
`

/** 案例正文天然带日期（事件绑定）——entries 会触 L5，cases 豁免（票02 seam）。 */
const CASE_DATED_BODY = `---
id: case-2026-005
symptom: Git Bash ref 冒号被转成路径
tags: [windows, gitbash]
severity: minor
occurrences: 1
source: task-199
status: open
---
## 现场  2026-09-05 那天 ref 'a:b' 变成了目录 a/b
## 诊断  MSYS 路径转换吃冒号
## 根因  双斜杠规则未覆盖盘符后冒号
## 修复  用 MSYS_NO_PATHCONV=1 前缀
## 教训  Windows 下冒号是保留字符
`

/** 超 120 行的判例——entries 触 L1 容量闸，cases 豁免。 */
const LONG_CASE = `---
id: case-2026-006
symptom: 巨型判例容量豁免
tags: [lint]
severity: minor
occurrences: 1
source: exec-1
status: open
---
## 现场  ${"字".repeat(130)}
## 诊断  x
## 根因  x
## 修复  x
## 教训  x
`

function caseEntry(fileName: string) {
  return { content: CASE_LOCKFILE, fileName }
}

// 票06 合并适配：服务写通道提交须走 spawnGit（自动携带 OCTOPUS_WIKI_COMMIT_SOURCE=curate
// 标记，与生产 WikiCompileService 默认 this.git 同一通道）；裸 spawnSync 会被 pre-commit 闸门拒。
const realGit = (cwd: string): GitRunner => spawnGit(cwd)

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

describe("cases domain — compile (ticket 04, S1)", () => {
  let db: Database.Database
  let tmpDir: string
  let root: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-cases-"))
    root = path.join(tmpDir, "wiki")
    ensureWikiSkeleton(root)
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeService() {
    return new WikiCompileService({ db, org: "testorg", rootDir: root, git: realGit(root) })
  }

  it("compiles a prototype case: file on disk verbatim + DB row + LOG case+ + git commit", async () => {
    const svc = makeService()
    const res = await svc.compileEntry({ ...caseEntry("2026-06-23-pnpm-lockfile-mismatch.md"), source: "exec-9f31", reviewer: "xzf" })

    expect(res.id).toBe("case-2026-003")
    expect(res.domain).toBe("cases")
    expect(res.path).toBe("cases/2026-06-23-pnpm-lockfile-mismatch.md")

    // 文件落盘：front-matter 逐字段可回读（id/symptom/tags/severity/occurrences/rule_ref/source/status）
    const written = fs.readFileSync(path.join(root, "cases", "2026-06-23-pnpm-lockfile-mismatch.md"), "utf-8")
    expect(written).toContain("id: case-2026-003")
    expect(written).toContain("symptom: CI 报 LOCKFILE_CONFIG_MISMATCH")
    expect(written).toContain("severity: blocker")
    expect(written).toContain("rule_ref: oct-013")
    expect(written).toContain("status: distilled")
    expect(written).toContain("## 教训")

    // DB 行：title/summary = symptom（检索加权面），topics = tags，domain = cases
    const row = db.prepare("SELECT * FROM wiki_articles WHERE org='testorg' AND id='case-2026-003'").get() as Record<string, unknown>
    expect(row.domain).toBe("cases")
    expect(row.title).toBe("CI 报 LOCKFILE_CONFIG_MISMATCH")
    expect(JSON.parse(row.topics as string)).toEqual(["ci", "pnpm", "lockfile"])

    // LOG：票04 v3 行格式——判例入库 op=compile（五操作集内），结果注记带次数与溯源
    const log = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    expect(log).toContain(`## [${today()}] compile | cases/2026-06-23-pnpm-lockfile-mismatch.md`)
    expect(log).toContain("  → 新案例 ×2 次命中 · exec-9f31 · xzf ✓")
  })

  it("INDEX.md cases section: one line per case (prototype v3 裸行：路径 — 症状摘要)", async () => {
    const svc = makeService()
    await svc.compileEntry(caseEntry("2026-06-23-pnpm-lockfile-mismatch.md"))
    await svc.compileEntry({ content: CASE_ACTUATOR, fileName: "2026-07-02-actuator-stale-detect.md" })

    const index = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    // 五类分组节头（prototype Tab②：`## Cases (N)`）；判例行式 `- {relPath} — {症状}`（tags/蒸馏指针不再占行，检索面走 DB）
    expect(index).toContain("## Cases (2)")
    expect(index).toContain("- cases/2026-06-23-pnpm-lockfile-mismatch.md — CI 报 LOCKFILE_CONFIG_MISMATCH")
    expect(index).toContain("- cases/2026-07-02-actuator-stale-detect.md — 恢复状态误判 stale")
    expect(index).not.toContain("待审核")
  })

  it("open case renders a plain one-line entry", async () => {
    const svc = makeService()
    await svc.compileEntry({ content: CASE_DATED_BODY, fileName: "2026-09-05-msys-colon-pathconv.md" })
    const index = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    expect(index).toContain("- cases/2026-09-05-msys-colon-pathconv.md — Git Bash ref 冒号被转成路径")
  })

  it("rejects a case without a locatable source pointer (真实+可定位，豁免半衰期≠豁免溯源)", async () => {
    const svc = makeService()
    const bad = CASE_LOCKFILE.replace("source: task-207 / exec-9f31", "source: 听说的")
    await expect(svc.compileEntry({ content: bad, fileName: "2026-06-23-x.md" })).rejects.toThrow(/SOURCE_UNLOCATABLE/)
    expect(fs.existsSync(path.join(root, "cases", "2026-06-23-x.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, "LOG.md"))).toBe(false)
  })

  it("rejects a case missing the five-section body", async () => {
    const svc = makeService()
    const bad = CASE_LOCKFILE.replace("## 教训  工具链大版本升级先查配置文件归属变化\n", "")
    await expect(svc.compileEntry({ content: bad, fileName: "2026-06-23-y.md" })).rejects.toThrow(/SECTIONS/)
  })

  it("cases are EXEMPT from lint L1 capacity + body-dates (票02 seam lintProfileForDomain)", async () => {
    const svc = makeService()
    // 正文含日期 + 超 120 行：entries 会 L1/L5 拒写，cases 放行
    const r1 = await svc.compileEntry({ content: CASE_DATED_BODY, fileName: "2026-09-05-msys-colon-pathconv.md" })
    expect(r1.path).toBe("cases/2026-09-05-msys-colon-pathconv.md")
    const r2 = await svc.compileEntry({ content: LONG_CASE, fileName: "2026-10-01-long-case.md" })
    expect(r2.changed).toBe(true)
    // 但断链仍不豁免（L5_LINK_BROKEN 与容量/日期无关）
    const broken = CASE_LOCKFILE.replace("## 教训  工具链大版本升级先查配置文件归属变化", "## 教训  见 [[nonexistent-target]]")
    await expect(svc.compileEntry({ content: broken, fileName: "2026-06-23-broken.md" })).rejects.toThrow(/L5_LINK_BROKEN/)
  })

  it("rejects a case file name without the {YYYY-MM-DD}-{slug} date prefix", async () => {
    const svc = makeService()
    await expect(svc.compileEntry({ content: CASE_LOCKFILE, fileName: "pnpm-lockfile-mismatch.md" })).rejects.toThrow(/CASE_FILENAME/)
  })

  it("append-only: body rewrite rejected AFTER ingest, LOG gains a 拒写 evidence line, file untouched", async () => {
    const svc = makeService()
    await svc.compileEntry(caseEntry("2026-06-23-pnpm-lockfile-mismatch.md"))
    const bytesBefore = fs.readFileSync(path.join(root, "cases", "2026-06-23-pnpm-lockfile-mismatch.md"), "utf-8")
    const logBefore = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")

    const tampered = CASE_LOCKFILE.replace("## 根因  lockfile 格式版本与 CLI 版本错配", "## 根因  是别的原因（篡改）")
    await expect(svc.compileEntry({ content: tampered, fileName: "2026-06-23-pnpm-lockfile-mismatch.md" })).rejects.toThrow(/CASE_APPEND_ONLY/)

    // 文件字节级不动；LOG.md 多一行拒写证据（改写尝试被拒并留 LOG；op=compile 五操作集内）
    expect(fs.readFileSync(path.join(root, "cases", "2026-06-23-pnpm-lockfile-mismatch.md"), "utf-8")).toBe(bytesBefore)
    const log = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    expect(log.startsWith(logBefore)).toBe(true)
    expect(log).toContain(`## [${today()}] compile | cases/2026-06-23-pnpm-lockfile-mismatch.md`)
    expect(log).toContain("正文改写被拒（append-only 判例即历史）")
    // DB 行仍只有入库那一条
    expect((db.prepare("SELECT COUNT(*) AS n FROM wiki_articles WHERE org='testorg'").get() as { n: number }).n).toBe(1)
  })

  it("append-only: fixed fields (symptom/tags/severity/source) are also immutable", async () => {
    const svc = makeService()
    await svc.compileEntry(caseEntry("2026-06-23-pnpm-lockfile-mismatch.md"))
    const tampered = CASE_LOCKFILE.replace("symptom: CI 报 LOCKFILE_CONFIG_MISMATCH", "symptom: 改了症状")
    await expect(svc.compileEntry({ content: tampered, fileName: "2026-06-23-pnpm-lockfile-mismatch.md" })).rejects.toThrow(/CASE_APPEND_ONLY/)
  })

  it("append-only: ONLY status/rule_ref/occurrences may update through the compile channel", async () => {
    const svc = makeService()
    await svc.compileEntry(caseEntry("2026-06-23-pnpm-lockfile-mismatch.md"))

    const open = CASE_LOCKFILE
      .replace("occurrences: 2", "occurrences: 3")
      .replace("rule_ref: oct-013\n", "")
      .replace("status: distilled", "status: open")
    const res = await svc.compileEntry({ content: open, fileName: "2026-06-23-pnpm-lockfile-mismatch.md" })
    expect(res.changed).toBe(true)

    const written = fs.readFileSync(path.join(root, "cases", "2026-06-23-pnpm-lockfile-mismatch.md"), "utf-8")
    expect(written).toContain("status: open")
    expect(written).toContain("occurrences: 3")
    expect(written).not.toContain("rule_ref:")
    // 正文五段原样保留（未改写）
    expect(written).toContain("## 根因  lockfile 格式版本与 CLI 版本错配")
    // LOG 追加更新行（更新走编译通道留痕；op=compile）
    const log = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    expect(log).toContain("  → 判例更新 status=open occurrences=3")
    // INDEX 判例行式不随蒸馏状态变（状态面走检索 API 逐页读 front-matter）
    expect(fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")).toContain("- cases/2026-06-23-pnpm-lockfile-mismatch.md — CI 报 LOCKFILE_CONFIG_MISMATCH")
  })

  it("re-ingesting an identical case is a no-op (changed=false, no new commit)", async () => {
    const svc = makeService()
    await svc.compileEntry(caseEntry("2026-06-23-pnpm-lockfile-mismatch.md"))
    const res = await svc.compileEntry(caseEntry("2026-06-23-pnpm-lockfile-mismatch.md"))
    expect(res.changed).toBe(false)
    expect(res.commit).toBeNull()
  })
})
