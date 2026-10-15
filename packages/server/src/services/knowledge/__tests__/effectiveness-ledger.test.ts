import { describe, it, expect, afterEach, beforeEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../../db/schema"
import { KnowledgeEffectivenessDAO } from "../../../db/dao/knowledge-effectiveness-dao"

/**
 * S1（票06 AC2/AC3 + spec Testing Decisions「JSONL fixture→记账断言」）——
 * EffectivenessLedgerService 公开面：parse() 吃「DB executions 行 + 执行 JSONL +
 * 知识根页文件」三输入，吐 LedgerReport；断言只看 DB 行（账目/游标）与报告形状。
 *
 * fixture 制式整族复用 wiki-refs-persistence.test.ts 先例：var_pool 形状对齐真实
 * 执行行（kc15 分支库实测：wiki_refs 数组含 `页#锚` / stale 前缀项）；JSONL 行形
 * 对齐 logger.ts:110（{timestamp,nodeId,event,toolName,input(JSON 字符串)…}）。
 * 期望账目全部来自构造 fixture 的已知真相（独立源），禁自算。
 */

let tmpRoot: string
let db: Database.Database
let dao: KnowledgeEffectivenessDAO

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eff-ledger-"))
  db = new Database(":memory:")
  applySchema(db)
  dao = new KnowledgeEffectivenessDAO(db)
})

afterEach(() => {
  db?.close()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

/** 造一个「工作区目录 + logs/{execId}/*.jsonl + 知识根」的现场。 */
function makeWorkspace(opts: { id: string; execId: string; varPool: string; jsonl?: Record<string, string[]>; createdAt?: string; completedAt?: string }): string {
  const wsPath = path.join(tmpRoot, "ws", opts.id)
  fs.mkdirSync(path.join(wsPath, "logs", opts.execId), { recursive: true })
  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, 'x', ?, ?, ?)",
  ).run(opts.id, opts.id, wsPath.replace(/\\/g, "/"), "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z")
  db.prepare(
    `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, var_pool, org, created_at, updated_at, completed_at)
     VALUES (?, ?, 'w.yaml', 'w', 'completed', ?, 'x', ?, ?, ?)`,
  ).run(opts.execId, opts.id, opts.varPool, opts.createdAt ?? "2026-10-13T15:46:00Z", opts.completedAt ?? "2026-10-13T15:49:00Z", opts.completedAt ?? "2026-10-13T15:49:00Z")
  for (const [file, lines] of Object.entries(opts.jsonl ?? {})) {
    fs.writeFileSync(path.join(wsPath, "logs", opts.execId, file), lines.join("\n") + "\n", "utf-8")
  }
  return wsPath
}

function makeWikiPage(rel: string, body: string): string {
  const p = path.join(tmpRoot, "kb", "wiki", rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body, "utf-8")
  return p
}

const TOPIC_PAGE = `---
id: wf-prd-impl
type: topic
title: prd-impl 工作流知识
summary: s
topics: [prd-impl]
---
## 硬约束
- 修改 shared/ 后无需手动 build（watch 模式自动重建） <!--#oct-008-->
- 实现 PRD 后先 pnpm test 再 pnpm build <!--#oct-014-->
- dev/prod 端口不同，切模式先清旧进程 <!--#oct-015-->
`
const ENTITY_PAGE = `---
id: prj-open-octopus
type: entity
title: open-octopus 仓库
summary: s
topics: [octopus]
---
## 硬约束
- 启动开发必须 pnpm dev --isolated 避免撞保护端口 <!--#oct-007-->
`

function readLine(ts: string, node: string, filePath: string): string {
  return JSON.stringify({
    timestamp: ts,
    nodeId: node,
    event: "tool_call",
    toolCallId: "toolu_x",
    toolName: "Read",
    input: JSON.stringify({ file_path: filePath }),
    result: null,
    isError: false,
    startedAt: ts,
    completedAt: ts,
  })
}

