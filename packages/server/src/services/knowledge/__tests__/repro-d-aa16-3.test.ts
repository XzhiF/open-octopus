/**
 * 票04 · 复现靶真验 — D-aa16-3（P3 E2E DEFER · 退役死链 + 矛盾 adopt 恒败）。
 * 形状复刻真盘现场（notes/04 §3.2，**零触真知识根**）：
 *   活页 topics/prj-open-octopus.md 持链 [[top-dev-port-and-stale-lock]]（links 数组 +
 *   两条正文引用 + 三条矛盾标记行）+ 恒败 finding fnd-a6f743a4a5043316（pages 快照含已退役对手）。
 * 症状一（死链潜伏）：旧形态=只迁页不清链 ⇒ L5 扫描显形断链；新机械=退役执行体统一机械
 *   ⇒ 退役后全库活链零潜伏（AC13/AC15）。
 * 症状二（矛盾 adopt 恒败）：对手页已退役 ⇒ 单侧裁决 committed，其余未裁决标记不误伤。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { applySchema } from "../../../db/schema"
import { FindingsDAO } from "../../../db/dao/findings-dao"
import { WikiPatrolService } from "../patrol"
import { FindingOpsService } from "../findings"
import { CompileQueue } from "../wiki/compile-queue"
import { PageRetireTaskService, type PageRetireTaskRecord } from "../wiki/page-retire"
import { scanWikiEntries } from "../wiki/compile"
import { resolveWikiLink, WIKILINK_RE } from "../wiki/lint"
import type { GitRunner } from "../wiki/wiki-git"

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})
const FROZEN = () => new Date("2026-10-15T08:00:00.000Z")

// ── 真盘现场形状（prj-hub 四链三标 + 被退役目标） ──
const GONE_ID = "top-dev-port-and-stale-lock"
const GONE_REL = "topics/top-dev-port-and-stale-lock.md"
const FND_ADOPT = "fnd-a6f743a4a5043316" // 真盘恒败枚 id 形状（notes/04 §3.2）
const FND_OTHERS = ["fnd-7695a097c4a0cd5f", "fnd-9073e3b45f3e2db8"]

const HUB_BODY = [
  "## 项目导航",
  "- dev 环境端口空转与陈旧锁的探测/自愈纪律：[[" + GONE_ID + "]]。",
  "",
  "## 沿革",
  `- [[${GONE_ID}]] 记载的一手自愈路径（迁移现场）——矛盾上报：见编译 findings。`,
  "",
  "## 冲突待裁决",
  ...[FND_OTHERS[0], FND_OTHERS[1], FND_ADOPT].map(fid =>
    `> 【${fid}】与 [[${GONE_ID}]]（${GONE_REL}）冲突：旧断言「启动必须 pnpm dev --isolated」↔ 新断言「ECONNREFUSED 127.0.0.1:3001 先探测」`,
  ),
  "",
].join("\n")

const HUB_RAW = [
  "---", "id: prj-open-octopus", "type: entity", "entity_kind: project", "title: Octopus 项目页",
  "summary: 复现靶宿主——真盘 prj-open-octopus.md 形状复刻", "topics: [octopus]", "aliases: []",
  `links: [[top-workflow-node-yaml-view], [wf-prd-impl], [${GONE_ID}]]`,
  "last_compiled: 2026-10-14", "sources: [raw/inbox/we04-probe.md]", "---", "", HUB_BODY,
].join("\n")

const GONE_RAW = [
  "---", "id: top-dev-port-and-stale-lock", "type: topic", "title: dev 端口与陈旧锁",
  "summary: 被退役的纪律页（真盘 5814abd 形状）", "topics: [octopus]", "aliases: []", "links: []",
  "last_compiled: 2026-10-13", "sources: [raw/inbox/we04-probe.md]", "---", "",
  "## 硬约束",
  "- 端口空转先 netstat 探测再拆锁 <!--#oct-009-->",
  "",
].join("\n")

const KEEP_A_RAW = [
  "---", "id: top-workflow-node-yaml-view", "type: topic", "title: 工作流节点 YAML 视图",
  "summary: 无关在册页一", "topics: [octopus]", "aliases: []", "links: []",
  "last_compiled: 2026-10-13", "sources: []", "---", "", "## 定义\n\n甲页。\n",
].join("\n")
const KEEP_B_RAW = [
  "---", "id: wf-prd-impl", "type: topic", "title: PRD 实现流",
  "summary: 无关在册页二", "topics: [octopus]", "aliases: []", "links: [[top-workflow-node-yaml-view]]",
  "last_compiled: 2026-10-13", "sources: []", "---", "", "## 定义\n\n乙页，引用 [[top-workflow-node-yaml-view]]。\n",
].join("\n")

let db: Database.Database
let tmpDir: string
let knowledgeRoot: string
let wikiRoot: string
let git: GitRunner

function seedLibrary(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "we04-repro-"))
  knowledgeRoot = path.join(tmpDir, "knowledge")
  wikiRoot = path.join(knowledgeRoot, "wiki")
  fs.mkdirSync(path.join(wikiRoot, "topics"), { recursive: true })
  fs.mkdirSync(path.join(wikiRoot, "entities"), { recursive: true })
  fs.mkdirSync(path.join(wikiRoot, "_retired"), { recursive: true })
  fs.writeFileSync(path.join(wikiRoot, "entities", "prj-open-octopus.md"), HUB_RAW, "utf-8")
  fs.writeFileSync(path.join(wikiRoot, "topics", "top-dev-port-and-stale-lock.md"), GONE_RAW, "utf-8")
  fs.writeFileSync(path.join(wikiRoot, "topics", "top-workflow-node-yaml-view.md"), KEEP_A_RAW, "utf-8")
  fs.writeFileSync(path.join(wikiRoot, "topics", "wf-prd-impl.md"), KEEP_B_RAW, "utf-8")
  git = realGit(wikiRoot)
  git.run(["init"])
  git.run(["config", "user.email", "we04@test.local"])
  git.run(["config", "user.name", "we04-test"])
  git.run(["config", "core.autocrlf", "false"])
  git.run(["add", "-A"])
  git.run(["commit", "-m", "seed: 复现靶库（真盘形状，tmpdir 复刻）"])
  // 三枚矛盾 finding（编译侧快照形：pages=[旧页, 新页]，E4 恒败之因）
  const dao = new FindingsDAO(db)
  for (const fid of [FND_OTHERS[0], FND_OTHERS[1], FND_ADOPT]) {
    dao.upsert({
      id: fid, kind: "contradiction", title: `矛盾：${GONE_REL} ↔ entities/prj-open-octopus.md（${fid}）`,
      detail: JSON.stringify({ old_claim: "启动必须 pnpm dev --isolated", new_claim: "ECONNREFUSED 先探测" }),
      pages: JSON.stringify([GONE_REL, "entities/prj-open-octopus.md"]),
      raw_ref: "raw/inbox/we04-probe.md", source: "compile",
    })
  }
}

/** L5 零潜伏扫描：全库活页正文 [[链接]] 中不可解析者（形状同 lint L5_LINK_BROKEN）。 */
function scanBroken(): string[] {
  const entries = scanWikiEntries(wikiRoot)
  const corpus = entries.map(e => ({ id: e.meta.id, path: e.relPath }))
  const broken: string[] = []
  for (const e of entries) {
    const raw = fs.readFileSync(path.join(wikiRoot, e.relPath), "utf-8")
    const body = raw.split("---\n")[2] ?? raw
    for (const m of body.matchAll(WIKILINK_RE)) {
      const t = (m[1] ?? "").trim()
      if (t && !resolveWikiLink(t, wikiRoot, corpus)) broken.push(`${e.relPath}: [[${t}]]`)
    }
  }
  return broken
}

