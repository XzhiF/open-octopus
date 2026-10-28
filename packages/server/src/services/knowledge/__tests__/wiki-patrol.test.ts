import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../../db/schema"
import { FindingsDAO } from "../../../db/dao/findings-dao"
import { WikiPatrolService } from "../patrol"

/**
 * 票13 · S1 语义巡检五查（真 fs+DB 遍历 v3 库，环级）。
 * Expected 独立真相源：票面 AC1 五查定义 + 票05 矛盾标记行模板 + octo-wiki skill 的
 * stale 上报形态（"stale: oct-009 与代码现状矛盾"）。fixture 页为手写 v3 front-matter
 * 字面量（format.ts 可解析形态），不从实现反推。
 */

let db: Database.Database
let tmpDir: string
let root: string
let wikiRoot: string

/** v3 页字面量（links 走 YAML 嵌套式；正文可含 [[链接]]/矛盾标记）。 */
function page(rel: string, id: string, type: string, topics: string[], links: string[], body: string): void {
  const abs = path.join(wikiRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const linksBlock = links.length > 0 ? `links: [${links.map(l => `[[${l}]]`).join(", ")}]\n` : "links: []\n"
  fs.writeFileSync(abs, [
    "---",
    `id: ${id}`,
    `type: ${type}`,
    `title: ${id} 页`,
    `summary: ${id} 的摘要`,
    `topics: [${topics.join(", ")}]`,
    "aliases: []",
    linksBlock + "",
    "last_compiled: 2026-10-12",
    "sources: [raw/inbox/seed.md]",
    "---",
    "",
    body,
  ].join("\n"), "utf-8")
}

function seedExecVarPool(execId: string, refs: string[]): void {
  db.prepare(
    `INSERT INTO executions (id, org, workspace_id, parent_id, workflow_ref, workflow_name, status, node_type, var_pool, created_at, updated_at)
     VALUES (?, 'default', 'ws-1', '0', 'wf', 'wf', 'completed', 'normal', ?, '2026-10-12 08:00:00', '2026-10-12 08:00:00')`,
  ).run(execId, JSON.stringify({ wiki_refs: refs }))
}

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  db.prepare(
    `INSERT INTO workspaces (id, name, repo_group, path, created_at, updated_at) VALUES ('ws-1', 'patrol-ws', 'default', '/tmp/patrol-ws', '2026-10-12 08:00:00', '2026-10-12 08:00:00')`,
  ).run()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-patrol-"))
  root = path.join(tmpDir, "knowledge")
  wikiRoot = path.join(root, "wiki")
  fs.mkdirSync(wikiRoot, { recursive: true })
})

