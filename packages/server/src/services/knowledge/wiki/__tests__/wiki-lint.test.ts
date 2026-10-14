import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../../db/schema"
import { WikiCompileService, type GitRunner } from "../compile"
import { estimateTokens } from "../lint"
import { ensureWikiSkeleton } from "../paths"

/**
 * S1 缝（spec §Testing Decisions）：wiki lint 编译期闸（票02 L1-L6）。
 * 真 fs tmpdir + in-memory DB + 真 git（wiki-compile.test.ts 同款先例）。
 * 只断言外部产物：抛错 / 文件缺席 / INDEX.md / pending_review 行。
 * Expected 阈值逐字来自 prototype.md Tab③「增长约束」表 lines 573-581
 * （120 行 / 25 条规则 / ~2000 token / 单 H2 ≤10 / INDEX ≤800 token / 代码块 ≤20 行）——独立真相源，禁止同义反复。
 */

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    // 票06 起 wiki 仓带 pre-commit 写闸：服务通道同款提交来源标记
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

function frontmatter(id: string, extra: Record<string, string> = {}): string {
  return `---
id: ${id}
domain: ${extra.domain ?? "projects"}
title: ${extra.title ?? "L1 fixture"}
summary: ${extra.summary ?? "构造超限样例"}
topics: [lint]
stability: stable
last_compiled: 2026-10-12
sources: [fixture:ticket-02]
confidence: 0.9
---
`
}

/** n 条规则行（锚点 oct-5NN 递增），行文本为固定构造。 */
function rules(n: number, from = 501): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    out.push(`- 规则文本第${i + 1}条：提交前必须跑 pnpm test 全量通过 <!--#oct-${from + i}-->`)
  }
  return out.join("\n")
}

/** 把正文垫到恰好 totalLines 行（填充不带锚点的说明行——front-matter 解析会折叠纯空行）。 */
function padLines(body: string, totalLines: number): string {
  const lines = body.split("\n")
  let i = 0
  while (lines.length < totalLines) lines.push(`- 说明${++i}：常青补充行，不携带规则锚点`)
  return lines.join("\n") + "\n"
}

