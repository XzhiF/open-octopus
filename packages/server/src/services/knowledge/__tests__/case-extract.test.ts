// packages/server/src/services/knowledge/__tests__/case-extract.test.ts
//
// P3 票03 — 判例自动提取 + 自动入档（S1 服务层，spec 故事 8-10/14，票面清单 1-2/6 行）。
//
// Seam（票面钉 S1）：CaseExtractService.extractAndEnqueue(taskId) —
//   素材包读源（exec-jsonl-excerpt + phase-rejections）→ LLM seam 产五段草案 →
//   enqueue("case-archive") 经唯一写闸编译进 cases/ → 判例卡通告（先存后知）。
// 真 fs+tmpdir（知识根含 wiki git 仓）+ 内存 sqlite+applySchema + seam mock。
// 涉 git ⇒ 按本机纪律 PowerShell 跑。expected 真相源：spec §判例自动提取 + P0 判例
// schema（shared wiki.ts），非实现反推。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../../db/schema"
import { CompileQueue } from "../wiki/compile-queue"
import { freezePackItem, writePackManifest } from "../material-pack"
import { CaseExtractService, type CaseExtractDeps, buildCaseExtractPrompt, CASE_EXTRACT_QUEUE_ID_PREFIX } from "../case-extract-service"

// ── Harness ───────────────────────────────────────────────────────────

let tmpRoot: string
let knowledgeRoot: string
let db: Database.Database
let queue: CompileQueue

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aa03-case-"))
  knowledgeRoot = path.join(tmpRoot, "knowledge")
  db = new Database(":memory:")
  applySchema(db)
  queue = new CompileQueue()
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

/** 票02 冻结契约的包 fixture：直接落两件提取源素材（其余件非本票依赖面）。 */
function seedPack(taskId: string, items: Array<{ fileName: string; kind: string; payload: string }>): void {
  const manifest = { v: 1 as const, taskId, createdAt: new Date().toISOString(), items: [], recompiles: [] }
  for (const it of items) {
    manifest.items.push(freezePackItem(knowledgeRoot, taskId, {
      fileName: it.fileName,
      kind: it.kind,
      name: it.kind,
      origin: `${it.kind}:${taskId}`,
      title: `${it.kind} task-${taskId}`,
      payload: it.payload,
    }))
  }
  writePackManifest(knowledgeRoot, taskId, manifest)
}

const JSONL_EXCERPT = [
  "# 执行 JSONL 关键事件摘录",
  "",
  "## exec exec-9f31（phase 1 · round 1）",
  "",
  "- [2026-10-14T01:00:20Z] do-task · error :: {\"error\":\"登录接口 500：cookie 未清\"}",
  "- [2026-10-14T01:01:30Z] do-task · bash_log :: {\"output\":\"git commit -m 'fix: 补 cookie 清理'\"}",
].join("\n")

const PHASE_REJECTIONS = [
  "# phase 打回记录（task aa03-1）",
  "",
  "## phase 2 round 1 打回（2026-10-14T02:00:00Z）",
  "",
  "- owner 反馈：验收环境 session 过期未清 cookie，登录态误判",
  "",
].join("\n")

/** LLM 草案 fixture（expected 独立于实现：五段 + symptom/source 全部手写给定）。 */
const DRAFT_JSON = JSON.stringify({
  cases: [
    {
      symptom: "登录接口 500：cookie 未清",
      severity: "blocker",
      tags: ["auth", "cookie"],
      source: "exec:exec-9f31",
      sections: {
        现场: "验收环境点登录，接口回 500，日志显示 cookie 未清。",
        诊断: "session 过期后旧 cookie 仍被携带，服务端解析失败。",
        根因: "登录态失效清理路径缺失。",
        修复: "补 cookie 清理并回归通过。",
        教训: "登录态改造必须同时给出失效清理路径。",
      },
    },
  ],
})

