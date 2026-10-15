import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import type { KcCardEvent } from "@octopus/shared"
import { RawIngestService } from "../raw"
import { CuratorTaskService } from "../wiki/curator-task"
import { CuratorError, type CuratorCompileResult } from "../wiki/curator"
import { SessionCurationService } from "../session-curation"
import type { QueueTaskView, WriteQueue, WriteOpKind } from "../wiki/compile-queue"

/**
 * 票10 · 投喂泛化服务层（S1）。
 *
 * 链路真形：真 RawIngestService（tmpdir 知识根覆盖缝）+ 真 CuratorTaskService
 * （注入 spy WriteQueue——opKind 可观测，红线1「零新 kind / 无第二套编译路径」
 * 的负断言面）+ announce/trigger seam 捕获。
 * expected 真相源：票面（复用 ingest-compile 队列 / Lane A 回流原会话）+
 * BackfillService origin 信道纪律逐字（chat:〈session〉）+ 手构编译结果字面量。
 * 时间纪律：钉死时钟，零 sleep；队列「轮到才跑」用显式 drain() 步进（红线6 同律）。
 */

const NOW = new Date("2026-10-15T09:00:00Z")
const now = () => new Date(NOW.getTime())
const SESSION = "main-sess-1"

// 手构已知编译产物（独立真相源，非被测代码推导）
const COMPILE_OK: CuratorCompileResult = {
  rawPath: "raw/inbox/2026-10-15-article.md",
  rawHash: "f".repeat(64),
  rawTitle: "知识策展样例",
  touched: [
    { path: "concepts/kc-sample.md", type: "concept", created: true },
    { path: "sources/2026-10-15-article.md", type: "source" },
  ],
  created: 1,
  updated: 1,
  contradictions: 0,
  findingIds: [],
  commit: "ab12cd34ef56ab78cd90ef12ab34cd56ef78ab90",
  changed: true,
  deduped: false,
  warnings: [],
}

/** spy 写队列：入队记录 opKind/taskId 并**存而不跑**；drain() 显式步进执行体。 */
class SpyQueue implements WriteQueue {
  ops: Array<{ opKind: string; taskId?: string }> = []
  private readonly fns: Array<() => Promise<unknown>> = []
  enqueue(opKind: WriteOpKind, fn: () => Promise<unknown>, opts?: { taskId?: string; label?: string }): QueueTaskView {
    this.ops.push({ opKind, taskId: opts?.taskId })
    this.fns.push(fn)
    return {
      id: opts?.taskId ?? "wq-0001", opKind, label: opts?.label ?? "", state: "queued",
      position: 1, queuedAt: NOW.toISOString(),
    }
  }
  async drain(): Promise<void> {
    for (;;) {
      const fn = this.fns.shift()
      if (!fn) return
      try { await fn() } catch { /* 队列面失败已由任务记录态断言 */ }
    }
  }
  get(): QueueTaskView | undefined { return undefined }
  list(): QueueTaskView[] { return [] }
  depth(): number { return 0 }
}

/** submit 同步校验 raw 在盘——非 curate 直驱的用例先手撒一个 raw 冻结件。 */
function seedRaw(rel: string, content = "---\ntitle: 手播件\n---\n\n正文。"): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, "utf-8")
}

let root: string
let tmpDir: string
let announces: Array<{ sessionId: string; header: string; events: KcCardEvent[] }>
let lastTriggerCtx: { sessionId?: string } | undefined
let curation: SessionCurationService
let curatorTasks: CuratorTaskService
let spy: SpyQueue

