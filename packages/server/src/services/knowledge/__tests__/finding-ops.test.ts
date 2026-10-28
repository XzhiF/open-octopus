import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { applySchema } from "../../../db/schema"
import { FindingsDAO } from "../../../db/dao/findings-dao"
import { KnowledgeEffectivenessDAO } from "../../../db/dao/knowledge-effectiveness-dao"
import { WikiPatrolService } from "../patrol"
import { FindingOpsService, FindingOpsError } from "../findings"
import { CompileQueue } from "../wiki/compile-queue"
import type { GitRunner } from "../wiki/wiki-git"
import type { LLMCall } from "../llm"
import type { KcCardEvent } from "@octopus/shared"

/**
 * 票13 · S1 裁决即编译（finding 卡三钮的服务端行为面）。
 * 真 fs + in-memory DB + 真 git；LLM seam fixture-mocked（spec Testing Decisions）。
 * 三钮：[采纳修订]=入队 finding-fix→唯一写闸编译→resolved+Lane A 回执；
 * [忽略]=ignored 记录在案；[讨论]=零状态变更（纯对话，服务端无动作，由 S4/S2 面钉）。
 */

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

const FROZEN_NOW = () => new Date("2026-10-13T08:00:00.000Z")

let db: Database.Database
let tmpDir: string
let root: string
let wikiRoot: string

function writePage(rel: string, id: string, type: string, topics: string[], links: string[], body: string): void {
  const abs = path.join(wikiRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const linksBlock = links.length > 0 ? `links: [${links.map(l => `[[${l}]]`).join(", ")}]\n` : "links: []\n"
  fs.writeFileSync(abs, [
    "---", `id: ${id}`, `type: ${type}`, `title: ${id} 页`, `summary: ${id} 摘要`,
    `topics: [${topics.join(", ")}]`, "aliases: []", linksBlock + "",
    "last_compiled: 2026-10-12", "sources: []", "---", "", body,
  ].join("\n"), "utf-8")
}

const read = (rel: string) => fs.readFileSync(path.join(wikiRoot, rel), "utf-8")

async function waitFor(predicate: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waitFor 超时")
    await new Promise(r => setTimeout(r, 20))
  }
}

/** 轮询排空队列（setImmediate 起跑；等待终态）。 */
async function drain(queue: CompileQueue): Promise<void> {
  await waitFor(() => queue.depth() === 0)
}

function makePatrol() {
  return new WikiPatrolService({ db, root })
}

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-ops-"))
  root = path.join(tmpDir, "knowledge")
  wikiRoot = path.join(root, "wiki")
  fs.mkdirSync(wikiRoot, { recursive: true })
})