function makeService(overrides: Partial<CaseExtractDeps> = {}): { service: CaseExtractService; prompts: string[]; cards: any[] } {
  const prompts: string[] = []
  const cards: any[] = []
  const service = new CaseExtractService({
    db,
    root: knowledgeRoot,
    queue,
    extract: async (p) => { prompts.push(p); return DRAFT_JSON },
    announceCase: (ev) => { cards.push(ev) },
    ...overrides,
  })
  return { service, prompts, cards }
}

async function settle(expectStates: string): Promise<void> {
  for (let i = 0; i < 400 && queue.depth() > 0; i++) await new Promise((r) => setTimeout(r, 25))
  expect(queue.list().map(t => `${t.id}:${t.state}`).join(","), expectStates).not.toContain("failed")
}

function caseFiles(): string[] {
  const dir = path.join(knowledgeRoot, "wiki", "cases")
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith(".md")) : []
}

// ── 全链（票面第 1/2 行）：提取源→草案→case-archive 入队→编译进 cases/ ────

describe("判例自动提取→case-archive 入档全链（S1·票03）", () => {
  it("素材包含报错序列与打回轮次 ⇒ LLM 产五段草案 ⇒ enqueue case-archive（第八类）⇒ 唯一写闸落 cases/：P0 判例 schema + 五段正文 + source 指回 exec/task + LOG/INDEX/git commit", async () => {
    seedPack("aa03-1", [
      { fileName: "02-phase-rejections.md", kind: "phase-rejections", payload: PHASE_REJECTIONS },
      { fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: JSONL_EXCERPT },
    ])
    const { service } = makeService()

    const outcome = await service.extractAndEnqueue("aa03-1")
    expect(outcome.status).toBe("enqueued")
    expect(outcome.drafts).toBe(1)
    expect(outcome.queueTaskIds).toHaveLength(1)
    expect(outcome.queueTaskIds[0].startsWith(`${CASE_EXTRACT_QUEUE_ID_PREFIX}aa03-1-`)).toBe(true)

    // 队列面：第八类 opKind 单源贯通（GET /queue 自动透出面同值）
    const view = queue.get(outcome.queueTaskIds[0])!
    expect(view.opKind).toBe("case-archive")
    await settle("入档任务应 committed")
    expect(queue.get(outcome.queueTaskIds[0])!.state).toBe("committed")

    // 判例落盘 = 唯一写闸产物（cases/{YYYY-MM-DD}-{slug}.md）
    const files = caseFiles()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}-case-[a-z0-9][a-z0-9.-]*\.md$/)
    const written = fs.readFileSync(path.join(knowledgeRoot, "wiki", "cases", files[0]), "utf-8")

    // front-matter 判例 schema 沿用 P0（shared WikiCaseFrontmatterSchema 字段面逐字）
    expect(written).toContain("domain: cases")
    expect(written).toContain("symptom: 登录接口 500：cookie 未清")
    expect(written).toContain("severity: blocker")
    expect(written).toContain("occurrences: 1") // 新判例首见 = 1
    expect(written).toContain("status: open") // 宽松准入直接入档（红线3：先存后知，无审批态）
    expect(written).toContain("id: case-")
    // source 指回 exec/task（可定位准入闸在 compileCase 内已强制，此处断言落点值）
    expect(written).toMatch(/source: .*exec:exec-9f31/)
    // 五段骨架齐全且顺序=CBR 叙事序（现场/诊断/根因/修复/教训）
    for (const s of ["现场", "诊断", "根因", "修复", "教训"]) {
      expect(written).toContain(`## ${s}`)
    }
    expect(written).toContain("验收环境点登录")

    // 管线面与既判例通道一致：LOG 行（自动提取记源）+ INDEX Cases 节 + git commit
    const log = fs.readFileSync(path.join(knowledgeRoot, "wiki", "LOG.md"), "utf-8")
    expect(log).toContain(`compile | cases/${files[0]}`)
    expect(log).toContain("判例自动提取")
    const index = fs.readFileSync(path.join(knowledgeRoot, "wiki", "INDEX.md"), "utf-8")
    expect(index).toContain("登录接口 500：cookie 未清")
    const head = execFileSync("git", ["-C", path.join(knowledgeRoot, "wiki"), "rev-parse", "HEAD"], { encoding: "utf-8" }).trim()
    expect(head).toMatch(/^[0-9a-f]{40}$/)

    // DB/FTS 索引行（检索 API 的供给侧从此有粮——故事 12）
    const row = db.prepare("SELECT * FROM wiki_articles WHERE id LIKE 'case-%'").get() as Record<string, unknown>
    expect(row.domain).toBe("cases")
    expect(row.title).toBe("登录接口 500：cookie 未清")
  })

  it("提取 prompt 携带两类一手素材（报错序列行 + 打回理由原文）与 task/exec 指针面；草案要求五段 JSON 契约", async () => {
    seedPack("aa03-2", [
      { fileName: "02-phase-rejections.md", kind: "phase-rejections", payload: PHASE_REJECTIONS },
      { fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: JSONL_EXCERPT },
    ])
    const { service, prompts } = makeService({ extract: async (p) => { prompts.push(p); throw new Error("prompt-only：本例不真入档") } })
    // prompt 捕获后必失败收敛（EXTRACT_FAILED=skipped，永不抛穿——同时天然零悬队任务）
    expect(await service.extractAndEnqueue("aa03-2")).toEqual({ status: "skipped", reason: "EXTRACT_FAILED" })

    expect(prompts).toHaveLength(1)
    const p = prompts[0]
    expect(p).toContain("登录接口 500：cookie 未清") // JSONL 报错→修复序列素材
    expect(p).toContain("git commit -m 'fix: 补 cookie 清理'") // 修复关联行
    expect(p).toContain("验收环境 session 过期未清 cookie，登录态误判") // 打回理由（spec：理由入现场段）
    expect(p).toContain("aa03-2") // task 指针（source 可定位回指面）
    expect(p).toContain("现场") // 五段契约声明
    expect(p).toContain("教训")
    // 纯函数面：buildCaseExtractPrompt 与 service 内调用同形（单源）
    expect(buildCaseExtractPrompt({ taskId: "aa03-2", execExcerpt: JSONL_EXCERPT, rejections: PHASE_REJECTIONS })).toBe(p)
    expect(queue.list(), "EXTRACT_FAILED 路径零入队").toHaveLength(0)
  })
})