afterEach(() => {
  db?.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makePatrol() {
  return new WikiPatrolService({ db, root })
}

describe("巡检④ 被提及但缺页的概念（[[链接]] 指向不存在页）", () => {
  it("零入链引用缺失目标产 finding；重跑幂等不重复不重报", async () => {
    page("concepts/con-compiled-rag.md", "con-compiled-rag", "concept", ["rag"], ["con-ghost"],
      "## 定义\n\n检索的重活在编译时。参见 [[con-ghost]] 的辨析。")

    const res = (await makePatrol().patrol())

    const missing = res.findings.filter(f => f.kind === "missing-page")
    expect(missing).toHaveLength(1)
    expect(missing[0].target).toBe("con-ghost")
    expect(missing[0].hosts).toEqual(["concepts/con-compiled-rag.md"])

    const dao = new FindingsDAO(db)
    const rows = dao.list("open").filter(r => r.kind === "missing-page")
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe("patrol")
    expect(rows[0].title).toContain("con-ghost")
    expect(rows[0].id).toMatch(/^fnd-[0-9a-f]{16}$/)
    expect(JSON.parse(rows[0].pages)).toEqual(["concepts/con-compiled-rag.md"])

    // 幂等重跑：行数不变、id 不变、证据未变 ⇒ 本轮动作 = unchanged（零写）
    const id1 = rows[0].id
    const res2 = (await makePatrol().patrol())
    const again = res2.findings.find(f => f.kind === "missing-page")
    expect(again?.action).toBe("unchanged")
    expect(dao.list("open").filter(r => r.kind === "missing-page")).toHaveLength(1)
    expect(dao.getById(id1)).toBeDefined()
  })

  it("目标存在（front-matter links 或正文 [[链接]] 命中现库页）⇒ 不产 finding", async () => {
    page("entities/ent-karpathy.md", "ent-karpathy", "entity", [], [],
      "## 概述\n\n提出三层架构。")
    page("concepts/con-compiled-rag.md", "con-compiled-rag", "concept", ["rag"], ["ent-karpathy"],
      "## 定义\n\n参见 [[ent-karpathy]]。")

    const res = (await makePatrol().patrol())
    expect(res.findings.filter(f => f.kind === "missing-page")).toHaveLength(0)
    expect(new FindingsDAO(db).list("open").filter(r => r.kind === "missing-page")).toHaveLength(0)
  })
})

describe("巡检③ 孤儿页（零入链）", () => {
  it("不被任何其它内容页引用 ⇒ orphan；被 concept 页正文引用/被自己的 sources 回执页引用都不算解除孤儿", async () => {
    // 孤儿：没有任何内容页引用它
    page("entities/ent-hermes.md", "ent-hermes", "entity", ["notify"], [],
      "## 概述\n\n通知通道。")
    // 有入链的页：被下面 concept 页 [[引用]]
    page("concepts/con-compiled-rag.md", "con-compiled-rag", "concept", ["rag"], [],
      "## 定义\n\n见 [[ent-karpathy]]。")
    page("entities/ent-karpathy.md", "ent-karpathy", "entity", [], [],
      "## 概述\n\n提出三层架构。")
    // sources 回执页引用 con-compiled-rag —— 回执页不算入链方（否则每个编译页永远不孤儿）
    page("sources/2026-10-13-seed.md", "src-seed", "source", [], ["con-compiled-rag"],
      "## 回指 raw\n- raw: raw/inbox/seed.md")

    const res = (await makePatrol().patrol())
    const orphans = res.findings.filter(f => f.kind === "orphan")
    // ent-hermes 无人引用；con-compiled-rag 只被 sources 回执页引用（回执不算入链方）也孤儿；
    // ent-karpathy 被 con-compiled-rag 正文 [[引用]] ⇒ 不孤儿
    const orphanPages = new Set(orphans.flatMap(o => o.pages))
    expect(orphanPages).toEqual(new Set(["entities/ent-hermes.md", "concepts/con-compiled-rag.md"]))
    expect(orphans.every(o => o.title.includes("孤儿页"))).toBe(true)

    const dao = new FindingsDAO(db)
    const rows = dao.list("open").filter(r => r.kind === "orphan")
    expect(rows).toHaveLength(2)
    expect(JSON.parse(rows.find(r => r.pages.includes("ent-hermes"))!.detail)).toEqual({ page: "entities/ent-hermes.md" })

    // 幂等：重跑不重复
    const res2 = (await makePatrol().patrol())
    expect(res2.findings.filter(f => f.kind === "orphan").every(f => f.action === "unchanged")).toBe(true)
  })

  it("_retired/ 退役区不参与孤儿判定（既不判孤儿也不作入链方）", async () => {
    page("_retired/v2/old-entry.md", "old-entry", "topic", [], [],
      "## 旧文\n\n引用 [[ent-hermes]]。")
    page("entities/ent-hermes.md", "ent-hermes", "entity", [], [],
      "## 概述\n\n只有退役页引用我。")

    const res = (await makePatrol().patrol())
    const orphans = res.findings.filter(f => f.kind === "orphan")
    expect(orphans).toHaveLength(1)
    expect(orphans[0].pages).toEqual(["entities/ent-hermes.md"])
  })
})

describe("巡检① 页间矛盾（断言对立）：盘上「冲突待裁决」标记 ↔ findings 表对账复报", () => {
  /**
   * 票05 编译通道的标记行模板（curator.ts appendContradictionMarker 调用点逐字）。
   * DB（findings）只是索引、fs 是证据真源：DB 被清/搬家 ⇒ 巡检按标记复报。
   */
  function seedMarkedPages(fid: string): void {
    page("topics/top-injection.md", "top-injection", "topic", ["knowledge"], [],
      [
        "## 定义",
        "规则由引擎预计算注入。",
        "",
        "## 冲突待裁决",
        `> 【${fid}】与 [[con-compiled-rag]]（concepts/con-compiled-rag.md）冲突：旧断言「规则由引擎预计算注入」↔ 新源断言「注入式冷启动重推导，应编译成 wiki」。旧断言保留未覆盖——裁决（采纳修订/忽略/讨论）在知识中心对话进行；对质源 sha256 4f2a9c123456…（对质指针见本页 front-matter sources）`,
        "",
      ].join("\n"))
    page("concepts/con-compiled-rag.md", "con-compiled-rag", "concept", ["knowledge"], ["top-injection"],
      "## 定义\n\n检索重活在编译时。")
  }

  it("findings 表缺席 ⇒ 按标记复报（复用标记内 id，与编译通道天然同址）", async () => {
    const fid = "fnd-0123456789abcdef"
    seedMarkedPages(fid)

    const res = (await makePatrol().patrol())
    const contra = res.findings.filter(f => f.kind === "contradiction")
    expect(contra).toHaveLength(1)
    expect(contra[0].id).toBe(fid) // id 直接取标记内 fnd-（内容寻址由编译通道锚定，巡检复报不换址）
    expect(contra[0].action).toBe("created")

    const dao = new FindingsDAO(db)
    const row = dao.getById(fid)!
    expect(row.kind).toBe("contradiction")
    expect(row.source).toBe("patrol")
    const detail = JSON.parse(row.detail)
    expect(detail.old_claim).toBe("规则由引擎预计算注入")
    expect(detail.new_claim).toBe("注入式冷启动重推导，应编译成 wiki")
    expect(new Set(JSON.parse(row.pages) as string[])).toEqual(new Set(["topics/top-injection.md", "concepts/con-compiled-rag.md"]))
  })

  it("两页各有标记 ⇒ 同一 finding 只一条（按 id 去重）；重跑 unchanged", async () => {
    const fid = "fnd-fedcba9876543210"
    seedMarkedPages(fid)
    // 新页侧也挂标记（curator 双页标记形态）
    fs.appendFileSync(path.join(wikiRoot, "concepts/con-compiled-rag.md"),
      `\n## 冲突待裁决\n> 【${fid}】与旧页 topics/top-injection.md 冲突：旧断言「规则由引擎预计算注入」↔ 新断言「注入式冷启动重推导，应编译成 wiki」。\n`, "utf-8")

    const res = (await makePatrol().patrol())
    expect(res.findings.filter(f => f.kind === "contradiction")).toHaveLength(1)
    const res2 = (await makePatrol().patrol())
    expect(res2.findings.filter(f => f.kind === "contradiction")[0]!.action).toBe("unchanged")
    const dao = new FindingsDAO(db)
    // 本 fixture 两页互链、无缺页无 stale ⇒ 全库只此一条 finding
    expect(dao.list()).toHaveLength(1)
    expect(dao.list().filter(r => r.kind === "contradiction")).toHaveLength(1)
  })

  it("已裁决（resolved/ignored）的标记不再扰；编译通道既有行不被巡检改写", async () => {
    const fid = "fnd-aaaa0000bbbb1111"
    seedMarkedPages(fid)
    const dao = new FindingsDAO(db)
    // 编译通道先落的行（source=compile、detail 带 raw 指针）——巡检不得覆盖其证据面
    dao.upsert({ id: fid, kind: "contradiction", title: "矛盾：编译通道原文", detail: JSON.stringify({ old_claim: "甲", new_claim: "乙", raw: { path: "raw/inbox/x.md", hash: "deadbeef" } }), pages: JSON.stringify(["topics/top-injection.md", "concepts/con-compiled-rag.md"]), raw_ref: "raw/inbox/x.md", source: "compile" })
    void (await makePatrol().patrol())
    expect(dao.getById(fid)!.title).toBe("矛盾：编译通道原文") // 既有 open 行 ⇒ 不动（跨通道证据不复写）

    dao.updateStatus(fid, "ignored")
    const res2 = (await makePatrol().patrol())
    expect(res2.findings.filter(f => f.kind === "contradiction")[0]!.action).toBe("suppressed")
    expect(dao.getById(fid)!.status).toBe("ignored")
  })
})

describe("巡检② stale 断言（消费侧 wiki_refs 的 stale: 上报 → finding，故事 29 闭环）", () => {
  /** octo-wiki 引用纪律形态的 topic 页（锚点活在硬约束小节）。 */
  function seedTopicPage(): void {
    page("topics/top-ops.md", "top-ops", "topic", ["ops"], [],
      "## 硬约束\n- 修改 shared 后必须先重建再全量构建 <!--#oct-007-->\n- 读白名单约束 <!--#oct-012-->\n")
  }

  it("stale: 行按锚点归属页产 finding；非 stale 的 wiki_refs 零产出（窄口纪律）", async () => {
    seedTopicPage()
    // 同执行还有正常查阅记录 —— 不得转成任何回填/页 finding（执行侧产出只走 stale 信道）
    seedExecVarPool("exec-1", ["top-ops#oct-012", "stale: oct-007 与代码现状矛盾：CI 已换构建序"])

    const res = (await makePatrol().patrol())
    const stale = res.findings.filter(f => f.kind === "stale")
    expect(stale).toHaveLength(1)
    expect(stale[0].pages).toEqual(["topics/top-ops.md"])

    const dao = new FindingsDAO(db)
    const row = dao.list("open").find(r => r.kind === "stale")!
    expect(row.source).toBe("patrol")
    expect(row.title).toContain("oct-007")
    const detail = JSON.parse(row.detail)
    expect(detail.anchor).toBe("oct-007")
    expect(detail.executions).toEqual(["exec-1"])
    expect(detail.note).toContain("与代码现状矛盾")

    // 消费记录（非 stale）零转写：除孤儿/缺页类图 finding 外，不因 wiki_refs 生新页/回填
    const rawDir = path.join(root, "raw")
    expect(fs.existsSync(rawDir)).toBe(false)
  })

  it("多次上报同一锚 ⇒ 同一 finding 刷新证据并入新执行号；ignored 后不再扰", async () => {
    seedTopicPage()
    seedExecVarPool("exec-1", ["stale: oct-007 说法一"])
    void (await makePatrol().patrol())

    seedExecVarPool("exec-2", ["stale: top-ops#oct-007 说法二"]) // 页id#锚形态 = 同归属
    const res2 = (await makePatrol().patrol())
    const stale2 = res2.findings.filter(f => f.kind === "stale")
    expect(stale2).toHaveLength(1)
    expect(stale2[0].action).toBe("refreshed")
    const dao = new FindingsDAO(db)
    const detail = JSON.parse(dao.list("open").find(r => r.kind === "stale")!.detail)
    expect(detail.executions).toEqual(["exec-1", "exec-2"])

    // 忽略 ⇒ 记录在案不再扰：新上报也不重报（suppressed），status 不回 open
    dao.updateStatus(stale2[0].id, "ignored")
    seedExecVarPool("exec-3", ["stale: oct-007 说法三"])
    const res3 = (await makePatrol().patrol())
    expect(res3.findings.filter(f => f.kind === "stale")[0]!.action).toBe("suppressed")
    expect(dao.getById(stale2[0].id)!.status).toBe("ignored")
  })

  it("stale 目标解析不到页/锚 ⇒ 诚实 warning，不造 finding", async () => {
    seedTopicPage()
    seedExecVarPool("exec-ghost", ["stale: oct-999 不存在的锚"])
    const res = (await makePatrol().patrol())
    expect(res.findings.filter(f => f.kind === "stale")).toHaveLength(0)
    expect(res.warnings.some(w => w.includes("oct-999"))).toBe(true)
  })
})

describe("巡检⑤ 缺失交叉引用（同类页共享 topic 却互不链接）", () => {
  it("两个 concept 页同 topic 互不链 ⇒ 一条建议对；已互链/不同 topic/跨类不报；重算同 id", async () => {
    // 该报：同 topic 互不链的一对
    page("concepts/con-a.md", "con-a", "concept", ["knowledge"], [], "## 定义\n\n甲。")
    page("concepts/con-b.md", "con-b", "concept", ["knowledge"], [], "## 定义\n\n乙。")
    // 不该报：同 topic（独立标签组）但已互链
    page("concepts/con-c.md", "con-c", "concept", ["sop"], ["con-d"], "## 定义\n\n丙，见 [[con-d]]。")
    page("concepts/con-d.md", "con-d", "concept", ["sop"], ["con-c"], "## 定义\n\n丁，见 [[con-c]]。")
    // 不该报：topic 同词但跨类
    page("topics/top-x.md", "top-x", "topic", ["knowledge"], [], "## SOP\n\n×。")
    page("concepts/con-e.md", "con-e", "concept", ["solo"], [], "## 定义\n\n戊（无同 topic 同类页）。")

    const res = (await makePatrol().patrol())
    const xrefs = res.findings.filter(f => f.kind === "missing-xref")
    expect(xrefs).toHaveLength(1)
    expect(new Set(xrefs[0].pages)).toEqual(new Set(["concepts/con-a.md", "concepts/con-b.md"]))
    expect(xrefs[0].title).toContain("互链")

    const dao = new FindingsDAO(db)
    const rows = dao.list("open").filter(r => r.kind === "missing-xref")
    expect(rows).toHaveLength(1)
    const detail = JSON.parse(rows[0].detail)
    // 建议对独立真相源：按页 id 字典序钉（a 前 b 后）
    expect(detail).toMatchObject({ a: "concepts/con-a.md", b: "concepts/con-b.md", shared_topics: ["knowledge"] })

    const res2 = (await makePatrol().patrol())
    expect(res2.findings.find(f => f.kind === "missing-xref")?.action).toBe("unchanged")
    expect(res2.findings.find(f => f.kind === "missing-xref")?.id).toBe(rows[0].id)
  })
})
