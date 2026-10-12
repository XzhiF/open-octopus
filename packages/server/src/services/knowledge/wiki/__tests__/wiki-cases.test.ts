import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../../db/schema"
import { WikiCompileService, type GitRunner } from "../compile"
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

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000 })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

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

    // LOG：prototype 行式 case+（Tab③ line 119 动作词）
    const log = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    expect(log).toContain(`| ${today()} | case+ | cases/2026-06-23-pnpm-lockfile-mismatch.md |`)
    expect(log).toContain("exec-9f31 | xzf ✓ |")
  })

  it("INDEX.md cases section: one line per case (symptom + tags + occurrences + distill pointer)", async () => {
    const svc = makeService()
    await svc.compileEntry(caseEntry("2026-06-23-pnpm-lockfile-mismatch.md"))
    await svc.compileEntry({ content: CASE_ACTUATOR, fileName: "2026-07-02-actuator-stale-detect.md" })

    const index = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    // 域节头 + 每案例一行（prototype Tab③ lines 64-66 形状：症状摘要｜tags: …｜×N → 已蒸馏 oct-…）
    expect(index).toContain("## cases/ （问题案例档 · 2 案例 · 卡壳时按症状检索）")
    expect(index).toContain("- cases/2026-06-23-pnpm-lockfile-mismatch.md — CI 报 LOCKFILE_CONFIG_MISMATCH｜tags: ci,pnpm,lockfile｜×2 → 已蒸馏 oct-013")
    expect(index).toContain("- cases/2026-07-02-actuator-stale-detect.md — 恢复状态误判 stale｜tags: actuator,stale → 已蒸馏 oct-008")
    // 统计行：案例计数独立于词条
    expect(index).toContain("词条 0 · 案例 2 · 规则 0")
  })

  it("open case renders 未蒸馏 pointer-less line", async () => {
    const svc = makeService()
    await svc.compileEntry({ content: CASE_DATED_BODY, fileName: "2026-09-05-msys-colon-pathconv.md" })
    const index = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    expect(index).toContain("｜tags: windows,gitbash｜未蒸馏")
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

  it("append-only: body rewrite rejected AFTER ingest, LOG gains a case-rej evidence row, file untouched", async () => {
    const svc = makeService()
    await svc.compileEntry(caseEntry("2026-06-23-pnpm-lockfile-mismatch.md"))
    const bytesBefore = fs.readFileSync(path.join(root, "cases", "2026-06-23-pnpm-lockfile-mismatch.md"), "utf-8")
    const logBefore = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")

    const tampered = CASE_LOCKFILE.replace("## 根因  lockfile 格式版本与 CLI 版本错配", "## 根因  是别的原因（篡改）")
    await expect(svc.compileEntry({ content: tampered, fileName: "2026-06-23-pnpm-lockfile-mismatch.md" })).rejects.toThrow(/CASE_APPEND_ONLY/)

    // 文件字节级不动；LOG.md 多一行 case-rej 证据（改写尝试被拒并留 LOG）
    expect(fs.readFileSync(path.join(root, "cases", "2026-06-23-pnpm-lockfile-mismatch.md"), "utf-8")).toBe(bytesBefore)
    const log = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    expect(log.startsWith(logBefore)).toBe(true)
    expect(log).toContain(`| ${today()} | case-rej | cases/2026-06-23-pnpm-lockfile-mismatch.md | 正文改写被拒（append-only 判例即历史） |`)
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
    // LOG 追加 revise 行（更新走编译通道留痕）
    const log = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    expect(log).toContain(`| ${today()} | revise | cases/2026-06-23-pnpm-lockfile-mismatch.md | 判例更新 status=open occurrences=3 |`)
    // INDEX 行随蒸馏状态翻转
    expect(fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")).toContain("｜×3｜未蒸馏")
  })

  it("re-ingesting an identical case is a no-op (changed=false, no new commit)", async () => {
    const svc = makeService()
    await svc.compileEntry(caseEntry("2026-06-23-pnpm-lockfile-mismatch.md"))
    const res = await svc.compileEntry(caseEntry("2026-06-23-pnpm-lockfile-mismatch.md"))
    expect(res.changed).toBe(false)
    expect(res.commit).toBeNull()
  })
})
