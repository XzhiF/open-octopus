import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { applySchema } from "../../../db/schema"
import { FindingsDAO } from "../../../db/dao/findings-dao"
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
    const report = makePatrol().patrol()
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
    const re = makePatrol().patrol()
    expect(re.findings.find(f => f.kind === "missing-xref")).toBeUndefined()
    expect(re.findings.find(f => f.id === xref.id)).toBeUndefined()
  })

  it("adopt 不存在的 finding ⇒ NOT_FOUND；已 resolved 再 adopt ⇒ ALREADY", async () => {
    writePage("concepts/con-a.md", "con-a", "concept", ["knowledge"], [], "## 定义\n\n甲。")
    writePage("concepts/con-b.md", "con-b", "concept", ["knowledge"], [], "## 定义\n\n乙。")
    const xref = makePatrol().patrol().findings.find(f => f.kind === "missing-xref")!
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
    const created = makePatrol().patrol()
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
    db.prepare(`INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES ('ws-1','w','default','/tmp/w','2026-10-12','2026-10-12')`).run()
    db.prepare(
      `INSERT INTO executions (id, org, workspace_id, parent_id, workflow_ref, workflow_name, status, node_type, var_pool, created_at, updated_at)
       VALUES ('e-1','default','ws-1','0','wf','wf','completed','normal',?,'2026-10-12','2026-10-12')`,
    ).run(JSON.stringify({ wiki_refs: ["stale: oct-007 现状：还需先 pnpm install"] }))
    const stale = makePatrol().patrol().findings.find(f => f.kind === "stale")!

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
  it("ignore → status=ignored 持久；重复 ignore/adopt ⇒ ALREADY；未知 ⇒ NOT_FOUND", () => {
    writePage("concepts/con-a.md", "con-a", "concept", [], [], "## 定义\n\n甲。")
    const orphan = makePatrol().patrol().findings.find(f => f.kind === "orphan")!
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