describe("EffectivenessLedgerService · 引用记账面（S1）", () => {
  it("wiki_refs 锚点逐锚落账：页#锚 归一为锚点键、stale 项同锚并计、裸锚/页形照收；游标推进", async () => {
    const { EffectivenessLedgerService } = await import("../effectiveness-ledger")
    makeWikiPage("topics/wf-prd-impl.md", TOPIC_PAGE)
    makeWikiPage("entities/prj-open-octopus.md", ENTITY_PAGE)
    // kc15 真实 var_pool 形制（分支库实测行）
    makeWorkspace({
      id: "kc16",
      execId: "exec-a",
      varPool: JSON.stringify({
        wiki_refs: [
          "prj-open-octopus#oct-007",
          "wf-prd-impl#oct-015",
          "wf-prd-impl#oct-014",
          "wf-prd-impl#oct-008",
          "stale:wf-prd-impl#oct-008 当前已改 watch 模式无需手动 build",
        ],
      }),
    })

    const svc = new EffectivenessLedgerService({ db, root: path.join(tmpRoot, "kb"), now: () => new Date("2026-10-15T03:17:00Z") })
    const report = await svc.parse()

    expect(report.scanned).toBe(1)
    // 4 锚点：oct-007/008/014/015；stale 项的锚与正常引用同键 ⇒ 同执行并为一谈（计 1）
    expect(report.citations).toBe(4)
    for (const anchor of ["oct-007", "oct-008", "oct-014", "oct-015"]) {
      const row = dao.getByRuleId(anchor)
      expect(row?.cited_count).toBe(1)
      // 时刻=执行完成时刻（重放确定，非挂钟）
      expect(row?.last_cited).toBe("2026-10-13T15:49:00Z")
    }
    // 游标记至 execution
    const cur = db.prepare("SELECT * FROM effectiveness_cursors WHERE execution_id = ?").get("exec-a") as Record<string, unknown>
    expect(cur.citations).toBe(4)
    expect(cur.parsed_at).toBe("2026-10-15T03:17:00.000Z")
  })

  it("重跑幂等：第二次 parse scanned=0 零重复记账（红线6 游标面）", async () => {
    const { EffectivenessLedgerService } = await import("../effectiveness-ledger")
    makeWikiPage("topics/wf-prd-impl.md", TOPIC_PAGE)
    makeWorkspace({
      id: "kc17",
      execId: "exec-b",
      varPool: JSON.stringify({ wiki_refs: ["wf-prd-impl#oct-014"] }),
    })
    const svc = new EffectivenessLedgerService({ db, root: path.join(tmpRoot, "kb"), now: () => new Date("2026-10-15T03:17:00Z") })
    await svc.parse()
    const second = await svc.parse()
    expect(second.scanned).toBe(0)
    expect(second.citations).toBe(0)
    expect(dao.getByRuleId("oct-014")?.cited_count).toBe(1)
  })

  it("wiki 页 Read 工具调用页级记账：INDEX.md 与仓外文件不计；同执行同页去重", async () => {
    const { EffectivenessLedgerService } = await import("../effectiveness-ledger")
    makeWikiPage("topics/wf-prd-impl.md", TOPIC_PAGE)
    const wikiRoot = path.join(tmpRoot, "kb", "wiki")
    makeWorkspace({
      id: "kc18",
      execId: "exec-c",
      varPool: JSON.stringify({ execution_name: "x" }),
      jsonl: {
        "wiki-consume.jsonl": [
          JSON.stringify({ timestamp: "2026-10-13T15:46:44.053Z", nodeId: "wiki-consume", event: "start", workflow: "w" }),
          readLine("2026-10-13T15:46:44.053Z", "wiki-consume", path.join(wikiRoot, "INDEX.md").replace(/\\/g, "/")),
          readLine("2026-10-13T15:46:50.000Z", "wiki-consume", path.join(wikiRoot, "topics", "wf-prd-impl.md").replace(/\\/g, "/")),
          readLine("2026-10-13T15:47:00.000Z", "wiki-consume", path.join(wikiRoot, "topics", "wf-prd-impl.md").replace(/\\/g, "/")),
          readLine("2026-10-13T15:47:10.000Z", "wiki-consume", "C:/xzf/ai/open-octopus/CLAUDE.md"),
          JSON.stringify({ timestamp: "x", nodeId: "n", event: "not-json" }),
        ],
      },
    })

    const svc = new EffectivenessLedgerService({ db, root: path.join(tmpRoot, "kb"), now: () => new Date("2026-10-15T03:17:00Z") })
    const report = await svc.parse()

    expect(report.scanned).toBe(1)
    expect(report.citations).toBe(1)
    // 页级键 = 文件名 stem（实证 == front-matter id）
    const row = dao.getByRuleId("wf-prd-impl")
    expect(row?.cited_count).toBe(1)
    expect(dao.getByRuleId("INDEX")).toBeUndefined()
  })

  it("坏 var_pool / 缺日志目录：诚实留警告，游标仍推进（不反复重解析）", async () => {
    const { EffectivenessLedgerService } = await import("../effectiveness-ledger")
    makeWikiPage("topics/wf-prd-impl.md", TOPIC_PAGE)
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES ('kc19','kc19','x','/nonexistent-dir-xyz','2026-10-01','2026-10-01')",
    ).run()
    db.prepare(
      "INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, var_pool, org, created_at, updated_at) VALUES ('exec-d','kc19','w.yaml','w','completed','{oops','x','2026-10-13T15:46:00Z','2026-10-13T15:49:00Z')",
    ).run()

    const svc = new EffectivenessLedgerService({ db, root: path.join(tmpRoot, "kb"), now: () => new Date("2026-10-15T03:17:00Z") })
    const report = await svc.parse()

    expect(report.scanned).toBe(1)
    expect(report.citations).toBe(0)
    expect(report.warnings.join("\n")).toContain("exec-d")
    // 游标推进 ⇒ 下轮不再重碰这行
    const second = await svc.parse()
    expect(second.scanned).toBe(0)
  })

  it("裸库诚实零：无 pending 执行 ⇒ 全零报告，不炸", async () => {
    const { EffectivenessLedgerService } = await import("../effectiveness-ledger")
    const svc = new EffectivenessLedgerService({ db, root: path.join(tmpRoot, "kb"), now: () => new Date() })
    const report = await svc.parse()
    expect(report.scanned).toBe(0)
    expect(report.citations).toBe(0)
    expect(report.helpful).toBe(0)
    expect(report.notHelpful).toBe(0)
  })
})