describe("wiki lint — L1 容量闸 + 拆分提案 (prototype Tab③: 120行/25规则/~2000token 先到为准)", () => {
  let db: Database.Database
  let tmpDir: string
  let root: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-lint-"))
    root = path.join(tmpDir, "wiki")
    ensureWikiSkeleton(root)
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeService(git?: GitRunner) {
    return new WikiCompileService({ db, org: "testorg", rootDir: root, git: git ?? realGit(root) })
  }

  it("拒写 121 行词条（>120 行先到为准）并随错误返回按 H2 的拆分建议——不入队（票04 AC5）", async () => {
    const body = `
## 构建规则
${rules(4)}

## 陷阱
${rules(2, 511)}

## CI
${rules(1, 521)}
`
    const over = frontmatter("prj-big") + padLines(body, 121)
    const svc = makeService()
    await expect(svc.compileEntry({ content: over })).rejects.toThrow(/L1_CAPACITY.*120/s)

    // ── 拒写：词条不存在、无 DB 行、无 git 仓库（副作用在闸后）
    expect(fs.existsSync(path.join(root, "projects", "prj-big.md"))).toBe(false)
    expect((db.prepare("SELECT COUNT(*) AS n FROM wiki_articles").get() as { n: number }).n).toBe(0)
    expect(fs.existsSync(path.join(root, ".git"))).toBe(false)

    // ── 拆分出口=建议随错（供策展人对话内自纠）：按 H2 小节的切分计划
    try {
      await svc.compileEntry({ content: over })
      expect.unreachable()
    } catch (err) {
      const { WikiLintError } = await import("../lint")
      expect(err).toBeInstanceOf(WikiLintError)
      const proposal = (err as InstanceType<typeof WikiLintError>).suggestion
      expect(proposal).toBeDefined()
      expect(proposal!.entryId).toBe("prj-big")
      expect(proposal!.domain).toBe("projects")
      expect(proposal!.path).toBe("projects/prj-big.md")
      expect(proposal!.hubPath).toBe("projects/prj-big/README.md")
      expect(proposal!.reason).toMatch(/120/)
      expect(proposal!.children.map(c => c.title)).toEqual(["构建规则", "陷阱", "CI"])
      expect(proposal!.children.map(c => c.anchors)).toEqual([
        ["oct-501", "oct-502", "oct-503", "oct-504"],
        ["oct-511", "oct-512"],
        ["oct-521"],
      ])
    }

    // ── 重复触顶只随错、不落盘（票08：pending_review 已退役，无「入队」语义可断言）
    await expect(svc.compileEntry({ content: over })).rejects.toThrow(/L1_CAPACITY/s)
  })

  it("拒写 26 条规则词条（>25 条规则先到为准，行数/token 均在线内）", async () => {
    const body = `
## 规则节
${rules(26, 531)}
`
    const over = frontmatter("prj-manyrules") + padLines(body, 40)
    // 先验证 fixture 本身：行数在线内（40 ≤120），规则 26 >25 → 报的是规则限制
    expect(over.split("\n").length).toBeLessThanOrEqual(120)
    const svc = makeService()
    await expect(svc.compileEntry({ content: over })).rejects.toThrow(/L1_CAPACITY.*26.*25/s)
    expect(fs.existsSync(path.join(root, "projects", "prj-manyrules.md"))).toBe(false)
  })

  it("拒写 ~2000 token 超限词条（100 行长文，行数/规则数在线内，报 token 先到）", async () => {
    const prose = `- 中文长段：编译服务是唯一写入口且失败必须整体回滚不留半成品这是事务性纪律${"补充说明".repeat(12)}`
    const body = `
## 长文节
${rules(10, 561)}

${Array.from({ length: 80 }, () => prose).join("\n")}
`
    const over = frontmatter("prj-tokeny") + padLines(body, 100)
    expect(over.split("\n").length).toBeLessThanOrEqual(120)
    const svc = makeService()
    await expect(svc.compileEntry({ content: over })).rejects.toThrow(/L1_CAPACITY.*2000/s)
  })

  it("L3：单 H2 小节 11 条规则 > 10 → warn 且不阻塞（原型阈值 10）", async () => {
    const body = `
## 拥挤小节
${rules(11)}
`
    const entry = frontmatter("prj-crowded") + padLines(body, 30)
    const svc = makeService()
    const res = await svc.compileEntry({ content: entry })
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(res.warnings.some(w => w.includes("L3") && w.includes("拥挤小节") && w.includes("11"))).toBe(true)
  })

  // ── L5 完整性（prototype: schema·锚点唯一·断链·正文禁日期·禁>20行代码块）──

  it("L5 断链：[[projects/ghost]] 目标不存在 → 拒写且不产生拆分提案", async () => {
    const entry = frontmatter("prj-linker") + `
## 交叉引用
- 参见幽灵词条 [[projects/ghost]] <!--#oct-601-->
`
    const svc = makeService()
    await expect(svc.compileEntry({ content: entry })).rejects.toThrow(/L5_LINK_BROKEN.*projects\/ghost/s)
    expect(fs.existsSync(path.join(root, "projects", "prj-linker.md"))).toBe(false)
    // 票08：pending_review 已退役，无入队语义可断言；拒写零痕迹由上行盘上校验覆盖。
  })

  it("L5 链接目标存在（路径式与裸 id 式）→ 放行，无 L5 打扰", async () => {
    const svc = makeService()
    await svc.compileEntry({ content: frontmatter("prj-target") + `\n## 节\n${rules(1, 611)}\n` })
    const res = await svc.compileEntry({
      content: frontmatter("prj-linker2") + `
## 交叉
- 路径式 [[projects/prj-target]] 与裸 id 式 [[prj-target]] <!--#oct-612-->
`,
    })
    expect(res.warnings.filter(w => w.includes("L5"))).toEqual([])
  })

  it("L5 正文禁日期：非 cases 域正文出现日期 → 拒写（票01 warn 预检升级为闸）", async () => {
    const entry = frontmatter("prj-dated") + `
## 端口规则
- 2026-06-23 那次 CI 挂了 <!--#oct-621-->
`
    const svc = makeService()
    await expect(svc.compileEntry({ content: entry })).rejects.toThrow(/L5_DATES_IN_BODY.*2026-06-23/s)
    expect(fs.existsSync(path.join(root, "projects", "prj-dated.md"))).toBe(false)
  })

  it("L5 日期出现在 [[...]] 链接内不算正文日期；cases 域豁免 L1+日期（票04 接线开关）", async () => {
    const svc = makeService()
    const caseEntry = frontmatter("case-dated", { domain: "cases", title: "pnpm lockfile 不匹配" }) + `
## 现场
- CI 在 2026-06-23 报 LOCKFILE_CONFIG_MISMATCH <!--#oct-631-->

## 修复
${padLines(`- CI 升 pnpm 10 <!--#oct-632-->`, 121)}
`
    // cases：121 行 + 正文日期，两者都豁免 → 放行
    const c = await svc.compileEntry({ content: caseEntry })
    expect(c.commit).toMatch(/^[0-9a-f]{40}$/)

    // 非 cases 词条引用带日期的判例文件名 → 链接内的日期不触发 L5
    const res = await svc.compileEntry({
      content: frontmatter("prj-distilled") + `
## 判例
- 判例见 [[cases/case-dated]] <!--#oct-633-->
`,
    })
    expect(res.warnings.filter(w => w.includes("L5"))).toEqual([])
  })

  it("L5 代码块 >20 行拒写，20 行以内放行（prototype 阈值 20 行）", async () => {
    const block = (n: number) => "```ts\n" + Array.from({ length: n }, (_, i) => `const x${i} = ${i}`).join("\n") + "\n```"
    const over = frontmatter("prj-codey") + `
## 示例
${block(21)}
<!--#oct-641-->
`
    const svc = makeService()
    await expect(svc.compileEntry({ content: over })).rejects.toThrow(/L5_CODE_BLOCK.*20/s)

    const ok = frontmatter("prj-codey2") + `
## 示例
${block(20)}
<!--#oct-642-->
`
    const res = await svc.compileEntry({ content: ok })
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)
  })

  // ── L4 INDEX 预算（prototype: INDEX.md ≤800 token，第一跳成本恒定）──

  it("L4：INDEX 超 800 token 时低频（少规则）词条自动移入 ## Optional，编译仍放行", async () => {
    const svc = makeService()
    // 20 条单规则低频词条 + 10 条三规则高频词条，总量足以冲破 800 token 预算
    for (let i = 0; i < 20; i++) {
      const id = `prj-lo${String(i).padStart(2, "0")}`
      await svc.compileEntry({
        content: frontmatter(id, { summary: "低频词条摘要示例内容刚好凑到预算压力线以上" }) + `\n## 节\n${rules(1, 700 + i)}\n`,
      })
    }
    for (let i = 0; i < 10; i++) {
      const id = `prj-hi${String(i).padStart(2, "0")}`
      await svc.compileEntry({
        content: frontmatter(id, { summary: "高频词条摘要三规则密度高优先留在必选区" }) + `\n## 节\n${rules(3, 750 + i * 3)}\n`,
      })
    }

    const index = fs.readFileSync(path.join(root, "INDEX.md"), "utf-8")
    expect(index).toContain("## Optional")
    const mandatory = index.split("## Optional")[0]
    // 高频（3 规则）留在域节；低频（1 规则）被移出必选区
    expect(mandatory).toContain("projects/prj-hi00.md")
    expect(mandatory).not.toContain("projects/prj-lo00.md")
    expect(index.split("## Optional")[1]).toContain("projects/prj-lo00.md")

    // 预算在重排后回到 800 token 内（闸的口径 = lint.estimateTokens）
    expect(estimateTokens(index)).toBeLessThanOrEqual(800)
  }, 90_000)

  it("L4：重排后仍超预算（病态巨行，过得了 L1 但 Optional 化后 INDEX 仍 >800）→ 拒写 L4_INDEX_BUDGET", async () => {
    const svc = makeService()
    // title+summary 各 900 CJK ≈1840 token：过 L1（<2000）但 INDEX 必选行 900、可选行按 title 渲染仍 900+表头 >800
    const huge = frontmatter("prj-huge", {
      title: "巨".repeat(900),
      summary: "巨".repeat(900),
    }) + `\n## 节\n${rules(1, 790)}\n`
    await expect(svc.compileEntry({ content: huge })).rejects.toThrow(/L4_INDEX_BUDGET/s)
    expect(fs.existsSync(path.join(root, "projects", "prj-huge.md"))).toBe(false)
    expect((db.prepare("SELECT COUNT(*) AS n FROM wiki_articles").get() as { n: number }).n).toBe(0)
  })

  // ── L6 规则形态：编译时 LLM 判定（测试注入 fixture-mocked judge，不连真模型）──

  it("L6：judge 判定描述句 → warn + 改写稿，不阻塞；judge 收到规则原文；无 judge 离线默认零噪音", async () => {
    const seen: Array<{ anchor: string; text: string }> = []
    const judge = async (rs: Array<{ anchor: string; text: string }>) => {
      seen.push(...rs)
      // 原型逐字例：「implement 通常 30min」→ 祈使化建议
      return rs.filter(r => r.text.includes("通常")).map(r => ({ anchor: r.anchor, suggestion: "按 ≥30min 规划预算" }))
    }
    const withJudge = new WikiCompileService({ db, org: "testorg", rootDir: root, git: realGit(root), ruleFormJudge: judge })
    const entry = frontmatter("prj-form") + `
## 估算
- implement 通常 30min <!--#oct-801-->
- 提交前必须跑 pnpm test 全量通过 <!--#oct-802-->
`
    const res = await withJudge.compileEntry({ content: entry })
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/) // warn 级不阻塞
    const l6 = res.warnings.filter(w => w.includes("L6"))
    expect(l6.length).toBe(1)
    expect(l6[0]).toContain("oct-801")
    expect(l6[0]).toContain("按 ≥30min 规划预算")
    // 注入 judge 的输入契约：带锚点的规则行原文（剥离锚点注释）
    expect(seen.map(r => r.anchor).sort()).toEqual(["oct-801", "oct-802"])
    expect(seen.find(r => r.anchor === "oct-801")!.text).toContain("implement 通常 30min")

    // 不注入 judge（离线默认）→ 无 L6 噪音
    const plain = await makeService().compileEntry({
      content: entry.replace("prj-form", "prj-form2").replace("oct-801", "oct-811").replace("oct-802", "oct-812"),
    })
    expect(plain.warnings.filter(w => w.includes("L6"))).toEqual([])
  })
})