// ── occurrences 合并（票面第 3 行）：同症状命中既判例 → +1，正文 append-only 不改写 ──

describe("occurrences 合并（S1·票03 第3行：归一化+jaccard 自建判据）", () => {
  it("近义症状草案命中既判例 ⇒ occurrences+1（compileCase 可变面）：同文件同正文，不产新判例文件，LOG 记并档", async () => {
    seedPack("aa03-merge", [
      { fileName: "02-phase-rejections.md", kind: "phase-rejections", payload: PHASE_REJECTIONS },
      { fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: JSONL_EXCERPT },
    ])
    const { service, cards } = makeService()
    // 第一入：新判例（occurrences 1）
    await service.extractAndEnqueue("aa03-merge")
    await settle("首入应 committed")
    expect(caseFiles()).toHaveLength(1)
    const firstFile = caseFiles()[0]!
    const bytesAfterFirst = fs.readFileSync(path.join(knowledgeRoot, "wiki", "cases", firstFile), "utf-8")
    expect(cards).toHaveLength(1)
    expect(cards[0].data.occurrences).toBe(1)
    expect(cards[0].data.action).toBe("created")

    // 第二入：同素材包同草案 = 同症状（jaccard=1）⇒ 并档 +1
    await service.extractAndEnqueue("aa03-merge")
    await settle("并档应 committed")
    expect(caseFiles(), "同症状不产第二个文件").toHaveLength(1)
    const after = fs.readFileSync(path.join(knowledgeRoot, "wiki", "cases", firstFile), "utf-8")
    expect(after).toContain("occurrences: 2")
    // append-only：正文逐字不动（front-matter 可变面外全同）
    const stripOcc = (s: string) => s.replace(/occurrences: \d+/, "occurrences: N")
    expect(stripOcc(after)).toBe(stripOcc(bytesAfterFirst))
    // LOG 并档行 + 卡面 occurrences 递增（先存后知：卡反映终态）
    const log = fs.readFileSync(path.join(knowledgeRoot, "wiki", "LOG.md"), "utf-8")
    expect(log).toContain("判例并档 occurrence 2")
    expect(cards).toHaveLength(2)
    expect(cards[1].data.occurrences).toBe(2)
    expect(cards[1].data.action).toBe("merged")
    expect(cards[1].data.path).toBe(`cases/${firstFile}`)
  })

  it("无关症状草案 ⇒ 新判例文件（不误并档）", async () => {
    seedPack("aa03-new", [
      { fileName: "02-phase-rejections.md", kind: "phase-rejections", payload: PHASE_REJECTIONS },
      { fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: JSONL_EXCERPT },
    ])
    const { service } = makeService()
    await service.extractAndEnqueue("aa03-new")
    await settle("应 committed")
    // 异症状草案（token 全不交）从第二个任务进来
    seedPack("aa03-other", [
      { fileName: "02-phase-rejections.md", kind: "phase-rejections", payload: PHASE_REJECTIONS },
      { fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: JSONL_EXCERPT },
    ])
    const other = JSON.stringify({
      cases: [{
        symptom: "actuator 恢复状态把在跑执行报成 stale",
        severity: "major", tags: ["actuator"], source: "task:aa03-other",
        sections: { 现场: "仍在跑被报 stale", 诊断: "读 started_at", 根因: "长任务不更新", 修复: "改 updated_at", 教训: "选最后活动戳" },
      }],
    })
    const { service: s2 } = makeService({ extract: async () => other })
    await s2.extractAndEnqueue("aa03-other")
    await settle("应 committed")
    expect(caseFiles()).toHaveLength(2)
  })
})