function wire(opts: { compileRun?: (rawPath: string) => Promise<CuratorCompileResult>; announceThrows?: boolean } = {}) {
  spy = new SpyQueue()
  curatorTasks = new CuratorTaskService({
    root, // tmpdir 知识根覆盖缝（绝不打真默认库/真知识根——phase-brief 纪律）
    queue: spy,
    now,
    run: opts.compileRun ?? (async () => COMPILE_OK),
  })
  curation = new SessionCurationService({
    raw: new RawIngestService({ root, now }),
    now,
    trigger: (rawPath, ctx) => {
      lastTriggerCtx = ctx
      const t = curatorTasks.submit(rawPath, ctx)
      return { taskId: t.id, status: t.status }
    },
    announce: (sessionId, header, events) => {
      if (opts.announceThrows) throw new Error("db 炸")
      announces.push({ sessionId, header, events })
      return { posted: true }
    },
    positionOf: () => 1,
  })
  curatorTasks.attachSettledListener(rec => curation.onCompileSettled(rec))
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-session-curation-"))
  root = path.join(tmpDir, "knowledge")
  fs.mkdirSync(root, { recursive: true })
  announces = []
  lastTriggerCtx = undefined
})

afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function stubHtmlFetch(html = "<html><head><title>知识策展样例</title></head><body><p>正文内容段落。</p></body></html>") {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    body: null,
    text: async () => html,
  })))
}

function rawFiles(): string[] {
  const inbox = path.join(root, "raw", "inbox")
  return fs.existsSync(inbox) ? fs.readdirSync(inbox) : []
}

describe("curate：url 形态——复用既有抓取/编译链 + 卡片回流发起会话", () => {
  it("抓取落 raw（真 RawIngestService 穿打，零第二套抓取）→ trigger 携会话上下文 → 入队 opKind=ingest-compile（零新 kind）→ announce 抓取卡+diff 卡", async () => {
    stubHtmlFetch()
    wire()

    const receipt = await curation.curate({ sessionId: SESSION, mode: "url", url: "https://example.com/article" })

    // 落盘真相：raw/inbox 恰 1 个冻结件
    expect(rawFiles()).toHaveLength(1)
    expect(receipt.raw.path).toMatch(/^raw\/inbox\/.+\.md$/)
    expect(receipt.compileTask?.status).toBe("queued")

    // 复用面负断言：唯一一次入队，opKind 恒 ingest-compile（红线1——无第二套编译路径、零新 kind）
    expect(spy.ops).toHaveLength(1)
    expect(spy.ops[0].opKind).toBe("ingest-compile")
    // 会话上下文流入投喂链（BackfillService sessionId 一等参数先例）
    expect(lastTriggerCtx).toEqual({ sessionId: SESSION })

    // 卡片回流：恰一次 announce，目标 = 发起会话，两张卡（抓取卡 + diff 卡）
    expect(announces).toHaveLength(1)
    expect(announces[0].sessionId).toBe(SESSION)
    const [ing, dif] = announces[0].events
    // 抓取卡：Lane A 沉淀形态 id 锚 hash 前 8 位（协议 id 约定逐字）
    expect(ing.id).toBe(`ing-${receipt.raw.hash.slice(0, 8)}`)
    expect(ing.kind).toBe("ingest")
    expect(ing.data).toMatchObject({
      status: "done",
      rawPath: receipt.raw.path,
      hash: receipt.raw.hash,
      compile: { taskId: receipt.compileTask?.taskId, status: "queued", position: 1 },
    })
    // diff 卡：dif-<taskId> 队列快照形态（announcePack 链尾回填先例同形）
    expect(dif.id).toBe(`dif-${receipt.compileTask?.taskId}`)
    expect(dif.kind).toBe("compile-diff")
    expect(dif.data).toMatchObject({ status: "queued", rawPath: receipt.raw.path, touched: [] })
  })

  it("编译终态 committed ⇒ drain 后同 id 重发终态 diff 卡（commit/触及页/ftsOk 回填；判例终态卡同址重发先例）", async () => {
    stubHtmlFetch()
    wire()

    const receipt = await curation.curate({ sessionId: SESSION, mode: "text", text: "一段值得沉淀的长文本素材。" })
    await spy.drain()

    expect(announces).toHaveLength(2)
    const settled = announces[1].events
    expect(settled).toHaveLength(1)
    expect(settled[0].id).toBe(`dif-${receipt.compileTask?.taskId}`) // 同 id 重发
    expect(settled[0].kind).toBe("compile-diff")
    expect(settled[0].data).toMatchObject({
      status: "committed",
      commit: COMPILE_OK.commit,
      touched: COMPILE_OK.touched,
      created: 1,
      updated: 1,
      contradictions: 0,
      ftsOk: true,
    })
    expect(announces[1].header).toContain("已提交")
  })

  it("编译终态 failed ⇒ 错误码显形终态卡（不伪造 committed）", async () => {
    stubHtmlFetch()
    wire({
      compileRun: async () => {
        throw new CuratorError("LLM_UNAVAILABLE", "策展 LLM 不可达", 503)
      },
    })

    const receipt = await curation.curate({ sessionId: SESSION, mode: "text", text: "素材正文。" })
    await spy.drain()
    const settled = announces[announces.length - 1].events
    expect(settled[0].id).toBe(`dif-${receipt.compileTask?.taskId}`)
    expect(settled[0].data).toMatchObject({
      status: "failed",
      error: { code: "LLM_UNAVAILABLE" },
    })
  })

  it("无会话上下文的编译任务（知识中心/归档投喂本体）⇒ settled 零回流（Lane B 既有形态零回归）", async () => {
    wire()
    seedRaw(COMPILE_OK.rawPath)
    curatorTasks.submit(COMPILE_OK.rawPath) // 不经 curate——无 sessionId
    await spy.drain()
    expect(announces).toHaveLength(0)
  })
})

