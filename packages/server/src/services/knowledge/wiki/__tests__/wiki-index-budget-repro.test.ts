import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../../db/schema"
import { WikiCompileService, type GitRunner } from "../compile"
import { estimateTokens, WikiLintError } from "../lint"
import { ensureWikiSkeleton } from "../paths"

/**
 * 票03 · 复现靶真验（D-aa16-2「INDEX 预算三连拒」，spec 故事 24-25）。
 *
 * 现场注记（notes/04 §2.3 事实）：真盘 gist 第 4 投已 committed、现 INDEX 回落预算内、
 * 同 hash 重投幂等 no-op——「三连拒」在今天的真盘不可原样复现。合规真验 = tmpdir
 * 知识根 fixture 复刻 P3 投喂形状（真 fs + in-memory DB + 真 git，wiki-lint 同 harness）：
 *  ① 沉淀推爆恒见段 ⇒ 分层重排收敛（全文 >800 恒见 ≤800 = 旧口径三连拒态本身）→ 新知识
 *     投喂**成功**且预警 finding 伴随（AC4「三连拒的源重新投喂→编译成功落库」的 fixture 形态）
 *  ② 恒见部分 >100% 硬拒带 → 拒写 + 压缩建议随错（AC1 第二级）
 *  ③ 投喂幂等重放 → no-op 不误伤（预警单行不被打脏、零新行——E4 注记面）
 */

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

const SUM = "投喂编译沉淀页摘要恒见行预算压线构造内容恰落分级区间" // 24 CJK/行摘要 ⇒ 行 ≈ 30 token

/** v3 entity 桩页（0 锚点 ⇒ 恒见重排降序在前）。 */
function v3e(i: number): string {
  return `---
id: ent-p3-${String(i).padStart(2, "0")}
type: entity
title: 沉淀页${i}
summary: ${SUM}
links: []
sources: [fixture:ticket-03-repro]
last_compiled: 2026-10-15
---

## 概述
- 正文一行。
`
}