// ── 负断言（票面第 6 行）：提取失败/无序列 ⇒ 零落盘零入队；不阻塞 done ──

describe("负断言：不产假判例（S1·票03 第6行）", () => {
  it("素材包不存在 ⇒ skipped PACK_NOT_FOUND，零入队", async () => {
    const { service, prompts } = makeService()
    const outcome = await service.extractAndEnqueue("ghost-task")
    expect(outcome).toEqual({ status: "skipped", reason: "PACK_NOT_FOUND" })
    expect(queue.list()).toHaveLength(0)
    expect(prompts).toHaveLength(0)
  })

  it("两源均诚实缺席（无打回轮次 + 摘录无关键事件）⇒ NO_SEQUENCE：零 LLM 零入队零文件", async () => {
    seedPack("aa03-clean", [
      { fileName: "02-phase-rejections.md", kind: "phase-rejections", payload: "# phase 打回记录（task aa03-clean）\n\n（无打回轮次——账本里 decision=rejected 为空）\n" },
      { fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: "## exec exec-1（phase 1 · round 1）\n\n- 摘录：（本次执行无关键事件——干净跑完）\n" },
    ])
    const { service, prompts, cards } = makeService()
    const outcome = await service.extractAndEnqueue("aa03-clean")
    expect(outcome).toEqual({ status: "skipped", reason: "NO_SEQUENCE" })
    expect(prompts, "无序列不调 LLM").toHaveLength(0)
    expect(queue.list()).toHaveLength(0)
    expect(cards).toHaveLength(0)
    expect(caseFiles()).toHaveLength(0)
  })

  it("LLM 抛错 ⇒ EXTRACT_FAILED 零入队；LLM 空串（离线闸形态）⇒ EXTRACT_EMPTY 零入队", async () => {
    seedPack("aa03-fail", [
      { fileName: "02-phase-rejections.md", kind: "phase-rejections", payload: PHASE_REJECTIONS },
      { fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: JSONL_EXCERPT },
    ])
    const { service: s1 } = makeService({ extract: async () => { throw new Error("provider down") } })
    expect(await s1.extractAndEnqueue("aa03-fail")).toEqual({ status: "skipped", reason: "EXTRACT_FAILED" })

    const { service: s2 } = makeService({ extract: async () => "" })
    expect(await s2.extractAndEnqueue("aa03-fail")).toEqual({ status: "skipped", reason: "EXTRACT_EMPTY" })

    expect(queue.list()).toHaveLength(0)
    expect(caseFiles()).toHaveLength(0)
  })

  it("LLM 坏 JSON / 缺段草案 ⇒ 全弃：NO_VALID_DRAFT 零入队（五段齐是入档前置，不靠 compileCase 兜底）", async () => {
    seedPack("aa03-bad", [
      { fileName: "02-phase-rejections.md", kind: "phase-rejections", payload: PHASE_REJECTIONS },
      { fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: JSONL_EXCERPT },
    ])
    const { service: s1 } = makeService({ extract: async () => "这不是 JSON {{{" })
    expect(await s1.extractAndEnqueue("aa03-bad")).toEqual({ status: "skipped", reason: "NO_VALID_DRAFT" })

    const missingLesson = JSON.stringify({ cases: [{ symptom: "s", severity: "minor", tags: [], source: "task:aa03-bad", sections: { 现场: "a", 诊断: "b", 根因: "c", 修复: "d" } }] })
    const { service: s2 } = makeService({ extract: async () => missingLesson })
    expect(await s2.extractAndEnqueue("aa03-bad")).toEqual({ status: "skipped", reason: "NO_VALID_DRAFT" })

    expect(queue.list()).toHaveLength(0)
    expect(caseFiles()).toHaveLength(0)
  })

  it("草案 source 不可定位 ⇒ 服务端兜 task:{id}（可定位准入不豁免，红线2 唯一写闸仍过闸）", async () => {
    seedPack("aa03-src", [
      { fileName: "02-phase-rejections.md", kind: "phase-rejections", payload: PHASE_REJECTIONS },
      { fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: JSONL_EXCERPT },
    ])
    const sloppy = JSON.stringify({ cases: [{ symptom: "pnpm 重建后旧 dist 残留", severity: "minor", tags: [], source: "听说的", sections: { 现场: "a", 诊断: "b", 根因: "c", 修复: "d", 教训: "e" } }] })
    const { service } = makeService({ extract: async () => sloppy })
    const outcome = await service.extractAndEnqueue("aa03-src")
    expect(outcome.status).toBe("enqueued")
    await settle("应 committed")
    const written = fs.readFileSync(path.join(knowledgeRoot, "wiki", "cases", caseFiles()[0]!), "utf-8")
    expect(written).toMatch(/source: .*task:aa03-src/)
  })

  it("announce 炸（无知识中心会话同律）⇒ 判例已 committed 不受损（先存后知：通知失败不回滚不入档失败）", async () => {
    seedPack("aa03-ann", [
      { fileName: "02-phase-rejections.md", kind: "phase-rejections", payload: PHASE_REJECTIONS },
      { fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: JSONL_EXCERPT },
    ])
    const { service } = makeService({ announceCase: () => { throw new Error("session exploded") } })
    const outcome = await service.extractAndEnqueue("aa03-ann")
    expect(outcome.status).toBe("enqueued")
    await settle("应 committed（announce 吞 stderr）")
    expect(queue.get(outcome.queueTaskIds![0])!.state).toBe("committed")
    expect(caseFiles()).toHaveLength(1)
  })
})