describe("curate：text 形态 origin 信道 + 输入校验透传", () => {
  it("text 模式 ⇒ raw front-matter origin=chat:〈sessionId〉（Backfill 信道纪律逐字）", async () => {
    wire()
    const receipt = await curation.curate({ sessionId: SESSION, mode: "text", text: "值得编进 wiki 的正文。", title: "沉淀样例" })

    const file = path.join(root, receipt.raw.path)
    const text = fs.readFileSync(file, "utf-8")
    expect(text).toContain(`origin: "chat:${SESSION}"`)
  })

  it("url 非法形态 ⇒ IngestError 原样上抛（错误码面交调用方映射，零吞错）", async () => {
    wire()
    await expect(curation.curate({ sessionId: SESSION, mode: "url", url: "ftp://example.com/x" }))
      .rejects.toMatchObject({ code: "INVALID_PARAM", status: 400 })
  })

  it("text 空文 ⇒ INVALID_PARAM 400（票02 冻结契约原样复用）", async () => {
    wire()
    await expect(curation.curate({ sessionId: SESSION, mode: "text", text: "   " }))
      .rejects.toMatchObject({ code: "INVALID_PARAM" })
    expect(spy.ops).toHaveLength(0) // 失败零入队
  })

  it("回流失败（announce 抛）⇒ curate 不炸、receipt.cardsPosted=false 诚实显形（报对话同律：失败不吞投喂成果）", async () => {
    wire({ announceThrows: true })
    const receipt = await curation.curate({ sessionId: SESSION, mode: "text", text: "素材正文。" })
    expect(receipt.compileTask).toBeTruthy() // 投喂/编译成果仍在
    expect(receipt.cardsPosted).toBe(false)
  })
})

describe("CuratorTaskService ADDITIVE（票10）", () => {
  it("submit 会话上下文记入任务记录（GET 面可溯源）", () => {
    wire()
    seedRaw(COMPILE_OK.rawPath)
    const rec = curatorTasks.submit(COMPILE_OK.rawPath, { sessionId: SESSION })
    expect(curatorTasks.get(rec.id)?.sessionId).toBe(SESSION)
  })

  it("既有调用形态 submit(rawPath) 零改动兼容（ADDITIVE 契约：可选参数字面不破坏 CompileTrigger 单参签名）", () => {
    wire()
    seedRaw(COMPILE_OK.rawPath)
    const trigger: (rawPath: string) => { taskId: string; status: string } = rawPath => {
      const t = curatorTasks.submit(rawPath)
      return { taskId: t.id, status: t.status }
    }
    const ack = trigger(COMPILE_OK.rawPath)
    expect(ack.taskId).toMatch(/^crt-/)
    expect(curatorTasks.get(ack.taskId)?.sessionId).toBeUndefined()
  })
})
