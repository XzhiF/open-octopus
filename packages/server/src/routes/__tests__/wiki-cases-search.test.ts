import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../db/schema"
import { WikiArticleDAO } from "../../db/dao/wiki-article-dao"
import { WikiCompileService, type GitRunner } from "../../services/knowledge/wiki/compile"
import { spawnGit } from "../../services/knowledge/wiki/wiki-git"
import { ensureWikiSkeleton } from "../../services/knowledge/wiki/paths"
import { createWikiRoutes } from "../wiki"

/**
 * 票04 · S3 缝（routes）：domain=cases 检索加权 + rule_ref 顺藤指针。
 * 端到端走 S1 写缝入库（真 fs tmpdir + 真 git + in-memory DB），再打 S3 只读 API——
 * 断言外部产物（JSON 形状/排序），expected 逐字来自 prototype.md Tab③ fixture。
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

/** 只在正文偶然提及 lockfile，symptom/tags 不含——加权后必须排在判例 A 之后。 */
const CASE_BODY_ONLY = `---
id: case-2026-009
symptom: 恢复状态误判 stale
tags: [actuator, stale]
severity: major
occurrences: 1
rule_ref: oct-008
source: exec-7b12
status: distilled
---
## 现场  doctor 把仍在跑的执行报成 stale（lockfile 事故当晚）…
## 诊断  检测读了 started_at
## 根因  长任务 started_at 不更新
## 修复  改用 updated_at
## 教训  时间戳字段要选“最后活动”而非“开始”
`

/** 未蒸馏判例：open + 无 rule_ref。 */
const CASE_OPEN = `---
id: case-2026-011
symptom: pnpm store 并发写冲突
tags: [pnpm, store]
severity: minor
occurrences: 1
source: exec-aa01
status: open
---
## 现场  并发 CI 任务争抢 store
## 诊断  store 路径未隔离
## 根因  共享 store 无锁
## 修复  按 runner 隔离 store 目录
## 教训  缓存目录并发要先假设会被踩
`

/** 规则词条：正文也含 LOCKFILE_CONFIG_MISMATCH 行——domain=cases 过滤不得放它进来，但全库检索时判例优先。 */
const RULE_ENTRY = `---
id: prj-octopus
domain: projects
title: Octopus 平台工程知识
summary: monorepo 构建/测试/端口规则与已知陷阱
topics: [build, ci]
stability: stable
last_compiled: 2026-10-12
sources: [archive:task-207]
confidence: 0.86
---

## CI 规则
- CI 必须用 pnpm 10，v9 报 LOCKFILE_CONFIG_MISMATCH <!--#oct-013-->
`

// 票06 合并适配：服务写通道提交须走 spawnGit（自动携带 OCTOPUS_WIKI_COMMIT_SOURCE=curate
// 标记，与生产 WikiCompileService 默认 this.git 同一通道）；裸 spawnSync 会被 pre-commit 闸门拒。
const realGit = (cwd: string): GitRunner => spawnGit(cwd)

describe("cases in search/article routes (ticket 04, S3)", () => {
  let db: Database.Database
  let tmpDir: string
  let root: string
  let dao: WikiArticleDAO
  let app: ReturnType<typeof createWikiRoutes>

  beforeEach(async () => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new WikiArticleDAO(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-cases-search-"))
    root = path.join(tmpDir, "wiki")
    ensureWikiSkeleton(root)
    const svc = new WikiCompileService({ db, repo_group: "global", rootDir: root, git: realGit(root) })
    await svc.compileEntry({ content: CASE_LOCKFILE, fileName: "2026-06-23-pnpm-lockfile-mismatch.md" })
    await svc.compileEntry({ content: CASE_BODY_ONLY, fileName: "2026-07-02-actuator-stale-detect.md" })
    await svc.compileEntry({ content: CASE_OPEN, fileName: "2026-08-01-pnpm-store-race.md" })
    await svc.compileEntry({ content: RULE_ENTRY })
    app = createWikiRoutes(dao, { rootDir: root })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("search?q=LOCKFILE&domain=cases: both cases hit, symptom-weighted case ranks first, carries rule_ref pointer", async () => {
    const data = await (await app.request(`/search?q=LOCKFILE&org=xzf-dev&domain=cases`)).json()
    expect(data.results).toHaveLength(2)
    expect(data.results.map((r: { id: string }) => r.id)).toEqual(["case-2026-003", "case-2026-009"])
    // 顺藤指针：命中行携带 rule_ref（已蒸馏）/ null（未蒸馏不强制）
    expect(data.results[0].ruleRef).toBe("oct-013")
    expect(data.results[0].status).toBe("distilled")
  })

  it("tag-only hit still surfaces via weighting (query=pnpm 命中 tags 而非 symptom)", async () => {
    const data = await (await app.request(`/search?q=pnpm&org=xzf-dev&domain=cases`)).json()
    const ids = data.results.map((r: { id: string }) => r.id)
    expect(ids).toContain("case-2026-003")
    expect(ids).toContain("case-2026-011")
    // symptom 含 pnpm 的判例（case-2026-011 symptom 'pnpm store 并发写冲突'）排前
    expect(ids[0]).toBe("case-2026-011")
    expect(data.results.find((r: { id: string }) => r.id === "case-2026-011").ruleRef).toBeNull()
    expect(data.results.find((r: { id: string }) => r.id === "case-2026-011").status).toBe("open")
  })

  it("unfiltered search puts symptom-matched case ahead of rule entry that only mentions it in body", async () => {
    const data = await (await app.request(`/search?q=LOCKFILE&org=xzf-dev`)).json()
    const ids = data.results.map((r: { id: string }) => r.id)
    expect(ids[0]).toBe("case-2026-003")
    expect(ids).toContain("prj-octopus")
    expect(ids.indexOf("case-2026-003")).toBeLessThan(ids.indexOf("prj-octopus"))
  })

  it("article of a case carries case fields for 状态 chips (status/rule_ref/occurrences/severity/tags)", async () => {
    const data = await (await app.request(`/article/case-2026-003?org=xzf-dev`)).json()
    expect(data.domain).toBe("cases")
    expect(data.case).toMatchObject({
      symptom: "CI 报 LOCKFILE_CONFIG_MISMATCH",
      tags: ["ci", "pnpm", "lockfile"],
      severity: "blocker",
      occurrences: 2,
      ruleRef: "oct-013",
      status: "distilled",
    })
    // 五段正文原样可读（UI 中栏 MarkdownPreview 消费 body）
    expect(data.body).toContain("## 教训")
    // 非判例词条不带 case
    const entry = await (await app.request(`/article/prj-octopus?org=xzf-dev`)).json()
    expect(entry.case).toBeNull()
  })

  it("tree exposes the cases group with case entries", async () => {
    const data = await (await app.request(`/tree?org=xzf-dev`)).json()
    const casesGroup = data.domains.find((d: { name: string }) => d.name === "cases")
    expect(casesGroup).toBeTruthy()
    expect(casesGroup.label).toBe("问题案例档")
    expect(casesGroup.count).toBe(3)
    expect(casesGroup.entries.map((e: { id: string }) => e.id)).toContain("case-2026-003")
    expect(data.stats.cases).toBe(3)
  })
})