// ── 退役（票面第 4 行：superseded 经 case-archive 队列通道；红线2 无直写旁路）────

describe("判例退役 superseded（S1·票03 第4行）", () => {
  async function seedOpenCase(taskId: string): Promise<{ caseId: string; file: string }> {
    seedPack(taskId, [
      { fileName: "02-phase-rejections.md", kind: "phase-rejections", payload: PHASE_REJECTIONS },
      { fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: JSONL_EXCERPT },
    ])
    const { service } = makeService()
    const outcome = await service.extractAndEnqueue(taskId)
    await settle("入档应 committed")
    const file = caseFiles()[0]!
    const written = fs.readFileSync(path.join(knowledgeRoot, "wiki", "cases", file), "utf-8")
    const caseId = /^id: (\S+)$/m.exec(written)![1]!
    return { caseId, file }
  }

  it("retireCase ⇒ 同 opKind=case-archive 入队 ⇒ status: superseded，正文/固定字段逐字不动（append-only 可变面），LOG 退役行 + 卡终态（action=retired）", async () => {
    const { caseId, file } = await seedOpenCase("aa03-ret")
    const before = fs.readFileSync(path.join(knowledgeRoot, "wiki", "cases", file), "utf-8")
    const { service, cards } = makeService()

    const ack = service.retireCase(caseId)
    expect(ack.queueTaskId.startsWith("car-")).toBe(true)
    expect(queue.get(ack.queueTaskId)!.opKind).toBe("case-archive")
    await settle("退役应 committed")

    const after = fs.readFileSync(path.join(knowledgeRoot, "wiki", "cases", file), "utf-8")
    expect(after).toContain("status: superseded")
    // append-only 面：除 status 行外逐字不变
    expect(after.replace("status: superseded", "status: open")).toBe(before)
    const log = fs.readFileSync(path.join(knowledgeRoot, "wiki", "LOG.md"), "utf-8")
    expect(log).toContain("判例退役 superseded")

    const termCard = cards[cards.length - 1]
    expect(termCard.kind).toBe("case")
    expect(termCard.data.status).toBe("superseded")
    expect(termCard.data.action).toBe("retired")
  })

  it("未知 caseId ⇒ CASE_NOT_FOUND 响亮拒绝（同步校验段零入队）；已 superseded ⇒ 409 形态拒绝（不叠退役）", () => {
    const { service } = makeService()
    expect(() => service.retireCase("case-nope")).toThrow(/^CASE_NOT_FOUND/)
    expect(queue.list()).toHaveLength(0)
  })

  it("已退役判例再退役 ⇒ CASE_ALREADY_SUPERSEDED 零入队", async () => {
    const { caseId } = await seedOpenCase("aa03-ret2")
    const { service } = makeService()
    service.retireCase(caseId)
    await settle("首退应 committed")
    expect(() => service.retireCase(caseId)).toThrow(/^CASE_ALREADY_SUPERSEDED/)
  })
})

