import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../../db/schema"
import { PendingReviewDAO } from "../../../../db/dao/pending-review-dao"
import { WikiArticleDAO } from "../../../../db/dao/wiki-article-dao"
import { WikiCompileService } from "../compile"
import { WikiCurateService, isGenuineWikiTarget } from "../curate"
import { ReviewService } from "../../review"
import type { PendingReviewRow } from "../../../../db/dao/pending-review-dao"

/**
 * S1 缝（票06）：策展写闸环级测试 — review.test.ts + knowledge-loop.test.ts 先例。
 * 真 fs tmpdir + in-memory DB + 真 git。只断言外部产物：
 *   词条文件 / git log（含审核引用）/ LOG.md / INDEX.md / FTS 命中 / pending 状态。
 * Expected 值逐字取自 prototype Tab③⑤（oct-013 / LOCKFILE_CONFIG_MISMATCH / retire 行形态）。
 */

const SAMPLE_ENTRY = `---
id: prj-octopus
domain: projects
title: Octopus 平台工程知识
summary: monorepo 构建/测试/端口规则与已知陷阱
topics: [build, test, ports, pitfall]
stability: stable
last_compiled: 2026-10-12
sources: [archive:task-207, chat:session-8f21, doc:windows-bash.md]
confidence: 0.86
---

## 构建规则
- 修改 shared/ 后必须 \`pnpm build -w shared\` 再全量构建 <!--#oct-001-->
- 构建命令: \`pnpm build\` <!--#oct-002-->

## 已知陷阱
- Promise.allSettled 聚合调用必须设全局超时 <!--#oct-007-->
- stale 检测一律用 updated_at（不是 started_at） <!--#oct-008-->

## 端口规则
- ⛔ 保护端口: 3000, 3001, 3098, 3099 <!--#oct-010-->
- Windows 拆机三段式: pnpm port → kill:port → netstat 复核 <!--#oct-012-->
`

/** 审核队列 [规则] 条目正文 — 逐字 prototype Tab⑤ 队列项 1 / Tab③ LOG 样例「+oct-013 CI pnpm10 约束」。 */
const CI_PNPM10_RULE = "CI 必须用 pnpm 10：lockfile overrides 住在 pnpm-workspace.yaml（v10 格式），v9 读不进报 LOCKFILE_CONFIG_MISMATCH"