afterEach(() => {
  db?.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("[采纳修订] missing-xref — 确定性编辑：补互链入唯一写闸编译", () => {
  it("adopt → finding-fix 入队 → 两页 links 互含 + 单 commit → resolved + Lane A 回执卡", async () => {
    writePage("concepts/con-a.md", "con-a", "concept", ["knowledge"], [], "## 定义\n\n甲。")
    writePage("concepts/con-b.md", "con-b", "concept", ["knowledge"], [], "## 定义\n\n乙。")
    const report = (await makePatrol().patrol())
    const xref = report.findings.find(f => f.kind === "missing-xref")!
    expect(xref).toBeDefined()

    const queue = new CompileQueue()
    const receipts: KcCardEvent[] = []
    const ops = new FindingOpsService({
      db, root, queue, now: FROZEN_NOW, git: realGit(wikiRoot),
      reportReceipt: (events) => receipts.push(...events),
    })

    const task = ops.adopt(xref.id)
    expect(task.status).toBe("queued")
    await drain(queue)
    const done = ops.getTask(task.id)!
    expect(done.status).toBe("committed")
    expect(done.result?.commit).toMatch(/^[0-9a-f]{40}$/)

    // 编译产物（外部行为：盘 + git + DB）
    expect(read("concepts/con-a.md")).toContain("[[con-b]]")
    expect(read("concepts/con-b.md")).toContain("[[con-a]]")
    const git = realGit(wikiRoot)
    expect(Number(git.run(["rev-list", "--count", "HEAD"]).stdout.trim())).toBeGreaterThanOrEqual(1)
    const log = read("LOG.md")
    expect(log).toContain("## [2026-10-13] compile |")

    // 队列面（票06 纪律：写经 finding-fix kind 入全局队列，旁路=违规）
    expect(queue.list().some(t => t.id === task.id && t.opKind === "finding-fix")).toBe(true)

    // 裁决终态 + Lane A 回执（diff 卡跟随）
    const dao = new FindingsDAO(db)
    expect(dao.getById(xref.id)!.status).toBe("resolved")
    const diff = receipts.find(e => e.kind === "compile-diff")
    expect(diff).toBeDefined()
    expect((diff!.data as { commit?: string }).commit).toBe(done.result?.commit)

    // 修问题=证据消失：二巡不再产该 xref 草案（不是"报了不管"，是图面已闭环）
    const re = (await makePatrol().patrol())
    expect(re.findings.find(f => f.kind === "missing-xref")).toBeUndefined()
    expect(re.findings.find(f => f.id === xref.id)).toBeUndefined()
  })

  it("adopt 不存在的 finding ⇒ NOT_FOUND；已 resolved 再 adopt ⇒ ALREADY", async () => {
    writePage("concepts/con-a.md", "con-a", "concept", ["knowledge"], [], "## 定义\n\n甲。")
    writePage("concepts/con-b.md", "con-b", "concept", ["knowledge"], [], "## 定义\n\n乙。")
    const xref = (await makePatrol().patrol()).findings.find(f => f.kind === "missing-xref")!
    const queue = new CompileQueue()
    const ops = new FindingOpsService({ db, root, queue, now: FROZEN_NOW, git: realGit(wikiRoot) })
    ops.adopt(xref.id)
    await drain(queue)

    const err = (() => { try { ops.adopt(xref.id); return null } catch (e) { return e as FindingOpsError } })()
    expect(err?.code).toBe("FINDING_ALREADY_ADJUDICATED")
    const notFound = (() => { try { ops.adopt("fnd-nonexistent"); return null } catch (e) { return e as FindingOpsError } })()
    expect(notFound?.code).toBe("NOT_FOUND")
  })
})

describe("[采纳修订] contradiction / stale — LLM seam 生成修订稿", () => {
  it("矛盾：LLM 收到双方原文与断言 → 修订稿入队；标记行服务端剥除；锚点丢失 ⇒ 任务 failed 且 finding 留 open", async () => {
    const fid = "fnd-cafe000000000001"
    writePage("topics/top-injection.md", "top-injection", "topic", ["knowledge"], [],
      [
        "## 硬约束",
        "- 规则由引擎预计算注入 <!--#oct-001-->",
        "",
        "## 冲突待裁决",
        `> 【${fid}】与 [[con-compiled-rag]]（concepts/con-compiled-rag.md）冲突：旧断言「规则由引擎预计算注入」↔ 新源断言「应编译成 wiki」。旧断言保留未覆盖——裁决在知识中心对话进行；对质源 sha256 abc…`,
        "",
      ].join("\n"))
    writePage("concepts/con-compiled-rag.md", "con-compiled-rag", "concept", ["knowledge"], ["top-injection"],
      "## 定义\n\n检索重活在编译时。见 [[top-injection]]。")
    const created = (await makePatrol().patrol())
    expect(created.findings.find(f => f.id === fid)?.kind).toBe("contradiction")

    // 失败路径先行：LLM 修订稿丢锚点 ⇒ CURATOR_ANCHOR_REGRESSION 式守门（任务 failed、库不动、finding open）
    const queueBad = new CompileQueue()
    const llmBad: LLMCall = async () => JSON.stringify({
      pages: [
        { relPath: "topics/top-injection.md", body: "## 沿革\n\n注入式已废止，现编译式。" },
        { relPath: "concepts/con-compiled-rag.md", body: "## 定义\n\n检索重活在编译时。见 [[top-injection]]。" },
      ],
    })
    const opsBad = new FindingOpsService({ db, root, queue: queueBad, llm: llmBad, now: FROZEN_NOW, git: realGit(wikiRoot) })
    const badTask = opsBad.adopt(fid)
    await drain(queueBad)
    expect(opsBad.getTask(badTask.id)!.status).toBe("failed")
    expect(opsBad.getTask(badTask.id)!.error?.code).toBe("FINDING_ANCHOR_LOST")
    expect(new FindingsDAO(db).getById(fid)!.status).toBe("open")

    // 成功路径：LLM 保留锚点的历史沿革改写 + prompt 捕获断言
    const prompts: string[] = []
    const llm: LLMCall = async (p) => {
      prompts.push(p)
      return JSON.stringify({
        pages: [
          { relPath: "topics/top-injection.md", body: "## 硬约束\n\n- 规则曾由引擎预计算注入 <!--#oct-001-->（注入式已废止，现编译式，见 [[con-compiled-rag]]）。" },
          { relPath: "concepts/con-compiled-rag.md", body: "## 定义\n\n检索重活在编译时。见 [[top-injection]]。" },
        ],
      })
    }
    const queue = new CompileQueue()
    const receipts: KcCardEvent[] = []
    const ops = new FindingOpsService({ db, root, queue, llm, now: FROZEN_NOW, git: realGit(wikiRoot), reportReceipt: e => receipts.push(...e) })
    const task = ops.adopt(fid)
    await drain(queue)
    const done = ops.getTask(task.id)!
    expect(done.status, JSON.stringify(done.error)).toBe("committed")

    // prompt 证据面（捕获断言）：双方页原文 + 两条断言 + 保留锚点纪律
    expect(prompts[0]).toContain("规则由引擎预计算注入")
    expect(prompts[0]).toContain("应编译成 wiki")
    expect(prompts[0]).toContain("oct-001")
    // 盘产物：旧断言改写 + 本 finding 标记行已剥除（两页都净）
    expect(read("topics/top-injection.md")).toContain("## 硬约束")
    expect(read("topics/top-injection.md")).not.toContain(fid)
    expect(read("concepts/con-compiled-rag.md")).not.toContain(fid)
    expect(new FindingsDAO(db).getById(fid)!.status).toBe("resolved")
    expect(receipts.some(e => e.kind === "compile-diff")).toBe(true)
  })

  it("stale：按上报修订规则行；缺 LLM ⇒ 任务 failed(LLM_UNAVAILABLE) 不静默", async () => {
    writePage("topics/top-ops.md", "top-ops", "topic", ["ops"], [],
      "## 硬约束\n- 修改 shared 后必须先重建再全量构建 <!--#oct-007-->\n")
    db.prepare(`INSERT INTO workspaces (id, name, repo_group, path, created_at, updated_at) VALUES ('ws-1','w','default','/tmp/w','2026-10-12','2026-10-12')`).run()
    db.prepare(
      `INSERT INTO executions (id, org, workspace_id, parent_id, workflow_ref, workflow_name, status, node_type, var_pool, created_at, updated_at)
       VALUES ('e-1','default','ws-1','0','wf','wf','completed','normal',?,'2026-10-12','2026-10-12')`,
    ).run(JSON.stringify({ wiki_refs: ["stale: oct-007 现状：还需先 pnpm install"] }))
    const stale = (await makePatrol().patrol()).findings.find(f => f.kind === "stale")!

    const queueNoLlm = new CompileQueue()
    const opsNoLlm = new FindingOpsService({ db, root, queue: queueNoLlm, now: FROZEN_NOW, git: realGit(wikiRoot) })
    const bad = opsNoLlm.adopt(stale.id)
    await drain(queueNoLlm)
    expect(opsNoLlm.getTask(bad.id)!.error?.code).toBe("LLM_UNAVAILABLE")
    expect(new FindingsDAO(db).getById(stale.id)!.status).toBe("open")

    const queue = new CompileQueue()
    const llm: LLMCall = async (p) => {
      expect(p).toContain("现状：还需先 pnpm install") // 上报说明进 prompt
      return JSON.stringify({
        pages: [{ relPath: "topics/top-ops.md", body: "## 硬约束\n- 修改 shared 后必须先 pnpm install 再重建全量 <!--#oct-007-->\n" }],
      })
    }
    const ops = new FindingOpsService({ db, root, queue, llm, now: FROZEN_NOW, git: realGit(wikiRoot) })
    const task = ops.adopt(stale.id)
    await drain(queue)
    expect(ops.getTask(task.id)!.status).toBe("committed")
    expect(read("topics/top-ops.md")).toContain("pnpm install")
    expect(new FindingsDAO(db).getById(stale.id)!.status).toBe("resolved")
  })
})

describe("[忽略] — 记录在案不再扰", () => {
  it("ignore → status=ignored 持久；重复 ignore/adopt ⇒ ALREADY；未知 ⇒ NOT_FOUND", async () => {
    writePage("concepts/con-a.md", "con-a", "concept", [], [], "## 定义\n\n甲。")
    const orphan = (await makePatrol().patrol()).findings.find(f => f.kind === "orphan")!
    const ops = new FindingOpsService({ db, root, now: FROZEN_NOW, git: realGit(wikiRoot) })
    expect(ops.ignore(orphan.id).status).toBe("ignored")
    expect(new FindingsDAO(db).getById(orphan.id)!.status).toBe("ignored")
    const dup = (() => { try { ops.ignore(orphan.id); return null } catch (e) { return e as FindingOpsError } })()
    expect(dup?.code).toBe("FINDING_ALREADY_ADJUDICATED")
    const adoptIgnored = (() => { try { ops.adopt(orphan.id); return null } catch (e) { return e as FindingOpsError } })()
    expect(adoptIgnored?.code).toBe("FINDING_ALREADY_ADJUDICATED")
  })
})

// ── 票03：index-budget 预警 finding 的采纳链（裁决即编译：经 finding-fix 队列重建 INDEX）──

describe("[采纳修订] index-budget — 预算预警采纳=队列内 INDEX 重建（票03 AC3）", () => {
  function seedIndexBudgetFinding(): string {
    const dao = new FindingsDAO(db)
    const id = "fnd-index-budget-test"
    dao.upsert({
      id,
      kind: "index-budget",
      title: "INDEX 预算预警：恒见部分约 700/800 token（88%）——三选一：移低频页入 ## Optional / 拆分 / hub 化",
      detail: JSON.stringify({ visible_tokens: 700, budget_tokens: 800, warn_threshold_tokens: 640 }),
      pages: JSON.stringify([]),
      raw_ref: "",
      source: "compile",
    })
    return id
  }

  it("在盘 INDEX 缺席/旧形 → adopt → finding-fix 入队 → INDEX 程序化重建单 commit → resolved", async () => {
    writePage("concepts/con-a.md", "con-a", "concept", ["knowledge"], [], "## 定义\n\n甲。")
    const fid = seedIndexBudgetFinding()
    const queue = new CompileQueue()
    const ops = new FindingOpsService({ db, root, queue, now: FROZEN_NOW, git: realGit(wikiRoot) })

    const task = ops.adopt(fid)
    await drain(queue)
    const done = ops.getTask(task.id)!
    expect(done.status).toBe("committed")
    expect(done.result?.commit).toMatch(/^[0-9a-f]{40}$/)

    // 红线1 行为面：写经 finding-fix 队列（旁路直写=违规）
    expect(queue.list().some(t => t.id === task.id && t.opKind === "finding-fix")).toBe(true)

    // 外部产物：INDEX = 程序化重建形（导航协议 + 必读节），LOG 有采纳行，finding resolved
    const index = read("INDEX.md")
    expect(index).toContain("导航协议")
    expect(index).toContain("## 必读")
    expect(index).toContain("concepts/con-a.md")
    expect(read("LOG.md")).toContain("预算预警采纳")
    expect(new FindingsDAO(db).getById(fid)!.status).toBe("resolved")
  })

  it("在盘 INDEX 已收敛 → adopt 空转成功（changed=false 零 commit 零新行）→ 仍 resolved（case-backlog 空转先例同形态）", async () => {
    writePage("concepts/con-a.md", "con-a", "concept", ["knowledge"], [], "## 定义\n\n甲。")
    const fid = seedIndexBudgetFinding()
    // 先把 INDEX 放到收敛态：用服务重建一次（模拟编译通道刚写过）
    const queue = new CompileQueue()
    const ops = new FindingOpsService({ db, root, queue, now: FROZEN_NOW, git: realGit(wikiRoot) })
    const first = ops.adopt(fid)
    await drain(queue)
    expect(ops.getTask(first.id)!.status).toBe("committed")
    // 重置 open 再 adopt：本次应空转（零写零 commit 仍是 committed 终态）
    new FindingsDAO(db).updateStatus(fid, "open")
    const second = ops.adopt(fid)
    await drain(queue)
    const done = ops.getTask(second.id)!
    expect(done.status).toBe("committed")
    expect(done.result?.changed).toBe(false)
    expect(done.result?.commit).toBeNull()
    expect(new FindingsDAO(db).getById(fid)!.status).toBe("resolved")
  })
})

describe("[采纳修订] contradiction 对手页已退役 — 单侧降级（票04 · D-aa16-3 清偿）", () => {
  /** 构造「对手页已退役」现场：活页持标记行，对手页只存在于 _retired/（退役执行体的产物态）。 */
  function seedRetiredCounterpart(fid: string): void {
    writePage("topics/top-live.md", "top-live", "topic", ["probe"], [],
      [
        "## 硬约束",
        "- 活断言：ECONNREFUSED 需先探测端口 <!--#oct-011-->",
        "",
        "## 冲突待裁决",
        `> 【${fid}】与 [[con-gone]]（concepts/con-gone.md）冲突：旧断言「启动必须 pnpm dev --isolated」↔ 新断言「ECONNREFUSED 需探测」。旧断言保留未覆盖——裁决在对话进行`,
        "",
      ].join("\n"))
    const goneAbs = path.join(wikiRoot, "_retired", "concepts")
    fs.mkdirSync(goneAbs, { recursive: true })
    fs.writeFileSync(path.join(goneAbs, "con-gone.md"), [
      "---", "id: con-gone", "type: concept", "title: 已退役对手", "summary: 退役件（D-aa16-3 形状）",
      "topics: [probe]", "links: []", "last_compiled: 2026-10-12", "sources: []", "status: superseded", "---", "",
      "## 定义\n\n旧断言：启动必须 pnpm dev --isolated。\n",
    ].join("\n"), "utf-8")
    new FindingsDAO(db).upsert({
      id: fid, kind: "contradiction", title: `矛盾：concepts/con-gone.md ↔ topics/top-live.md`,
      detail: JSON.stringify({ old_claim: "启动必须 pnpm dev --isolated", new_claim: "ECONNREFUSED 需探测", pages: ["concepts/con-gone.md", "topics/top-live.md"] }),
      pages: JSON.stringify(["concepts/con-gone.md", "topics/top-live.md"]), // 编译侧快照：含退役页原位路径（真盘 fnd-a6f743a4 恒败形）
      raw_ref: "raw/inbox/we04-probe.md", source: "compile",
    })
  }

  it("对手已退役 ⇒ 无 LLM 也 committed：本页标记清除 + LOG 单侧注记 + finding resolved，退役件不动", async () => {
    const fid = "fnd-a6f743a4a5043316" // 真盘恒败标记同形（notes/04 §3.2）
    seedRetiredCounterpart(fid)
    const goneBefore = fs.readFileSync(path.join(wikiRoot, "_retired", "concepts", "con-gone.md"), "utf-8")
    const git = realGit(wikiRoot)
    const before = Number(git.run(["rev-list", "--count", "HEAD"]).stdout.trim() || "0")

    const queue = new CompileQueue()
    const ops = new FindingOpsService({ db, root, queue, now: FROZEN_NOW, git }) // 无 llm——单侧路径不得依赖 LLM（旧恒败点=LLM 之前的 loadWork throw）
    const task = ops.adopt(fid)
    await drain(queue)
    const done = ops.getTask(task.id)!
    expect(done.status, JSON.stringify(done.error)).toBe("committed")

    // 盘产物：本页标记行净洗（含小节剥空），锚点与硬约束行零扰动
    const live = read("topics/top-live.md")
    expect(live).not.toContain(fid)
    expect(live).not.toContain("冲突待裁决")
    expect(live).toContain("<!--#oct-011-->")
    expect(live).toContain("ECONNREFUSED 需先探测端口")

    // LOG 注记（日期宽松：真 today()）
    const log = read("LOG.md")
    expect(log).toMatch(/## \[\d{4}-\d{2}-\d{2}\] compile \| 矛盾：concepts\/con-gone\.md ↔ topics\/top-live\.md/)
    expect(log).toContain("单侧")

    // 裁决闭环 + 退役件不动 + 单 commit 收口
    expect(new FindingsDAO(db).getById(fid)!.status).toBe("resolved")
    expect(fs.readFileSync(path.join(wikiRoot, "_retired", "concepts", "con-gone.md"), "utf-8")).toBe(goneBefore)
    const after = Number(git.run(["rev-list", "--count", "HEAD"]).stdout.trim())
    expect(after).toBeGreaterThanOrEqual(before + 1)
  })

  it("涉事页全退役 ⇒ 空转 committed（零写、finding 归档，不再恒 failed）", async () => {
    const fid = "fnd-bothgone00000001"
    const gone = (dir: string, id: string, rel: string) => {
      const abs = path.join(wikiRoot, "_retired", dir)
      fs.mkdirSync(abs, { recursive: true })
      fs.writeFileSync(path.join(abs, `${id}.md`), [
        "---", `id: ${id}`, "type: concept", `title: ${id}`, "summary: s", "topics: []", "links: []",
        "last_compiled: 2026-10-12", "sources: []", "status: superseded", "---", "", "## 定义\n\n甲。\n",
      ].join("\n"), "utf-8")
      return rel
    }
    const pA = gone("concepts", "con-gone-a", "concepts/con-gone-a.md")
    const pB = gone("concepts", "con-gone-b", "concepts/con-gone-b.md")
    new FindingsDAO(db).upsert({
      id: fid, kind: "contradiction", title: "矛盾：双页皆退役",
      detail: JSON.stringify({ old_claim: "甲", new_claim: "乙" }),
      pages: JSON.stringify([pA, pB]), raw_ref: "raw/inbox/we04-probe.md", source: "compile",
    })
    const git = realGit(wikiRoot)
    const before = Number(git.run(["rev-list", "--count", "HEAD"]).stdout.trim() || "0")

    const queue = new CompileQueue()
    const ops = new FindingOpsService({ db, root, queue, now: FROZEN_NOW, git })
    const task = ops.adopt(fid)
    await drain(queue)
    const done = ops.getTask(task.id)!
    expect(done.status, JSON.stringify(done.error)).toBe("committed")
    expect(done.result?.changed).toBe(false)
    expect(done.result?.commit).toBeNull()
    expect(new FindingsDAO(db).getById(fid)!.status).toBe("resolved")
    expect(Number(git.run(["rev-list", "--count", "HEAD"]).stdout.trim())).toBe(before) // 零 commit（无页可写）
  })

  it("零回归：缺席页非退役（ghost 不在 _retired）⇒ 仍 failed FINDING_TARGET_MISSING，不降级", async () => {
    const fid = "fnd-ghostabsent000001"
    seedRetiredCounterpart(fid)
    // 再造一枚 pages 含真缺席页（concepts/con-ghost.md 原位与 _retired 均无）的矛盾 finding
    new FindingsDAO(db).upsert({
      id: fid + "2", kind: "contradiction", title: "矛盾：对手真缺席",
      detail: JSON.stringify({ old_claim: "甲", new_claim: "乙" }),
      pages: JSON.stringify(["concepts/con-ghost.md", "topics/top-live.md"]),
      raw_ref: "raw/inbox/we04-probe.md", source: "compile",
    })
    const queue = new CompileQueue()
    // LLM 在场也须先炸在 loadWork 闸上（降级判据严格：_retired 无存档的缺席页不属单侧射程）
    const ops = new FindingOpsService({ db, root, queue, now: FROZEN_NOW, git: realGit(wikiRoot), llm: async () => "{}" })
    const task = ops.adopt(fid + "2")
    await drain(queue)
    const done = ops.getTask(task.id)!
    expect(done.status).toBe("failed")
    expect(done.error?.code).toBe("FINDING_TARGET_MISSING")
    expect(new FindingsDAO(db).getById(fid + "2")!.status).toBe("open")
  })
})

describe("[采纳修订] low-confidence — 票07 账目证据进修订稿通道（semanticRevision 第三形态）", () => {
  it("adopt → prompt 含实效账目（引用/helpful/confidence）→ 修订落 commit → resolved", async () => {
    writePage("topics/top-ci.md", "top-ci", "topic", ["ci"], [],
      "## 硬约束\n- 先红后绿再跳闸 <!--#oct-001-->\n")
    const ledger = new KnowledgeEffectivenessDAO(db)
    ledger.upsert("oct-001", { cited_count: 5, helpful_count: 1, not_helpful_count: 4 })
    const finding = (await makePatrol().patrol()).findings.find(f => f.kind === "low-confidence")!
    expect(finding).toBeDefined()

    const prompts: string[] = []
    const llm: LLMCall = async (p) => {
      prompts.push(p)
      return JSON.stringify({
        pages: [{ relPath: "topics/top-ci.md", body: "## 硬约束\n- 修订后的准确纪律 <!--#oct-001-->\n" }],
      })
    }
    const queue = new CompileQueue()
    const ops = new FindingOpsService({ db, root, queue, llm, now: FROZEN_NOW, git: realGit(wikiRoot) })
    const task = ops.adopt(finding.id)
    await drain(queue)
    const done = ops.getTask(task.id)!
    expect(done.status, JSON.stringify(done.error)).toBe("committed")

    // prompt 证据面（独立捕获）：票07 账目数字进处置文案——修订稿作者看得见「为什么低置信」
    expect(prompts[0]).toContain("低置信")
    expect(prompts[0]).toContain("引用 5×")
    expect(prompts[0]).toContain("confidence 0.2")
    // 盘产物：修订落文，锚点原位保留（守门纪律共享）
    expect(read("topics/top-ci.md")).toContain("修订后的准确纪律")
    expect(read("topics/top-ci.md")).toContain("oct-001")
    expect(new FindingsDAO(db).getById(finding.id)!.status).toBe("resolved")
  })

  it("缺 LLM ⇒ 任务 failed(LLM_UNAVAILABLE)、finding 留 open——账目再差也不静默改页（红线2）", async () => {
    writePage("topics/top-ci.md", "top-ci", "topic", ["ci"], [],
      "## 硬约束\n- 先红后绿再跳闸 <!--#oct-001-->\n")
    const ledger = new KnowledgeEffectivenessDAO(db)
    ledger.upsert("oct-001", { cited_count: 5, helpful_count: 0, not_helpful_count: 5 })
    const finding = (await makePatrol().patrol()).findings.find(f => f.kind === "low-confidence")!

    const queue = new CompileQueue()
    const ops = new FindingOpsService({ db, root, queue, now: FROZEN_NOW, git: realGit(wikiRoot) })
    const task = ops.adopt(finding.id)
    await drain(queue)
    const done = ops.getTask(task.id)!
    expect(done.status).toBe("failed")
    expect(done.error?.code).toBe("LLM_UNAVAILABLE")
    expect(new FindingsDAO(db).getById(finding.id)!.status).toBe("open")
    expect(read("topics/top-ci.md")).toContain("先红后绿再跳闸") // 库零动
  })

  it("锚点丢失守门对 low-confidence 同样生效：修订稿掉锚 ⇒ failed(FINDING_ANCHOR_LOST) 库零动", async () => {
    writePage("topics/top-ci.md", "top-ci", "topic", ["ci"], [],
      "## 硬约束\n- 先红后绿再跳闸 <!--#oct-001-->\n")
    const ledger = new KnowledgeEffectivenessDAO(db)
    ledger.upsert("oct-001", { cited_count: 5, helpful_count: 0, not_helpful_count: 5 })
    const finding = (await makePatrol().patrol()).findings.find(f => f.kind === "low-confidence")!

    const queue = new CompileQueue()
    const ops = new FindingOpsService({
      db, root, queue, now: FROZEN_NOW, git: realGit(wikiRoot),
      llm: async () => JSON.stringify({ pages: [{ relPath: "topics/top-ci.md", body: "## 硬约束\n- 锚点没了的修订\n" }] }),
    })
    const task = ops.adopt(finding.id)
    await drain(queue)
    expect(ops.getTask(task.id)!.error?.code).toBe("FINDING_ANCHOR_LOST")
    expect(new FindingsDAO(db).getById(finding.id)!.status).toBe("open")
    expect(read("topics/top-ci.md")).toContain("oct-001")
  })
})

// ── P4 票08：数值处方 adopt 出口 ────────────────────────────────────
// 通道分配（红线2：出口一律人裁后编译，零自动执行）：
//  duplicate ⇒ **确定性合并执行体**（detail.merge_draft 有稿用稿、无稿保守取主条原文——
//    主条归一、对侧原位改指；两锚点都留在原地=wiki_refs 不断链，锚点守门天然满足，零 LLM）；
//  bloat / volatile-expired ⇒ 既有 semanticRevision 修订通道（票07 同款「证据进 prompt」）；
//  zombie / domain-skew ⇒ 响亮 UNSUPPORTED（退役=对话/票09 窄口；hub 化=结构性编辑非本通道）。

function seedFinding(id: string, kind: string, detail: Record<string, unknown>, pages: string[]): void {
  new FindingsDAO(db).upsert({
    id, kind,
    title: `测试 ${kind}`,
    detail: JSON.stringify(detail),
    pages: JSON.stringify(pages),
    raw_ref: "",
    source: "patrol",
  })
}

describe("[采纳修订] duplicate — 票08 确定性合并（主条归一+对侧原位指针，零 LLM）", () => {
  const dupDetail = (draft: string) => ({
    a_page: "topics/top-ma.md", a_anchor: "oct-001", a_text: "提交代码前必须跑 pnpm test 再推送",
    b_page: "topics/top-mb.md", b_anchor: "oct-002", b_text: "提交代码前必须跑 pnpm test 后推送",
    score: 0.8333, merge_draft: draft,
  })

  it("有稿 adopt ⇒ 主条=合并稿、对侧=已并入指针句，两锚点原地保留 → committed → resolved → 二巡不再成对（闭环）", async () => {
    writePage("topics/top-ma.md", "top-ma", "topic", ["ci"], [],
      "## 硬约束\n- 提交代码前必须跑 pnpm test 再推送 <!--#oct-001-->\n")
    writePage("topics/top-mb.md", "top-mb", "topic", ["ci"], [],
      "## 硬约束\n- 提交代码前必须跑 pnpm test 后推送 <!--#oct-002-->\n")
    seedFinding("fnd-dup000000000001", "duplicate", dupDetail("合并稿：提交前须跑 pnpm test 通过再推送"), ["topics/top-ma.md", "topics/top-mb.md"])

    const queue = new CompileQueue()
    const ops = new FindingOpsService({ db, root, queue, now: FROZEN_NOW, git: realGit(wikiRoot) })
    const task = ops.adopt("fnd-dup000000000001")
    await drain(queue)
    const done = ops.getTask(task.id)!
    expect(done.status, JSON.stringify(done.error)).toBe("committed")

    const ma = read("topics/top-ma.md")
    const mb = read("topics/top-mb.md")
    expect(ma).toContain("合并稿：提交前须跑 pnpm test 通过再推送 <!--#oct-001-->") // 主条归一，锚随句
    expect(mb).toContain("[[top-ma]]#oct-001") // 对侧改指主条
    expect(mb).toContain("<!--#oct-002-->")    // 对侧锚点原地保留（永不复用/删除纪律）
    expect(ma).toContain("## 硬约束")
    expect(new FindingsDAO(db).getById("fnd-dup000000000001")!.status).toBe("resolved")

    // 闭环：合并后文本不再近义 ⇒ 二巡该 pair 自然出列（missing-xref 同风格断言）
    const re = (await makePatrol().patrol())
    expect(re.findings.find(f => f.kind === "duplicate")).toBeUndefined()
  })

  it("无稿（seam 诚实缺席形态）adopt ⇒ 保守合并：主条原文不动、对侧仍改指——零 LLM 也能闭环", async () => {
    writePage("topics/top-ma.md", "top-ma", "topic", ["ci"], [],
      "## 硬约束\n- 提交代码前必须跑 pnpm test 再推送 <!--#oct-001-->\n")
    writePage("topics/top-mb.md", "top-mb", "topic", ["ci"], [],
      "## 硬约束\n- 提交代码前必须跑 pnpm test 后推送 <!--#oct-002-->\n")
    seedFinding("fnd-dup000000000002", "duplicate", dupDetail(""), ["topics/top-ma.md", "topics/top-mb.md"])

    const queue = new CompileQueue()
    const ops = new FindingOpsService({ db, root, queue, now: FROZEN_NOW, git: realGit(wikiRoot) })
    const task = ops.adopt("fnd-dup000000000002")
    await drain(queue)
    expect(ops.getTask(task.id)!.status, JSON.stringify(ops.getTask(task.id)!.error)).toBe("committed")
    expect(read("topics/top-ma.md")).toContain("- 提交代码前必须跑 pnpm test 再推送 <!--#oct-001-->")
    expect(read("topics/top-mb.md")).toContain("已并入 [[top-ma]]#oct-001")
  })

  it("涉事页锚点已失（盘被编辑）⇒ 响亮 failed(FINDING_TARGET_MISSING) 库零动，不硬合并", async () => {
    writePage("topics/top-ma.md", "top-ma", "topic", ["ci"], [], "## 硬约束\n- 页已被人工改写 <!--#oct-009-->\n")
    writePage("topics/top-mb.md", "top-mb", "topic", ["ci"], [], "## 硬约束\n- 另一页 <!--#oct-002-->\n")
    seedFinding("fnd-dup000000000003", "duplicate", dupDetail("草稿"), ["topics/top-ma.md", "topics/top-mb.md"])
    const queue = new CompileQueue()
    const ops = new FindingOpsService({ db, root, queue, now: FROZEN_NOW, git: realGit(wikiRoot) })
    const task = ops.adopt("fnd-dup000000000003")
    await drain(queue)
    expect(ops.getTask(task.id)!.error?.code).toBe("FINDING_TARGET_MISSING")
    expect(new FindingsDAO(db).getById("fnd-dup000000000003")!.status).toBe("open")
    expect(read("topics/top-ma.md")).toContain("页已被人工改写")
  })
})

describe("[采纳修订] bloat / volatile-expired — 票08 进既有 semanticRevision 通道", () => {
  it("bloat adopt ⇒ prompt 含容量水位数字 → 瘦身修订稿落盘 → resolved", async () => {
    writePage("topics/top-fat.md", "top-fat", "topic", ["ci"], [],
      "## 硬约束\n- 纪律一 <!--#oct-001-->\n")
    seedFinding("fnd-blo0000000000001", "bloat", { page: "topics/top-fat.md", lines: 110, rules: 1, tokens: 1500, waterline: 0.917 }, ["topics/top-fat.md"])
    const prompts: string[] = []
    const llm: LLMCall = async (p) => {
      prompts.push(p)
      return JSON.stringify({ pages: [{ relPath: "topics/top-fat.md", body: "## 硬约束\n- 瘦身后的准确纪律 <!--#oct-001-->\n" }] })
    }
    const queue = new CompileQueue()
    const ops = new FindingOpsService({ db, root, queue, llm, now: FROZEN_NOW, git: realGit(wikiRoot) })
    const task = ops.adopt("fnd-blo0000000000001")
    await drain(queue)
    expect(ops.getTask(task.id)!.status, JSON.stringify(ops.getTask(task.id)!.error)).toBe("committed")
    expect(prompts[0]).toContain("膨胀")
    expect(prompts[0]).toContain("0.917") // 水位数字进证据面
    expect(read("topics/top-fat.md")).toContain("瘦身后的准确纪律")
    expect(new FindingsDAO(db).getById("fnd-blo0000000000001")!.status).toBe("resolved")
  })

  it("volatile-expired adopt ⇒ 三选一之「改写」案：prompt 含 review_after 与逾期天数，续期/退役不属本通道（注记在证据文案）", async () => {
    writePage("topics/top-v.md", "top-v", "topic", ["ci"], [],
      "## 硬约束\n- 时效规则 <!--#oct-001-->\n")
    seedFinding("fnd-vol0000000000001", "volatile-expired", { page: "topics/top-v.md", review_after: "2026-09-30", overdue_days: 13 }, ["topics/top-v.md"])
    const prompts: string[] = []
    const llm: LLMCall = async (p) => {
      prompts.push(p)
      return JSON.stringify({ pages: [{ relPath: "topics/top-v.md", body: "## 硬约束\n- 按现场改写后的规则 <!--#oct-001-->\n" }] })
    }
    const queue = new CompileQueue()
    const ops = new FindingOpsService({ db, root, queue, llm, now: FROZEN_NOW, git: realGit(wikiRoot) })
    const task = ops.adopt("fnd-vol0000000000001")
    await drain(queue)
    expect(ops.getTask(task.id)!.status, JSON.stringify(ops.getTask(task.id)!.error)).toBe("committed")
    expect(prompts[0]).toContain("2026-09-30")
    expect(prompts[0]).toContain("续期") // 三选一在人裁侧的显形注记
    expect(read("topics/top-v.md")).toContain("按现场改写后的规则")
  })
})

describe("[采纳修订] zombie / domain-skew — 响亮 UNSUPPORTED（红线2 处方≠手术）", () => {
  it("两类 kind adopt ⇒ failed(FINDING_FIX_UNSUPPORTED_KIND)、finding 留 open、库零动——退役走票09/对话，hub 化走对话策展", async () => {
    writePage("topics/top-z.md", "top-z", "topic", ["ci"], [], "## 硬约束\n- 僵尸纪律 <!--#oct-001-->\n")
    seedFinding("fnd-zom0000000000001", "zombie", { page: "topics/top-z.md", basis: "never", dormant_days: 120 }, ["topics/top-z.md"])
    seedFinding("fnd-skew000000000001", "domain-skew", { page: "topics/top-z.md", anchors: 1, total_anchors: 2, share: 0.5 }, ["topics/top-z.md"])
    const queue = new CompileQueue()
    const ops = new FindingOpsService({ db, root, queue, now: FROZEN_NOW, git: realGit(wikiRoot) })
    for (const id of ["fnd-zom0000000000001", "fnd-skew000000000001"]) {
      const task = ops.adopt(id)
      await drain(queue)
      const done = ops.getTask(task.id)!
      expect(done.status).toBe("failed")
      expect(done.error?.code).toBe("FINDING_FIX_UNSUPPORTED_KIND")
      expect(new FindingsDAO(db).getById(id)!.status).toBe("open")
    }
    expect(read("topics/top-z.md")).toContain("僵尸纪律") // 库零动
  })
})