// ── 归档 hook 链接位（spec 链序⑤：入队编译后、归档卡前；失败不阻塞 done）──────

describe("ArchiveIngestService extractCases 接位（S1·票03 链序/失败语义）", () => {
  async function runIngestHook(taskId: string, extractCases: (id: string) => Promise<unknown>) {
    // 最小投喂链 fixture：包先落盘（幂等闸 deduped 位）——直接种 manifest 走 deduped? 不行，
    // deduped 跳过⑤。用真 ingest 链太重复票02；此处单测「链序+失败吞」语义：
    // 以 ArchiveIngestService 的 deps 直调（summarize/compilePack 假面）。
    const { ArchiveIngestService } = await import("../../tasks/archive-ingest-service")
    const { TaskHomeService } = await import("../../tasks/task-home-service")
    const { RawIngestService } = await import("../raw")
    db.prepare(`
      INSERT INTO tasks (id, org, name, status, task_spec, authoring_resources, resources, skills, project_ids, version, created_at, updated_at)
      VALUES (?, 'aa03', 'hook 任务', 'archiving', '{"format":"v4","goal":"g","ac":[],"phases":[],"decisions":[]}', '[]', '[]', '[]', '[]', 1, datetime('now'), datetime('now'))
    `).run(taskId)
    const q = new CompileQueue()
    const svc = new ArchiveIngestService({
      db,
      taskHomeService: new TaskHomeService(path.join(tmpRoot, "homes")),
      rawIngest: new RawIngestService({ root: knowledgeRoot }),
      queue: q,
      compilePack: async () => undefined,
      summarize: async () => "# 总结\n",
      extractCases,
    })
    return { svc, q }
  }

  it("归档投喂链第⑤步调 extractCases(taskId) 一次，入队编译之后；投喂回执 status=ingested 不受提取影响", async () => {
    const calls: string[] = []
    const { svc, q } = await runIngestHook("aa03-hook1", async (id) => { calls.push(id); return { status: "enqueued" } })
    const outcome = await svc.ingestTask("aa03-hook1")
    expect(outcome.status).toBe("ingested")
    expect(calls).toEqual(["aa03-hook1"])
    // 链序面：archive-compile（④）先于 case 提取的队内观察（⑤ await 时④已入队）
    expect(q.get(`arc-aa03-hook1`)?.opKind).toBe("archive-compile")
  })

  it("extractCases 抛错 ⇒ 吞进 stderr，投喂回执照常 ingested（失败不阻塞 done，红线3/票面第6行）", async () => {
    const { svc } = await runIngestHook("aa03-hook2", async () => { throw new Error("boom") })
    await expect(svc.ingestTask("aa03-hook2")).resolves.toMatchObject({ status: "ingested" })
  })

  it("幂等 deduped 路径（包已冻结）不再提取——同任务重归档零重复判例", async () => {
    seedPack("aa03-hook3", [
      { fileName: "02-phase-rejections.md", kind: "phase-rejections", payload: PHASE_REJECTIONS },
      { fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: JSONL_EXCERPT },
    ])
    // 补总结件进包（deduped 判定面）+ manifest 幂等位
    const { svc } = await runIngestHook("aa03-hook3", async () => { throw new Error("must-not-be-called") })
    const outcome = await svc.ingestTask("aa03-hook3")
    expect(outcome.status).toBe("deduped")
  })
})