function rawGit(cwd: string, args: string[], env?: Record<string, string>) {
  const e = { ...process.env, ...(env ?? {}) }
  if (!env || env.OCTOPUS_WIKI_COMMIT_SOURCE === undefined) delete e.OCTOPUS_WIKI_COMMIT_SOURCE
  const r = spawnSync("git", args, { cwd, timeout: 30000, encoding: "utf-8", env: e })
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

/** 旁路通道模拟：进程终端裸跑 git（无策展标记环境变量）。 */
const bypassGit = (cwd: string, args: string[]) => rawGit(cwd, args)

describe("wiki curate write gate (ticket 06)", async () => {
  let db: Database.Database
  let pdao: PendingReviewDAO
  let tmpDir: string
  let root: string

  beforeEach(async () => {
    db = new Database(":memory:")
    applySchema(db)
    pdao = new PendingReviewDAO(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-curate-"))
    root = path.join(tmpDir, "wiki")
    // P1 旧追加轨道的落点隔离（review.test.ts 同款）——绝不碰真实 ~/.octopus
    process.env.OCTOPUS_KNOWLEDGE_DIR = path.join(tmpDir, "legacy-knowledge")
    await new WikiCompileService({ db, org: "testorg", rootDir: root }).compileEntry({
      content: SAMPLE_ENTRY,
      source: "doc:prototype",
    })
  })

  afterEach(() => {
    db?.close()
    delete process.env.OCTOPUS_KNOWLEDGE_DIR
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** 生产同款接线（index.ts）：approve 按 type 分发 → 策展编译通道；
   *  判式注入 isWikiEntryTarget（真词条才进场，回归修复）。 */
  function makeReviewService() {
    return new ReviewService(pdao, {
      applyWikiCurate: (item) =>
        new WikiCurateService({ db, org: "testorg", rootDir: root }).applyApprovedItem(item),
      isWikiEntryTarget: (item) => isGenuineWikiTarget(item, root),
    })
  }

  function insertRule(overrides: Partial<Parameters<PendingReviewDAO["insert"]>[0]> = {}) {
    const id = overrides.id ?? "rule-ci-pnpm10"
    pdao.insert({
      id,
      type: "rule",
      source: "workspace_archive",
      source_ref: "task-207",
      source_label: "归档提炼规则",
      content: CI_PNPM10_RULE,
      target_file: "projects/prj-octopus.md",
      scope: "project",
      conflicts: null,
      confidence: 0.7,
      auto_approve: 0,
      status: "pending",
      user_notes: null,
      ...overrides,
    })
    return id
  }

  // =========================================================================
  // 环①：审核队列 approve 一条规则 → 词条更新 + git commit + LOG 行三处一致
  // =========================================================================
  it("approve rule → entry gains oct-013, commit carries review ref, LOG/INDEX/FTS in sync", async () => {
    const id = insertRule()

    const r = await makeReviewService().approveItem(id, "testorg")
    expect(r.ok).toBe(true)
    expect(pdao.getById(id)?.status).toBe("approved")

    // 词条更新：新锚点 oct-013（prototype Tab③ LOG 样例 verbatim）+ 规则正文
    const entry = fs.readFileSync(path.join(root, "projects", "prj-octopus.md"), "utf-8")
    expect(entry).toContain("<!--#oct-013-->")
    expect(entry).toContain("LOCKFILE_CONFIG_MISMATCH")

    // git commit：策展提交带审核引用（pending item id）
    const subject = rawGit(root, ["log", "-1", "--pretty=%s"]).stdout
    expect(subject).toContain(`[review:${id}]`)

    // LOG 行：compile 动作 + 「+oct-013」摘要列
    const log = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    expect(log).toMatch(/\| compile \| projects\/prj-octopus\.md \| \+oct-013/)

    // INDEX 重建：规则统计 6 → 7
    const index = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    expect(index).toContain("· 7 规则")

    // FTS 同步：新正文词 "lockfile" 检索命中（compile 前不存在该词）
    const hits = new WikiArticleDAO(db).search("testorg", "lockfile")
    expect(hits.some(h => h.id === "prj-octopus")).toBe(true)
  })

  // =========================================================================
  // 环②：编译 ≠ 追加 — 近义规则并入现行条目，不双写（prototype 冲突卡「overlaps→合并」）
  // =========================================================================
  it("approve 近义重复规则 → 并入现行 oct-013，词条不双写、零提交", async () => {
    const firstId = insertRule()
    await makeReviewService().approveItem(firstId, "testorg")

    const entryAfterFirst = fs.readFileSync(path.join(root, "projects", "prj-octopus.md"), "utf-8")
    const commitsBefore = rawGit(root, ["rev-list", "--count", "HEAD"]).stdout.trim()

    // 近义重复：markdown 记号/空白/全半角标点差异（归档侧两次提炼同一条坑）
    const dupId = insertRule({
      id: "rule-ci-pnpm10-dup",
      content: "**CI 必须用 pnpm 10** — lockfile overrides 住在 `pnpm-workspace.yaml`（v10 格式），v9 读不进报 LOCKFILE_CONFIG_MISMATCH。",
    })
    await makeReviewService().approveItem(dupId, "testorg")

    const entryAfterDup = fs.readFileSync(path.join(root, "projects", "prj-octopus.md"), "utf-8")
    expect(entryAfterDup).toBe(entryAfterFirst) // 零双写
    expect(rawGit(root, ["rev-list", "--count", "HEAD"]).stdout.trim()).toBe(commitsBefore) // 零新提交
    expect(pdao.getById(dupId)?.status).toBe("approved") // 仍正常结案
  })

  // =========================================================================
  // 写权保护①：user_preference.md 永不进入自动写路径（蓝图/票06 双钉，仓库
  // no-auto-write-user-files 纪律）——策展通道对它只出"AI 辅助建议"，零自动改写。
  // =========================================================================
  it("approve rule targeting user_preference.md → 拒绝，盘上零触碰，状态仍 pending", async () => {
    // 预置一份手动维护的 preference 文件（wiki 根级，非词条域）
    const prefPath = path.join(root, "user_preference.md")
    const manualContent = "# User Preference（手动维护）\n- 回答要简短\n"
    fs.writeFileSync(prefPath, manualContent, "utf-8")

    const id = insertRule({
      id: "rule-pref-auto",
      content: "回答要简短且必须带例子",
      target_file: "user_preference.md",
    })
    await expect(makeReviewService().approveItem(id, "testorg")).rejects.toThrow(/CURATE_REFUSED_USER_PREFERENCE/)

    expect(fs.readFileSync(prefPath, "utf-8")).toBe(manualContent) // 一字未动
    expect(pdao.getById(id)?.status).toBe("pending") // 未结案——建议形态见 suggestionForPreference

    // 「AI 辅助编辑建议 → 人确认」形态：纯文本建议，不落盘
    const suggestion = WikiCurateService.preferenceEditSuggestion(pdao.getById(id)!)
    expect(suggestion).toContain("回答要简短且必须带例子")
    expect(suggestion).toContain("人工确认")
    expect(suggestion).toContain("不自动改写")
  })

  // =========================================================================
  // 写权保护②（技术强制）：wiki repo pre-commit hook 拒绝非策展通道的直接提交
  // ——「写入单一闸门」从流程约定变成 git 层强制（票06 核心断言）。
  // =========================================================================
  it("pre-commit hook: 无标记的旁路提交被拒；策展通道提交放行；manual 标记可维护 user_preference，curate 标记不行", async () => {
    // 策展编译通道已建仓（beforeEach 的 compileEntry）——hook 应随 ensureWikiGitRepo 落位
    expect(fs.existsSync(path.join(root, ".git", "hooks", "pre-commit"))).toBe(true)

    // ── 旁路：绕过服务直接用 fs 改词条 + 裸 git commit（无 OCTOPUS_WIKI_COMMIT_SOURCE）──
    const target = path.join(root, "projects", "prj-octopus.md")
    fs.appendFileSync(target, "\n- 旁路直写（非策展通道） <!--#oct-900-->\n")
    bypassGit(root, ["add", "-A"])
    const denied = bypassGit(root, ["commit", "-m", "bypass: direct append"])
    expect(denied.status).not.toBe(0)
    expect(denied.stderr).toContain("OCTOPUS_WIKI_COMMIT_SOURCE")
    // 提交确实没进去（HEAD 仍是策展编译的那个 commit）
    expect(bypassGit(root, ["log", "-1", "--pretty=%s"]).stdout).toContain("compile: projects/prj-octopus.md")

    // 清理旁路工作区改动，恢复基线
    bypassGit(root, ["checkout", "--", "projects/prj-octopus.md"])

    // ── user_preference.md 双闸：curate 标记（自动通道）也拒，manual 标记（人工）才放行 ──
    const prefPath = path.join(root, "user_preference.md")
    fs.writeFileSync(prefPath, "# User Preference（手动维护）\n- 回答要简短\n")
    bypassGit(root, ["add", "-A"])
    const autoRejected = rawGit(root, ["commit", "-m", "auto: touch preference"], { OCTOPUS_WIKI_COMMIT_SOURCE: "curate" })
    expect(autoRejected.status).not.toBe(0)
    expect(autoRejected.stderr).toContain("user_preference")

    const manualOk = rawGit(root, ["commit", "-m", "manual: preference maintained by human"], { OCTOPUS_WIKI_COMMIT_SOURCE: "manual" })
    expect(manualOk.status).toBe(0)
    expect(rawGit(root, ["log", "-1", "--pretty=%s"]).stdout).toContain("manual: preference maintained by human")
  })

  // =========================================================================
  // 冲突三型·supersedes（prototype Tab⑤ 队列项 4 verbatim 场景）：
  // oct-009 被 doer 上报 stale，修订稿采纳后旧行迁入 _retired/ 带 replaced_by 指针，
  // retire + compile 同一 commit（审核引用入 message）。
  // =========================================================================
  it("approve wiki-edit supersedes → 旧规则迁 _retired/oct-009.md（replaced_by），新行 oct-013 上岗，LOG retire+compile 两行同 commit", async () => {
    // 预置现行规则 oct-009（业务域小词条）
    const biz = `---
id: biz-x-real-ip
domain: business
title: 客户端 IP 判定口径
summary: 网关头与 TCP remoteAddress 的判定规则
topics: [ip, gateway]
stability: stable
last_compiled: 2026-10-12
sources: [archive:task-199]
confidence: 0.6
---

## 判定规则
- 网关 x-real-ip 头判定客户端 IP 可靠 <!--#oct-009-->
`
    await new WikiCompileService({ db, org: "testorg", rootDir: root }).compileEntry({ content: biz })

    const commitsBefore = Number(rawGit(root, ["rev-list", "--count", "HEAD"]).stdout.trim())

    pdao.insert({
      id: "wiki-edit-stale-oct009",
      type: "wiki-edit",
      source: "wiki_refs_stale",
      source_ref: "task-207",
      source_label: "doer 上报 stale：x-real-ip 判断已改为 TCP remoteAddress",
      content: JSON.stringify({
        kind: "wiki-edit",
        path: "business/biz-x-real-ip.md",
        replace: { anchor: "oct-009", text: "客户端 IP 判定一律以 TCP remoteAddress 为准，不信任可伪造的 x-real-ip 头" },
        supersedes: ["oct-009"],
      }),
      target_file: "business/biz-x-real-ip.md",
      scope: "wiki",
      conflicts: JSON.stringify([{ type: "supersedes", anchor: "oct-009" }]),
      confidence: 0.8,
      auto_approve: 0,
      status: "pending",
      user_notes: null,
    })

    const r = await makeReviewService().approveItem("wiki-edit-stale-oct009", "testorg")
    expect(r.ok).toBe(true)

    // 词条：旧行出局，新行带新锚点 oct-013（样本最大 012+1；永不复用旧号）
    const entry = fs.readFileSync(path.join(root, "business", "biz-x-real-ip.md"), "utf-8")
    expect(entry).not.toContain("oct-009")
    expect(entry).toContain("<!--#oct-013-->")
    expect(entry).toContain("TCP remoteAddress")

    // 退役区：旧规则可追溯 + replaced_by 指针
    const retired = fs.readFileSync(path.join(root, "_retired", "oct-009.md"), "utf-8")
    expect(retired).toContain("replaced_by: oct-013")
    expect(retired).toContain("x-real-ip 头判定客户端 IP 可靠")
    expect(retired).toContain("wiki-edit-stale-oct009")

    // LOG：retire + compile 两行（prototype retire 行形态「oct-009 → _retired/」）
    const log = fs.readFileSync(path.join(root, "LOG.md"), "utf-8")
    expect(log).toMatch(/\| retire \| oct-009 → _retired\/ \| .*replaced_by oct-013/)
    expect(log).toMatch(/\| compile \| business\/biz-x-real-ip\.md \| \+oct-013/)

    // 单次 approve = 单个 commit（retire 与 compile 同事务落库），带审核引用
    const commitsAfter = Number(rawGit(root, ["rev-list", "--count", "HEAD"]).stdout.trim())
    expect(commitsAfter - commitsBefore).toBe(1)
    const subject = rawGit(root, ["log", "-1", "--pretty=%s"]).stdout
    expect(subject).toContain("[review:wiki-edit-stale-oct009]")
    const files = rawGit(root, ["show", "--name-only", "--pretty=", "HEAD"]).stdout
    expect(files.replace(/\\/g, "/")).toContain("_retired/oct-009.md")
    // 队列结案
    expect(pdao.getById("wiki-edit-stale-oct009")?.status).toBe("approved")
    // DB/FTS 同步：新词检索命中、旧句不再出现在当前 body
    expect(new WikiArticleDAO(db).get("testorg", "biz-x-real-ip")?.body).toContain("remoteAddress")
  })

  // =========================================================================
  // 冲突三型·contradicts/overlaps 编译时复核（蓝图保留：队列已人工裁决 →
  // 写面不阻断，但冲突必须显式浮出，供结果/LOG 审计）。
  // 样本词条 oct-007:「Promise.allSettled 聚合调用必须设全局超时」——
  // 极性相反 + 高重叠 → contradicts；高重叠同极性 → overlaps。
  // =========================================================================
  it("编译时复核：极性相反的高重叠新规则浮出 contradicts（仍写入——人工已批准），同向高重叠浮出 overlaps", async () => {
    const curate = new WikiCurateService({ db, org: "testorg", rootDir: root })

    const contraRow = pdao.getById(insertRule({
      id: "rule-contradict",
      content: "Promise.allSettled 聚合调用禁止设全局超时",
    }))!
    const res1 = await curate.applyApprovedItem(contraRow)
    expect(res1.action).toBe("added") // 人工已批准 → 写面不阻断，冲突显式浮出
    const contra = res1.conflicts.find(cf => cf.type === "contradicts" && cf.anchor === "oct-007")
    expect(contra, "同话题极性相反应复核出 contradicts(oct-007)").toBeDefined()

    const overRow = pdao.getById(insertRule({
      id: "rule-overlaps",
      content: "Promise.allSettled 聚合调用必须设全局超时（推荐 60s）",
    }))!
    const res2 = await curate.applyApprovedItem(overRow)
    const over = res2.conflicts.find(cf => cf.type === "overlaps" && cf.anchor === "oct-007")
    expect(over, "部分重叠同极性应复核出 overlaps(oct-007)").toBeDefined()
  })

  // =========================================================================
  // 编译（compile）≠ 追加（append）：坏内容（断链）被 lint 闸拒写，
  // approve 整体失败、状态留 pending、盘上/ git 零痕迹——不存在 appendFile 旁路。
  // =========================================================================
  it("approve rule with broken wikilink → L5 拒写，approve 失败，词条与 HEAD 不变，状态仍 pending", async () => {
    const headBefore = rawGit(root, ["rev-parse", "HEAD"]).stdout.trim()
    const entryBefore = fs.readFileSync(path.join(root, "projects", "prj-octopus.md"), "utf-8")
    const id = insertRule({
      id: "rule-broken-link",
      content: "端口规则详见 [[workflows/nonexistent-flow]] 词条",
    })
    await expect(makeReviewService().approveItem(id, "testorg")).rejects.toThrow(/L5_LINK_BROKEN/)
    expect(fs.readFileSync(path.join(root, "projects", "prj-octopus.md"), "utf-8")).toBe(entryBefore)
    expect(rawGit(root, ["rev-parse", "HEAD"]).stdout.trim()).toBe(headBefore)
    expect(pdao.getById(id)?.status).toBe("pending")
  })

  // =========================================================================
  // 回归（code review 发现2，fail-closed regression）：策展闸只管「真 wiki 词条」。
  // 知识中心票 08：旧注入轨道的 append 轨已物理删除 —— 非真词条的同前缀目标
  // （scope=project、词条不在 wiki 盘）不进策展闸、approve 只结案状态，
  // 旧知识目录零文件（不再拖成 pending，原「main 追加成功」语义的结案面不变）。
  // =========================================================================
  it("非真词条 rule（scope=project、wiki 根无此词条）→ 不进策展闸；approve 结案且旧知识目录零写入（票08 剔轨）", async () => {
    let curateCalls = 0
    const review = new ReviewService(pdao, {
      applyWikiCurate: async () => { curateCalls++; throw new Error("SIMULATED_CURATE_BLOWUP") },
      isWikiEntryTarget: (item) => isGenuineWikiTarget(item, root),
    })
    const headBefore = rawGit(root, ["rev-parse", "HEAD"]).stdout.trim()
    const id = insertRule({ id: "rule-legacy-target", target_file: "workflows/legacy-deploy-notes.md" })

    // 票06 宽松前缀闸下这行会 reject（词条不存在 → CURATE_NOT_WIKI_TARGET）——结案语义保持
    const r = await review.approveItem(id, "testorg")
    expect(r.ok).toBe(true)
    expect(curateCalls).toBe(0)
    expect(pdao.getById(id)?.status).toBe("approved")

    // 票08：append 轨已剔除 —— 旧知识目录（OCTOPUS_KNOWLEDGE_DIR 隔离）不再出现该文件
    const legacyPath = path.join(process.env.OCTOPUS_KNOWLEDGE_DIR!, "workflows", "legacy-deploy-notes.md")
    expect(fs.existsSync(legacyPath)).toBe(false)
    // wiki 仓零沾染
    expect(rawGit(root, ["rev-parse", "HEAD"]).stdout.trim()).toBe(headBefore)
  })

  it("真词条 rule（词条在盘）→ 仍进策展闸：闸抛错 ⇒ approve 整体失败、状态留 pending（单一闸门无旁路不变）", async () => {
    let curateCalls = 0
    const review = new ReviewService(pdao, {
      applyWikiCurate: async () => { curateCalls++; throw new Error("SIMULATED_CURATE_BLOWUP") },
      isWikiEntryTarget: (item) => isGenuineWikiTarget(item, root),
    })
    const id = insertRule({ id: "rule-wiki-gate-still-fires" }) // 默认 target projects/prj-octopus.md（beforeEach 已编译在盘）
    await expect(review.approveItem(id, "testorg")).rejects.toThrow(/SIMULATED_CURATE_BLOWUP/)
    expect(curateCalls).toBe(1)
    expect(pdao.getById(id)?.status).toBe("pending")
  })

  it("scope='wiki' 的 rule（wiki 通道入队标记）→ 词条不在盘也进闸（P2 新建词条通道保留）", async () => {
    let curateCalls = 0
    const review = new ReviewService(pdao, {
      applyWikiCurate: async () => { curateCalls++; return {} },
      isWikiEntryTarget: (item) => isGenuineWikiTarget(item, root),
    })
    const id = insertRule({ id: "rule-scope-wiki", scope: "wiki", target_file: "projects/prj-brand-new.md" })
    await review.approveItem(id, "testorg")
    expect(curateCalls).toBe(1)
  })

  it("非真词条 wiki-edit 旧行（手工/遗留）→ 不进策展通道、不新增失败，approve 结案不写旧文件（票08 剔轨）", async () => {
    let curateCalls = 0
    const review = new ReviewService(pdao, {
      applyWikiCurate: async () => { curateCalls++; return {} },
      isWikiEntryTarget: (item) => isGenuineWikiTarget(item, root),
    })
    pdao.insert({
      id: "wiki-edit-legacy-row", type: "wiki-edit", source: "wiki_refs_stale", source_ref: "exec-9",
      source_label: "旧手工行", content: JSON.stringify({ kind: "wiki-edit", path: "notes.md", addRule: "测试" }),
      target_file: "workflows/legacy-edit-target.md", scope: "project", conflicts: null,
      confidence: 0.5, auto_approve: 0, status: "pending", user_notes: null,
    })
    const r = await review.approveItem("wiki-edit-legacy-row", "testorg")
    expect(r.ok).toBe(true)
    expect(curateCalls).toBe(0)
    expect(pdao.getById("wiki-edit-legacy-row")?.status).toBe("approved")
  })

  // ── 判式单元测试（闸门裁决件）──
  it("isGenuineWikiTarget：scope=wiki ⇒ true（不在盘也算）；在盘真词条+project ⇒ true；不在盘/非词条形态 ⇒ false", () => {
    expect(isGenuineWikiTarget({ scope: "wiki", target_file: "research/res-new.md" }, root)).toBe(true)
    expect(isGenuineWikiTarget({ scope: "project", target_file: "projects/prj-octopus.md" }, root)).toBe(true)
    expect(isGenuineWikiTarget({ scope: "project", target_file: "workflows/no-such-entry.md" }, root)).toBe(false)
    expect(isGenuineWikiTarget({ scope: "project", target_file: "user_preference.md" }, root)).toBe(false)
    expect(isGenuineWikiTarget({ scope: "project", target_file: "" }, root)).toBe(false)
  })
})
