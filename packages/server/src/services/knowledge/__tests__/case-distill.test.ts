// packages/server/src/services/knowledge/__tests__/case-distill.test.ts
//
// P3 票03 — 「判例积压」finding 的采纳蒸馏（S1 裁决即编译，spec 故事 13，票面第 5 行）。
//
// 蒸馏动作复用 finding adopt 通道（findings.ts case-backlog 分支）：
//   产物进 topics 硬约束（锚点栖身「## 硬约束」节，L5 闸同律）· 判例↔规则互指
//   （topic 正文 [[case]] ←→ case.rule_ref=锚点）· case status=distilled ·
//   正文 append-only 零改写。蒸馏**决定面确定性**（规则=判例五段机械提纯，spec「判例是
//   规则的原料」；与 contradiction/stale 的 semanticRevision 分水岭）——aa-fix 项8 后
//   另有可选 LLM seam 只做「流程型」打标（缺席=零标记，不触蒸馏本体）。
//
// expected 真相源：spec 故事 13 + P0 判例 schema；fixture 判例 lesson 内埋日期
// （蒸馏面必须净化，否则 topic 页触 L5_DATES_IN_BODY——蒸馏恒败即缺陷）。

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
import type { GitRunner } from "../wiki/wiki-git"
import type { KcCardEvent } from "@octopus/shared"

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

let db: Database.Database
let tmpDir: string
let root: string
let wikiRoot: string

/** 六查口径的积压判例（open ×3 无 rule_ref；教训带日期=蒸馏净化面 fixture）。 */
function writeBacklogCase(): void {
  const abs = path.join(wikiRoot, "cases", "2026-10-12-case-msys.md")
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, [
    "---", "id: case-msys", "domain: cases", "symptom: Git Bash ref 冒号被转成路径",
    "tags: [windows, gitbash]", "severity: blocker", "occurrences: 3",
    "source: task:199", "status: open", "---", "",
    "## 现场",
    "",
    "2026-09-05 那天 ref 'a:b' 变成了目录 a/b。",
    "",
    "## 诊断",
    "",
    "MSYS 路径转换吃冒号。",
    "",
    "## 根因",
    "",
    "双斜杠规则未覆盖盘符后冒号。",
    "",
    "## 修复",
    "",
    "用 MSYS_NO_PATHCONV=1 前缀。",
    "",
    "## 教训",
    "",
    "Windows 下冒号是保留字符（2026-09-05 复现确认）。",
    "",
  ].join("\n"), "utf-8")
}

const read = (rel: string) => fs.readFileSync(path.join(wikiRoot, rel), "utf-8")

async function drain(queue: CompileQueue): Promise<void> {
  for (let i = 0; i < 500 && queue.depth() > 0; i++) await new Promise(r => setTimeout(r, 20))
}

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aa03-distill-"))
  root = path.join(tmpDir, "knowledge")
  wikiRoot = path.join(root, "wiki")
  fs.mkdirSync(wikiRoot, { recursive: true })
})