// ── 离线闸（生产适配器只验闸断言；spec Testing Decisions「生产适配器另验离线闸」）──

describe("生产草案适配器：离线闸恒空串 ⇒ EXTRACT_EMPTY 零入队（不产假判例）", () => {
  it("OCTOPUS_KNOWLEDGE_LLM_DISABLED=1 ⇒ createProductionCaseExtractor 恒空 ⇒ skipped，队列空、cases 空", async () => {
    const prev = process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED
    process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED = "1"
    try {
      const { createProductionCaseExtractor } = await import("../case-extract-llm")
      const extractor = createProductionCaseExtractor()
      await expect(extractor("任意 prompt")).resolves.toBe("")

      seedPack("aa03-offline", [
        { fileName: "02-phase-rejections.md", kind: "phase-rejections", payload: PHASE_REJECTIONS },
        { fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: JSONL_EXCERPT },
      ])
      const { service } = makeService({ extract: extractor })
      const outcome = await service.extractAndEnqueue("aa03-offline")
      expect(outcome).toEqual({ status: "skipped", reason: "EXTRACT_EMPTY" })
      expect(queue.list()).toHaveLength(0)
      expect(caseFiles()).toHaveLength(0)
    } finally {
      if (prev === undefined) delete process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED
      else process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED = prev
    }
  })
})