describe("复现靶 D-aa16-2 — P3 三连拒投喂形状在两级 INDEX 下的真验", () => {
  let db: Database.Database
  let tmpDir: string
  let root: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-repro03-"))
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

  /** P2'+P3 沉淀形状：32 页一批投喂（恒见段破 800 ⇒ 自动重排降级收敛）。 */
  async function seedSediment(svc: WikiCompileService) {
    return svc.compilePages(
      Array.from({ length: 32 }, (_, i) => ({ content: v3e(i) })),
      { entry: "p3-seed", note: "沉淀投喂批（复刻 P2'+P3 自然增厚形状）" },
    )
  }

  it("① 沉淀推爆（全文 >800=旧口径三连拒态）→ 新知识投喂成功落库 + 预警 finding 伴随", async () => {
    const svc = makeService()
    await seedSediment(svc)

    // 旧口径病根锚定：INDEX 全文 token >800 而恒见段 ≤800——旧口径下此后任何新增必拒
    //（D-aa16-2 三连拒现场 = 「超过预算 800 且 Optional 重排无法收敛」），两级口径放行
    const indexAfterSeed = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    expect(indexAfterSeed).toContain("## Optional")
    expect(estimateTokens(indexAfterSeed)).toBeGreaterThan(800)
    expect(estimateTokens(indexAfterSeed.split("## Optional")[0])).toBeLessThanOrEqual(800)

    // 「三连拒的源重新投喂」fixture 形态：gist 式两页新知识批投喂 ⇒ 编译成功落库
    const gist = Array.from({ length: 2 }, (_, i) => ({
      content: `---
id: ent-gist-note-${i}
type: entity
title: gist 要点${i}
summary: ${SUM}
links: []
sources: [raw/inbox/2026-10-13-karpathy-llm-wiki-gist.md]
last_compiled: 2026-10-15
---

## 概述
- 要点正文。
`,
    }))
    const res = await svc.compilePages(gist, { entry: "gist-refeed", note: "三连拒源重投（票03 AC4）" })
    expect(res.changed).toBe(true)
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(fs.existsSync(path.join(root, "entities", "ent-gist-note-0.md"))).toBe(true)
    expect((db.prepare("SELECT COUNT(*) AS n FROM wiki_articles").get() as { n: number }).n).toBe(34)

    // 预警 finding 伴随产出（AC1：>80% 放行 + finding；三选提案在 title/detail）
    const warn = db
      .prepare("SELECT id, kind, status, title, detail FROM findings WHERE kind = 'index-budget'")
      .all() as Array<{ id: string; kind: string; status: string; title: string; detail: string }>
    expect(warn).toHaveLength(1)
    expect(warn[0].status).toBe("open")
    expect(warn[0].title).toMatch(/移低频页入 ## Optional \/ 拆分 \/ hub 化/)
    const detail = JSON.parse(warn[0].detail) as { proposals: string[]; visible_tokens: number; percent: number }
    expect(detail.proposals).toHaveLength(3)
    // 恒见段仍在预警带（放行但可见）
    expect(detail.visible_tokens).toBeGreaterThan(640)
    expect(detail.visible_tokens).toBeLessThanOrEqual(800)
  }, 120_000)

  it("② 硬拒带（大库+病态巨页恒见 >100%）→ 拒写 + 压缩建议随错 + 零副作用", async () => {
    const svc = makeService()
    await seedSediment(svc)

    // 巨 topic 页：summary 900 CJK（恒见行 >800）+ 15 锚点 ⇒ 重排序最后出 ⇒ 恒见段降无可降
    const huge = `---
id: top-mega
type: topic
title: 巨页
summary: ${"巨".repeat(900)}
links: []
sources: [fixture:ticket-03-repro]
last_compiled: 2026-10-15
---

## 硬约束
${Array.from({ length: 15 }, (_, i) => `- 硬约束${i}：提交前跑全量 <!--#oct-${1200 + i}-->`).join("\n")}

## 处置
- 说明行。
`
    let caught: unknown
    try {
      await svc.compileEntry({ content: huge })
      expect.unreachable("恒见部分 >100% 必拒")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(WikiLintError)
    const lerr = caught as InstanceType<typeof WikiLintError>
    expect(lerr.message).toMatch(/L4_INDEX_BUDGET/)
    // 压缩建议随错（三通道统一后批面/单页面同形）：锁定最胖页的 hub 化切分计划
    expect(lerr.suggestion).toBeDefined()
    expect(lerr.suggestion!.entryId).toBe("top-mega")
    expect(lerr.suggestion!.children.length).toBeGreaterThanOrEqual(2)
    // 拒写零副作用
    expect(fs.existsSync(path.join(root, "topics", "top-mega.md"))).toBe(false)
    expect((db.prepare("SELECT COUNT(*) AS n FROM wiki_articles WHERE id = 'top-mega'").get() as { n: number }).n).toBe(0)
  }, 120_000)

  it("③ 投喂幂等重放：同内容再投 no-op，预警 finding 不被打脏不增殖（E4 注记面）", async () => {
    const svc = makeService()
    await seedSediment(svc)
    const one = { content: v3e(90) }
    const first = await svc.compilePages([one], { entry: "replay-1", note: "首投" })
    expect(first.changed).toBe(true)

    const dao = db.prepare("SELECT COUNT(*) AS n FROM findings WHERE kind = 'index-budget'").get() as { n: number }
    const detailBefore = (db.prepare("SELECT detail FROM findings WHERE kind = 'index-budget'").get() as { detail: string }).detail

    // 同 hash 重投（E4 事实注现场形）：no-op 零副作用 + 预警面零打脏
    const replay = await svc.compilePages([one], { entry: "replay-2", note: "重放" })
    expect(replay.changed).toBe(false)
    expect(replay.commit).toBeNull()
    expect((db.prepare("SELECT COUNT(*) AS n FROM findings WHERE kind = 'index-budget'").get() as { n: number }).n).toBe(dao.n)
    expect((db.prepare("SELECT detail FROM findings WHERE kind = 'index-budget'").get() as { detail: string }).detail).toBe(detailBefore)
  }, 120_000)
})