describe("EffectivenessLedgerService · blocker↔锚点关联判定（LLM seam，S1）", () => {
  /** 现场：一次执行 = 引两锚 + review_blockers 两条。 */
  function makeLinkExec(execId: string): void {
    db.prepare(
      "INSERT OR IGNORE INTO workspaces (id, name, org, path, created_at, updated_at) VALUES ('lnk','lnk','x',?, '2026-10-01','2026-10-01')",
    ).run(path.join(tmpRoot, "ws", "lnk").replace(/\\/g, "/"))
    db.prepare(
      `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, var_pool, org, created_at, updated_at, completed_at)
       VALUES (?, 'lnk', 'w.yaml', 'w', 'completed', ?, 'x', '2026-10-13T15:46:00Z', '2026-10-13T15:49:00Z', '2026-10-13T15:49:00Z')`,
    ).run(execId, JSON.stringify({
      wiki_refs: ["wf-prd-impl#oct-008", "prj-open-octopus#oct-007"],
      review_blockers: ["shared 改完下游拿到旧产物，需要手动 pnpm build", "登录接口 500"],
    }))
  }

  it("helpful/not_helpful 落账 + prompt 契约捕获（锚 token、规则原文、blocker 全文在场）", async () => {
    const { EffectivenessLedgerService } = await import("../effectiveness-ledger")
    makeWikiPage("topics/wf-prd-impl.md", TOPIC_PAGE)
    makeWikiPage("entities/prj-open-octopus.md", ENTITY_PAGE)
    makeLinkExec("exec-link-1")

    const prompts: string[] = []
    const llm = async (prompt: string): Promise<string> => {
      prompts.push(prompt)
      return '{"verdicts":[{"anchor":"oct-008","relation":"not_helpful"},{"anchor":"oct-007","relation":"helpful"}]}'
    }
    const svc = new EffectivenessLedgerService({ db, root: path.join(tmpRoot, "kb"), llm, now: () => new Date("2026-10-15T03:17:00Z") })
    const report = await svc.parse()

    expect(report.helpful).toBe(1)
    expect(report.notHelpful).toBe(1)
    const r8 = dao.getByRuleId("oct-008")
    expect(r8?.cited_count).toBe(1)
    expect(r8?.not_helpful_count).toBe(1)
    expect(r8?.helpful_count).toBe(0)
    const r7 = dao.getByRuleId("oct-007")
    expect(r7?.helpful_count).toBe(1)

    // seam 契约（prompt 捕获钉法=archive-ingest.test.ts:167-176 先例）：输入证据在场
    expect(prompts).toHaveLength(1)
    const p = prompts[0]
    expect(p).toContain("oct-008")
    expect(p).toContain("watch 模式自动重建") // 规则原文行（wiki/lint.ts ruleLinesForFormCheck 同族取数）
    expect(p).toContain("shared 改完下游拿到旧产物，需要手动 pnpm build") // blocker 原文
    // 判定结果只从 verdicts 读，不复活任何词面匹配（红线3 负断言：prompt 无相似度/阈值字样）
    expect(p).not.toMatch(/阈值|相似度|重叠率/)
    // 游标摘要
    const cur = db.prepare("SELECT * FROM effectiveness_cursors WHERE execution_id = ?").get("exec-link-1") as Record<string, unknown>
    expect(cur.link_status).toBe("judged")
    expect(cur.helpful).toBe(1)
    expect(cur.not_helpful).toBe(1)
  })

  it("unrelated/漏判不计数；越权锚（非本执行引用）忽略", async () => {
    const { EffectivenessLedgerService } = await import("../effectiveness-ledger")
    makeWikiPage("topics/wf-prd-impl.md", TOPIC_PAGE)
    makeLinkExec("exec-link-2")
    const llm = async (): Promise<string> =>
      '{"verdicts":[{"anchor":"oct-008","relation":"unrelated"},{"anchor":"oct-999","relation":"helpful"}]}'
    const svc = new EffectivenessLedgerService({ db, root: path.join(tmpRoot, "kb"), llm, now: () => new Date("2026-10-15T03:17:00Z") })
    const report = await svc.parse()
    expect(report.helpful).toBe(0)
    expect(report.notHelpful).toBe(0)
    expect(dao.getByRuleId("oct-008")?.helpful_count).toBe(0)
    expect(dao.getByRuleId("oct-008")?.not_helpful_count).toBe(0)
    expect(dao.getByRuleId("oct-999")).toBeUndefined() // 判定不建行（引用面才是建行通道）
  })

  it("无 blocker 执行：不调 LLM、link_status 空（判定对象不存在≠缺席）", async () => {
    const { EffectivenessLedgerService } = await import("../effectiveness-ledger")
    makeWikiPage("topics/wf-prd-impl.md", TOPIC_PAGE)
    makeWorkspace({ id: "nb", execId: "exec-nb", varPool: JSON.stringify({ wiki_refs: ["wf-prd-impl#oct-014"] }) })
    let called = 0
    const svc = new EffectivenessLedgerService({
      db, root: path.join(tmpRoot, "kb"), now: () => new Date(),
      llm: async () => { called++; return "{}" },
    })
    const report = await svc.parse()
    expect(called).toBe(0)
    expect(report.citations).toBe(1)
    const cur = db.prepare("SELECT * FROM effectiveness_cursors WHERE execution_id = ?").get("exec-nb") as Record<string, unknown>
    expect(cur.link_status).toBe("")
  })

  it("诚实缺席族：seam 缺席/空响应/坏 JSON/抛 ⇒ 引用账不毁、判定零落、码族显形", async () => {
    const { EffectivenessLedgerService } = await import("../effectiveness-ledger")
    makeWikiPage("topics/wf-prd-impl.md", TOPIC_PAGE)
    makeWikiPage("entities/prj-open-octopus.md", ENTITY_PAGE)

    // a) seam 缺席（deps.llm undefined）
    makeLinkExec("exec-skip-nollm")
    let svc = new EffectivenessLedgerService({ db, root: path.join(tmpRoot, "kb"), now: () => new Date() })
    let report = await svc.parse()
    expect(report.linkSkips["no_llm"]).toBe(1)
    expect(report.citations).toBe(2) // 引用面照常
    expect(dao.getByRuleId("oct-008")?.cited_count).toBe(1)
    expect(dao.getByRuleId("oct-008")?.helpful_count).toBe(0)
    expect((db.prepare("SELECT link_status FROM effectiveness_cursors WHERE execution_id = ?").get("exec-skip-nollm") as { link_status: string }).link_status).toBe("skipped:no_llm")

    // b) 空响应（生产离线闸恒空串形态——llm.ts:74-76 语义）
    makeLinkExec("exec-skip-empty")
    svc = new EffectivenessLedgerService({ db, root: path.join(tmpRoot, "kb"), llm: async () => "", now: () => new Date() })
    report = await svc.parse()
    expect(report.linkSkips["empty"]).toBe(1)
    expect(dao.getByRuleId("oct-008")?.cited_count).toBe(2)
    expect((db.prepare("SELECT link_status FROM effectiveness_cursors WHERE execution_id = ?").get("exec-skip-empty") as { link_status: string }).link_status).toBe("skipped:empty")

    // c) 坏 JSON
    makeLinkExec("exec-skip-badjson")
    svc = new EffectivenessLedgerService({ db, root: path.join(tmpRoot, "kb"), llm: async () => "判定结果：都不错", now: () => new Date() })
    report = await svc.parse()
    expect(report.linkSkips["bad_json"]).toBe(1)
    expect(dao.getByRuleId("oct-008")?.cited_count).toBe(3)

    // d) 抛错（provider 炸）
    makeLinkExec("exec-skip-boom")
    svc = new EffectivenessLedgerService({
      db, root: path.join(tmpRoot, "kb"), now: () => new Date(),
      llm: async () => { throw new Error("provider down") },
    })
    report = await svc.parse()
    expect(report.linkSkips["error"]).toBe(1)
    expect(dao.getByRuleId("oct-008")?.cited_count).toBe(4)
    expect(dao.getByRuleId("oct-008")?.helpful_count).toBe(0)
  })

  it("review_blockers 双形读取：native 数组 ∨ JSON 字符串数组；坏形条目诚实弃", async () => {
    const { EffectivenessLedgerService } = await import("../effectiveness-ledger")
    makeWikiPage("topics/wf-prd-impl.md", TOPIC_PAGE)
    // 形一：字符串化数组（archive.ts:58-63 旧消费形制）
    db.prepare("INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES ('dual','dual','x','/none','2026-10-01','2026-10-01')").run()
    db.prepare(
      `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, var_pool, org, created_at, updated_at, completed_at)
       VALUES ('exec-dual','dual','w.yaml','w','completed',?,'x','2026-10-13T15:00:00Z','2026-10-13T15:10:00Z','2026-10-13T15:10:00Z')`,
    ).run(JSON.stringify({ wiki_refs: ["wf-prd-impl#oct-014"], review_blockers: JSON.stringify(["端口被占，dev 起不来"]) }))
    // 形二 + 坏条目混入：native 数组含非 string 项
    db.prepare("INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, var_pool, org, created_at, updated_at, completed_at) VALUES ('exec-dual2','dual','w.yaml','w','completed',?,'x','2026-10-13T15:11:00Z','2026-10-13T15:20:00Z','2026-10-13T15:20:00Z')")
      .run(JSON.stringify({ wiki_refs: ["wf-prd-impl#oct-015"], review_blockers: ["test 顺序违规", 42, null] }))

    const seenBlockers: string[] = []
    const svc = new EffectivenessLedgerService({
      db, root: path.join(tmpRoot, "kb"), now: () => new Date(),
      llm: async (prompt: string) => { seenBlockers.push(prompt); return '{"verdicts":[]}' },
    })
    const report = await svc.parse()
    expect(report.scanned).toBe(2)
    expect(seenBlockers).toHaveLength(2)
    expect(seenBlockers[0]).toContain("端口被占，dev 起不来")
    expect(seenBlockers[1]).toContain("test 顺序违规")
    expect(seenBlockers[1]).not.toMatch(/\b42\b/) // 坏条目不进 prompt
  })
})