async function settle(svc: PageRetireTaskService, id: string, capMs = 8000): Promise<PageRetireTaskRecord> {
  const start = Date.now()
  for (;;) {
    const rec = svc.get(id)
    if (rec && (rec.status === "committed" || rec.status === "failed")) return rec
    if (Date.now() - start > capMs) throw new Error(`retire task ${id} did not settle: ${JSON.stringify(rec)}`)
    await new Promise(r => setTimeout(r, 20))
  }
}

async function drain(queue: CompileQueue, capMs = 15000): Promise<void> {
  const start = Date.now()
  while (queue.depth() !== 0) {
    if (Date.now() - start > capMs) throw new Error("drain 超时")
    await new Promise(r => setTimeout(r, 20))
  }
}

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
})
afterEach(() => {
  db?.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("D-aa16-3 复现靶 — 退役死链 + 矛盾 adopt 恒败（票04 对靶真验）", () => {
  it("症状一潜伏显形（旧形态对照）：只迁页不清链 ⇒ L5 扫描见活链指向 _retired 页", () => {
    seedLibrary()
    // 复刻票08 旧执行体产物：手工迁 _retired/ + 注 superseded（不清链、不动 DB）
    fs.mkdirSync(path.join(wikiRoot, "_retired", "topics"), { recursive: true })
    const moved = GONE_RAW.replace("last_compiled: 2026-10-13", "last_compiled: 2026-10-13\nstatus: superseded")
    fs.writeFileSync(path.join(wikiRoot, "_retired", "topics", "top-dev-port-and-stale-lock.md"), moved, "utf-8")
    fs.rmSync(path.join(wikiRoot, "topics", "top-dev-port-and-stale-lock.md"))

    const broken = scanBroken()
    // 现场复现（E4 实测形状）：宿主活链全断——延迟爆炸型地雷
    expect(broken).toEqual(expect.arrayContaining([
      "entities/prj-open-octopus.md: [[" + GONE_ID + "]]",
    ]))
    expect(broken.filter(b => b.includes(GONE_ID))).toHaveLength(5) // 正文两条 + 三条矛盾标记行各一（真盘 prj-hub :18/:21/:24-26 同形）
    expect(broken.every(b => b.startsWith("entities/prj-open-octopus.md"))).toBe(true) // 全在宿主一页
    expect(broken.some(b => !b.includes(GONE_ID))).toBe(false) // 其余活链健康
  })

  it("症状一清偿（新机械）：统一退役执行体 ⇒ 入链摘除 + 全库零潜伏断链", async () => {
    seedLibrary()
    const svc = new PageRetireTaskService({ db, root: knowledgeRoot, git, now: FROZEN })
    const rec = svc.retire({ path: GONE_REL, reason: "D-aa16-3 清偿" })
    const done = await settle(svc, rec.id)
    expect(done.status, JSON.stringify(done.error)).toBe("committed")
    expect(done.result?.inboundCleaned).toEqual(["entities/prj-open-octopus.md"])

    // 宿主入链：links 项摘除 + 正文链指针对文本；标记行保留（未裁决，另路处理）
    const hub = fs.readFileSync(path.join(wikiRoot, "entities", "prj-open-octopus.md"), "utf-8")
    expect(hub).not.toContain(`[[${GONE_ID}]]`)
    expect(hub).toContain("[已退役]")
    expect(hub).toMatch(/^links: \[\[top-workflow-node-yaml-view\], \[wf-prd-impl\]\]$/m)
    for (const fid of [FND_OTHERS[0], FND_OTHERS[1], FND_ADOPT]) expect(hub).toContain(fid) // 标记仍在（裁决动线未折）

    // L5 零潜伏：退役执行后全库活链扫描无指向 _retired 页的断链
    expect(scanBroken()).toEqual([])
  })

  it("症状二清偿：对手页已退役的恒败 finding adopt ⇒ 单侧裁决 committed，未裁决标记不误伤", async () => {
    seedLibrary()
    // 先走新机械退役（症状一清偿后态：宿主已无死链，标记行 [[gone]] 已成 [已退役]）
    const retireSvc = new PageRetireTaskService({ db, root: knowledgeRoot, git, now: FROZEN })
    const retired = await settle(retireSvc, retireSvc.retire({ path: GONE_REL }).id)
    expect(retired.status, JSON.stringify(retired.error)).toBe("committed")

    // E4 恒败现场：adopt fnd-a6f743a4a5043316（无 LLM——单侧降级不依赖模型）
    const queue = new CompileQueue()
    const ops = new FindingOpsService({ db, root: knowledgeRoot, queue, now: FROZEN, git })
    const task = ops.adopt(FND_ADOPT)
    await drain(queue)
    const done = ops.getTask(task.id)!
    expect(done.status, JSON.stringify(done.error)).toBe("committed") // 修复前=failed「涉事页不在盘」

    expect(new FindingsDAO(db).getById(FND_ADOPT)!.status).toBe("resolved")
    const hub = fs.readFileSync(path.join(wikiRoot, "entities", "prj-open-octopus.md"), "utf-8")
    expect(hub).not.toContain(FND_ADOPT) // 本枚标记行净洗
    for (const fid of FND_OTHERS) expect(hub).toContain(fid) // 其余两枚未裁 ⇒ 保留
    expect(scanBroken()).toEqual([]) // 裁决后仍零潜伏（L5 闸过）

    // 巡检复报面闭环：标记已清 ⇒ patrol 不再恢复该 finding（复报证据行消失）
    const rePatrol = new WikiPatrolService({ db, root: knowledgeRoot }).patrol()
    expect(rePatrol.findings.some(f => f.id === FND_ADOPT)).toBe(false)
  })
})