afterEach(() => {
  db?.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("case-backlog 采纳蒸馏（S1·票03 第5行：finding adopt 通道复用）", () => {
  it("patrol 产六查 finding → adopt ⇒ 确定性蒸馏：topic 页「硬约束」锚点 + [[case]] 回指、case 翻 distilled+rule_ref（正文逐字不动）、finding resolved、Lane A 回执", async () => {
    writeBacklogCase()
    const report = new WikiPatrolService({ db, root }).patrol()
    const backlog = report.findings.find(f => f.kind === "case-backlog")!
    expect(backlog).toBeDefined()

    const queue = new CompileQueue()
    const receipts: KcCardEvent[] = []
    // 不注入 llm——蒸馏必须确定性（注入面缺席照跑 = 与 semanticRevision 的分水岭）
    const ops = new FindingOpsService({
      db, root, queue, git: realGit(wikiRoot),
      reportReceipt: (events) => receipts.push(...events),
    })

    const task = ops.adopt(backlog.id)
    await drain(queue)
    const done = ops.getTask(task.id)!
    expect(done.status, JSON.stringify(done.error ?? {})).toBe("committed")

    // topic 产物：锚点栖身硬约束节（L5 闸形态）；回指判例 [[case-msys]]；零日期（净化面）
    const topics = fs.readdirSync(path.join(wikiRoot, "topics")).filter(n => n.endsWith(".md"))
    expect(topics).toHaveLength(1)
    const topic = read(`topics/${topics[0]}`)
    expect(topic).toMatch(/## 硬约束/)
    expect(topic).toMatch(/<!--#oct-\d{3}-->/)
    expect(topic).toContain("[[case-msys]]")
    expect(topic).toContain("Git Bash ref 冒号被转成路径")
    // L5 日期净化：判例教训里的 2026-09-05 不得抄进常青 topic 页正文
    // （front-matter last_compiled 是合法编译日，不在净化面——断言盯正文段）
    const topicBody = topic.slice(topic.indexOf("---", 3) + 3)
    expect(topicBody).not.toMatch(/20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}/)
    expect(topicBody).toContain("Windows 下冒号是保留字符")

    // 判例↔规则互指 + 状态翻转（append-only 面：仅 status/rule_ref/occurrences 可变）
    const caseText = read("cases/2026-10-12-case-msys.md")
    expect(caseText).toMatch(/status: distilled/)
    const anchor = /<!--#(oct-\d{3})-->/.exec(topic)![1]!
    expect(caseText).toContain(`rule_ref: ${anchor}`)
    // 正文五段逐字保留（蒸馏不改写判例历史）
    expect(caseText).toContain("2026-09-05 那天 ref 'a:b' 变成了目录 a/b。")
    expect(caseText).toContain("occurrences: 3")

    // 裁决即编译闭环：finding resolved + 回执双卡（diff 跟随 + finding 终态）
    expect(new FindingsDAO(db).getById(backlog.id)!.status).toBe("resolved")
    expect(receipts.some(e => e.kind === "compile-diff")).toBe(true)
    const findingCard = receipts.find(e => e.kind === "finding")
    expect((findingCard!.data as { status: string }).status).toBe("resolved")

    // 证据闭环：蒸馏后再巡，判例已出列（六查不再产同 id 草案）
    const re = new WikiPatrolService({ db, root }).patrol()
    expect(re.findings.find(f => f.kind === "case-backlog")).toBeUndefined()
  })

  it("adopt 时目标判例已被外部蒸馏（open→distilled 竞态）⇒ 幂等空转成功：零 topic 新页、finding resolved、不抛穿", async () => {
    writeBacklogCase()
    // 第二条积压判例（模拟并发：finding 已报，尚未裁决）
    const absB = path.join(wikiRoot, "cases", "2026-10-13-case-b.md")
    fs.writeFileSync(absB, [
      "---", "id: case-b", "domain: cases", "symptom: 端口占用假死", "tags: [net]", "severity: major",
      "occurrences: 2", "source: exec:b1", "status: open", "---", "",
      "## 现场", "", "bind 报占用。", "", "## 诊断", "", "孤儿进程。", "", "## 根因", "", "拆机未杀净。",
      "", "## 修复", "", "kill:port 清。", "", "## 教训", "", "拆机要杀净。", "",
    ].join("\n"), "utf-8")

    const report = new WikiPatrolService({ db, root }).patrol()
    const backlog = report.findings.filter(f => f.kind === "case-backlog")
    expect(backlog).toHaveLength(2)

    const queue = new CompileQueue()
    const ops = new FindingOpsService({ db, root, queue, git: realGit(wikiRoot) })
    // A 正常蒸馏（先落一笔 topic）
    const ta = ops.adopt(backlog[0]!.id)
    await drain(queue)
    expect(ops.getTask(ta.id)!.status).toBe("committed")
    const topicsAfterA = fs.readdirSync(path.join(wikiRoot, "topics"))
    expect(topicsAfterA).toHaveLength(1)

    // B 在裁决前被外部通道翻成 distilled（竞态面）：B 的 finding 仍 open
    fs.writeFileSync(absB, read("cases/2026-10-13-case-b.md")
      .replace("status: open", "status: distilled\nrule_ref: oct-888"))

    const tb = ops.adopt(backlog[1]!.id)
    await drain(queue)
    expect(ops.getTask(tb.id)!.status, JSON.stringify(ops.getTask(tb.id)!.error ?? {})).toBe("committed")
    // 幂等：不再产生第二个 topic 页（目标已非 open ⇒ 蒸馏空转）
    expect(fs.readdirSync(path.join(wikiRoot, "topics"))).toEqual(topicsAfterA)
    // B 文件未被二次改写（rule_ref 仍=外部值）
    expect(read("cases/2026-10-13-case-b.md")).toContain("rule_ref: oct-888")
    expect(new FindingsDAO(db).getById(backlog[1]!.id)!.status).toBe("resolved")
  })

  it("蒸馏产物经写闸：队列面 opKind=finding-fix；旁路断言=盘上除 topic/case/LOG/INDEX/git 外零触碰（raw 不动）", async () => {
    writeBacklogCase()
    fs.mkdirSync(path.join(root, "raw", "inbox"), { recursive: true })
    fs.writeFileSync(path.join(root, "raw", "inbox", "keep.md"), "# 不动我\n", "utf-8")
    const backlog = new WikiPatrolService({ db, root }).patrol().findings.find(f => f.kind === "case-backlog")!

    const queue = new CompileQueue()
    const ops = new FindingOpsService({ db, root, queue, git: realGit(wikiRoot) })
    const task = ops.adopt(backlog.id)
    await drain(queue)

    expect(queue.list().some(t => t.id === task.id && t.opKind === "finding-fix")).toBe(true)
    expect(fs.readFileSync(path.join(root, "raw", "inbox", "keep.md"), "utf-8")).toBe("# 不动我\n")
  })

  // ── aa-fix 项8：蒸馏「流程型」标记写侧（spec 三路之b 契约面，LLM seam 判定）──
  describe("蒸馏流程型标记（adopt→distill 产物生成处打标，distilled 面可查）", () => {
    it("seam 判流程型 ⇒ 蒸馏判例带 procedural: true；判定 prompt 携五段（现场/…/教训）与症状", async () => {
      writeBacklogCase()
      const backlog = new WikiPatrolService({ db, root }).patrol().findings.find(f => f.kind === "case-backlog")!
      const queue = new CompileQueue()
      const prompts: string[] = []
      const ops = new FindingOpsService({
        db, root, queue, git: realGit(wikiRoot),
        llm: async (p) => { prompts.push(p); return '{"procedural": true}' },
      })
      const task = ops.adopt(backlog.id)
      await drain(queue)
      expect(ops.getTask(task.id)!.status, JSON.stringify(ops.getTask(task.id)!.error ?? {})).toBe("committed")

      const caseText = read("cases/2026-10-12-case-msys.md")
      expect(caseText).toMatch(/status: distilled/)
      expect(caseText).toContain("procedural: true")
      // 判定面=五段内容（spec 三路之b「按五段/教训内容」）：症状+修复+教训段进 prompt
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain("Git Bash ref 冒号被转成路径")
      expect(prompts[0]).toContain("MSYS_NO_PATHCONV=1")
      expect(prompts[0]).toContain("冒号是保留字符")
    })

    it("seam 判陈述型 ⇒ procedural: false 显式记录（b 路不再词表兜底翻案）", async () => {
      writeBacklogCase()
      const backlog = new WikiPatrolService({ db, root }).patrol().findings.find(f => f.kind === "case-backlog")!
      const queue = new CompileQueue()
      const ops = new FindingOpsService({
        db, root, queue, git: realGit(wikiRoot),
        llm: async () => '{"procedural": false}',
      })
      ops.adopt(backlog.id)
      await drain(queue)
      expect(read("cases/2026-10-12-case-msys.md")).toContain("procedural: false")
    })

    it("seam 坏形/炸 ⇒ 零标记（诚实缺席=词表兜底位）且蒸馏本体照committed——标记失败不毁裁决链", async () => {
      writeBacklogCase()
      const backlog = new WikiPatrolService({ db, root }).patrol().findings.find(f => f.kind === "case-backlog")!
      const queue = new CompileQueue()
      const ops = new FindingOpsService({
        db, root, queue, git: realGit(wikiRoot),
        llm: async () => "（模型没按契约回 JSON）",
      })
      const task = ops.adopt(backlog.id)
      await drain(queue)
      expect(ops.getTask(task.id)!.status).toBe("committed")
      const caseText = read("cases/2026-10-12-case-msys.md")
      expect(caseText).toMatch(/status: distilled/)
      expect(caseText).not.toContain("procedural:")
    })
  })
})
